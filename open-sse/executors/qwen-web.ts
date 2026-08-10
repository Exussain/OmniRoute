/**
 * QwenWebExecutor — Alibaba Tongyi Qwen Chat via chat.qwen.ai (v2 API)
 *
 * Routes requests through Qwen's consumer chat API. The legacy v1 endpoint
 * (`/api/chat/completions`) was retired upstream in 2026 and now answers 504
 * HTML from Alibaba's gateway for every request, regardless of credentials
 * (#3288 / discussion #2768). The current contract is a two-step v2 flow:
 *
 *   1. POST /api/v2/chats/new                  → create a chat, returns chat_id
 *   2. POST /api/v2/chat/completions?chat_id=  → phase-based SSE stream
 *
 * The v2 endpoints sit behind Alibaba's "baxia" WAF, which requires the full
 * browser cookie jar from a real logged-in session (cna, ssxmod_itna,
 * ssxmod_itna2, token, ...). We therefore replay the captured/pasted Cookie
 * header verbatim plus the bearer token, mirroring how grok-web replays its
 * anti-bot cookies.
 *
 * SSE chunks carry `choices[0].delta` with a `phase` field: `think` /
 * `thinking_summary` map to reasoning, `answer` (or a null phase) carries the
 * assistant content.
 *
 * Reference implementations: gpt4free `g4f/Provider/Qwen.py`,
 * Chat2API `proxy/adapters/qwen-ai.ts`.
 *
 * Auth: full Cookie header from chat.qwen.ai + bearer token (localStorage
 *       `token`, also mirrored to a `token` cookie).
 * Format: OpenAI-compatible (translated from Qwen's phase protocol).
 */
import { BaseExecutor, type ExecuteInput } from "./base.ts";
import { makeExecutorErrorResult as makeErrorResult } from "../utils/error.ts";
import { prepareToolMessages, buildToolAwareResult } from "../translator/webTools.ts";
import {
  buildQwenCookieHeader,
  extractQwenRequestHeader,
  extractQwenToken,
} from "@/lib/providers/webCookieAuth";

const BASE_URL = "https://chat.qwen.ai";
const CHATS_NEW_URL = `${BASE_URL}/api/v2/chats/new`;
const CHAT_COMPLETIONS_URL = `${BASE_URL}/api/v2/chat/completions`;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";

// Anti-bot headers the v2 endpoint expects. `bx-umidtoken` is normally minted
// per-session from sg-wum.alibaba.com; a captured value travels with the cookie
// jar, but we also send a static fallback so the header is always present.
const BX_VERSION = "2.5.37";

// Qwen SPA version — required by the v2 chat completion endpoint. Without this
// header the upstream returns HTTP 200 with `{"success":false,"data":{"code":"Bad_Request"}}`
// for every completion request, even with a valid session. The version string is
// the SPA build identifier shipped in the React client's `version` request header.
// Pinned from a live capture (2026-07); bump if Qwen ships a breaking change.
const QWEN_SPA_VERSION = "0.2.83";

const MODEL_ALIASES: Record<string, string> = {
  // Legacy OmniRoute ids → current upstream catalog (GET /api/models).
  "qwen-plus": "qwen3.7-plus",
  "qwen-max": "qwen3.7-max",
  "qwen-turbo": "qwen3.6-plus",
  "qwen3-plus": "qwen3.7-plus",
  "qwen3-max": "qwen3.7-max",
  "qwen3-flash": "qwen3.6-plus",
  // Note: `qwen3-coder-plus` is a real upstream model id (Qwen3-Coder) and
  // must NOT be aliased — the previous `"qwen3-coder-plus": "qwen3.7-max"`
  // entry silently rewrote valid coder requests to the wrong model.
  "qwen3-coder-flash": "qwen3.6-plus",
  qwen: "qwen3.7-max",
  qwen3: "qwen3.7-max",
};

const DEFAULT_MODEL = "qwen3.7-max";
const REQUIRED_THINKING_MODELS = new Set(["qwen3.8-max-preview"]);

function mapModel(modelId: string): string {
  return MODEL_ALIASES[modelId] || modelId;
}

function uuid(): string {
  return crypto.randomUUID();
}

/** Detect Alibaba's WAF / retired-v1 gateway page so we never surface raw HTML. */
function isWafResponse(status: number, contentType: string, bodyText: string): boolean {
  if (contentType.includes("text/html")) return true;
  if (status === 504) return true;
  return /aliyun_waf|baxia|<html/i.test(bodyText);
}

const WAF_ERROR_MESSAGE =
  "Qwen session expired or blocked by Alibaba's WAF. Re-login at https://chat.qwen.ai and " +
  "paste a fresh full Cookie header (must include cna, ssxmod_itna and token) — a bearer token " +
  "alone is no longer accepted by the v2 endpoint.";

export class QwenWebExecutor extends BaseExecutor {
  constructor() {
    super("qwen-web", { id: "qwen-web", baseUrl: BASE_URL });
  }

  private buildApiHeaders(
    token: string,
    cookieHeader: string,
    chatId?: string,
    rawCredential = ""
  ): Record<string, string> {
    const browserHeader = (name: string, fallback: string) =>
      extractQwenRequestHeader(rawCredential, name) || fallback;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: browserHeader("accept", "application/json"),
      "User-Agent": browserHeader("user-agent", USER_AGENT),
      Origin: BASE_URL,
      Referer: chatId ? `${BASE_URL}/c/${chatId}` : `${BASE_URL}/`,
      source: "web",
      version: browserHeader("version", QWEN_SPA_VERSION),
      "x-request-id": uuid(),
      "bx-v": browserHeader("bx-v", BX_VERSION),
    };
    const bxUa = extractQwenRequestHeader(rawCredential, "bx-ua");
    const bxUmidtoken = extractQwenRequestHeader(rawCredential, "bx-umidtoken");
    const timezone = extractQwenRequestHeader(rawCredential, "timezone");
    if (bxUa) headers["bx-ua"] = bxUa;
    if (bxUmidtoken) headers["bx-umidtoken"] = bxUmidtoken;
    if (timezone) headers.timezone = timezone;
    const authorization = extractQwenRequestHeader(rawCredential, "authorization");
    if (authorization) headers.Authorization = authorization;
    else if (token && !cookieHeader) headers.Authorization = `Bearer ${token}`;
    for (const name of [
      "accept-language",
      "sec-ch-ua",
      "sec-ch-ua-mobile",
      "sec-ch-ua-platform",
      "sec-fetch-dest",
      "sec-fetch-mode",
      "sec-fetch-site",
      "x-accel-buffering",
    ]) {
      const value = extractQwenRequestHeader(rawCredential, name);
      if (value) headers[name] = value;
    }
    if (cookieHeader) headers["Cookie"] = cookieHeader;
    return headers;
  }

  async execute(input: ExecuteInput) {
    const { body, credentials, signal, stream: wantStream } = input;
    const bodyObj = (body || {}) as Record<string, unknown>;

    const rawCred = String(credentials?.apiKey ?? "").trim();
    const cookieHeader =
      extractQwenRequestHeader(rawCred, "cookie") || buildQwenCookieHeader(rawCred);
    let token = extractQwenToken(rawCred);
    if (!token && credentials?.accessToken) token = String(credentials.accessToken).trim();

    const messages = (bodyObj.messages as Array<{ role: string; content: string }>) || [];
    const requestedModel = (bodyObj.model as string) || DEFAULT_MODEL;
    const modelId = mapModel(requestedModel);

    const { hasTools, requestedTools, effectiveMessages } = prepareToolMessages(bodyObj, messages);

    // Qwen Web is single-turn: fold the conversation into one user prompt.
    const prompt = this.foldMessages(effectiveMessages);

    // ── Step 1: create a chat ────────────────────────────────────────────────
    let chatId: string;
    try {
      const newChatRes = await fetch(CHATS_NEW_URL, {
        method: "POST",
        headers: this.buildApiHeaders(token, cookieHeader, undefined, rawCred),
        body: JSON.stringify({
          title: "New Chat",
          models: [modelId],
          chat_mode: "normal",
          chat_type: "t2t",
          timestamp: Date.now(),
        }),
        signal,
      });

      const ct = newChatRes.headers.get("content-type") || "";
      if (!newChatRes.ok || ct.includes("text/html")) {
        const text = await newChatRes.text().catch(() => "");
        if (isWafResponse(newChatRes.status, ct, text)) {
          return makeErrorResult(401, WAF_ERROR_MESSAGE, body, CHATS_NEW_URL);
        }
        return makeErrorResult(
          newChatRes.status || 502,
          `Qwen create-chat failed: ${text.slice(0, 300)}`,
          body,
          CHATS_NEW_URL
        );
      }

      const data = (await newChatRes.json()) as { data?: { id?: string } };
      chatId = data?.data?.id ?? "";
      if (!chatId) {
        return makeErrorResult(502, "Qwen create-chat returned no chat id", body, CHATS_NEW_URL);
      }
    } catch (err) {
      return makeErrorResult(
        502,
        `Qwen create-chat error: ${err instanceof Error ? err.message : "unknown"}`,
        body,
        CHATS_NEW_URL
      );
    }

    // ── Step 2: send the message ─────────────────────────────────────────────
    const completionUrl = `${CHAT_COMPLETIONS_URL}?chat_id=${chatId}`;
    const msgPayload = this.buildMessagePayload(chatId, modelId, prompt, requestedModel);

    let upstream: Response;
    try {
      upstream = await fetch(completionUrl, {
        method: "POST",
        headers: this.buildApiHeaders(token, cookieHeader, chatId, rawCred),
        body: JSON.stringify(msgPayload),
        signal,
      });
    } catch (err) {
      return makeErrorResult(
        502,
        `Qwen completion fetch failed: ${err instanceof Error ? err.message : "unknown"}`,
        body,
        completionUrl
      );
    }

    const ct = upstream.headers.get("content-type") || "";
    if (!upstream.ok || ct.includes("text/html")) {
      const errText = await upstream.text().catch(() => "");
      if (isWafResponse(upstream.status, ct, errText)) {
        return makeErrorResult(401, WAF_ERROR_MESSAGE, body, completionUrl);
      }
      return makeErrorResult(
        upstream.status || 502,
        `Qwen error: ${errText.slice(0, 300)}`,
        body,
        completionUrl
      );
    }

    if (!wantStream) {
      let content: string;
      try {
        ({ content } = await this.collectStream(upstream));
      } catch (err) {
        return makeErrorResult(
          502,
          err instanceof Error ? err.message : "Qwen returned an invalid response",
          body,
          completionUrl
        );
      }
      const finalText = content;

      if (hasTools) {
        const {
          content: toolContent,
          toolCalls,
          finishReason,
        } = buildToolAwareResult(finalText, requestedTools, "qwen");
        const message: Record<string, unknown> = { role: "assistant", content: toolContent };
        if (toolCalls) {
          message.tool_calls = toolCalls;
          message.content = null;
        }
        return this.jsonResponse(modelId, message, finishReason, completionUrl, msgPayload);
      }

      return this.jsonResponse(
        modelId,
        { role: "assistant", content: finalText },
        "stop",
        completionUrl,
        msgPayload
      );
    }

    // Streaming: transform Qwen phase SSE → OpenAI chat.completion.chunk SSE.
    const stream = this.buildClientStream(upstream, modelId, hasTools, requestedTools, signal);
    return {
      response: new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      }),
      url: completionUrl,
      headers: this.buildApiHeaders(token, cookieHeader, chatId, rawCred),
      transformedBody: msgPayload,
    };
  }

  /** Flatten OpenAI-style content (string | Array<{type,text}>) into plain text.
   *  A bare String() on an array of content parts yields "[object Object]" — the
   *  serialization bug reported on the support mesh. */
  private contentToText(content: unknown): string {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .map((part) => {
          if (typeof part === "string") return part;
          if (part && typeof part === "object") {
            const p = part as { type?: unknown; text?: unknown };
            if (typeof p.text === "string") return p.text;
          }
          return "";
        })
        .filter(Boolean)
        .join("\n");
    }
    return content == null ? "" : String(content);
  }

  private foldMessages(messages: Array<{ role: string; content: unknown }>): string {
    let systemContent = "";
    let userContent = "";
    for (const m of messages) {
      const text = this.contentToText(m.content);
      if (m.role === "system") {
        systemContent += (systemContent ? "\n\n" : "") + text;
      } else if (m.role === "user") {
        userContent = text;
      }
    }
    return systemContent ? `${systemContent}\n\nUser: ${userContent}` : userContent;
  }

  private buildMessagePayload(
    chatId: string,
    modelId: string,
    prompt: string,
    requestedModel: string
  ): Record<string, unknown> {
    const fid = uuid();
    const enableThinking =
      REQUIRED_THINKING_MODELS.has(modelId) || /think|reason|r1/i.test(requestedModel);
    const featureConfig: Record<string, unknown> = {
      thinking_enabled: enableThinking,
      output_schema: "phase",
      auto_thinking: enableThinking,
      research_mode: "normal",
      auto_search: false,
    };
    return {
      stream: true,
      incremental_output: true,
      chat_id: chatId,
      chat_mode: "normal",
      model: modelId,
      parent_id: null,
      messages: [
        {
          fid,
          parentId: null,
          childrenIds: [],
          role: "user",
          content: prompt,
          user_action: "chat",
          files: [],
          timestamp: Math.floor(Date.now() / 1000),
          models: [modelId],
          chat_type: "t2t",
          feature_config: featureConfig,
          sub_chat_type: "t2t",
          parent_id: null,
        },
      ],
    };
  }

  /** Read the whole upstream SSE stream, returning the joined answer + reasoning. */
  private async collectStream(upstream: Response): Promise<{ content: string; reasoning: string }> {
    const reader = upstream.body?.getReader();
    const decoder = new TextDecoder();
    let content = "";
    let reasoning = "";
    if (!reader) return { content, reasoning };

    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          const delta = parseSseDelta(line);
          if (!delta) continue;
          if (delta.kind === "error") throw new QwenStreamError(delta.message);
          if (delta.kind === "answer") content += delta.text;
          else if (delta.kind === "think") reasoning += delta.text;
        }
      }
      if (buffer.trim()) {
        const delta = parseSseDelta(buffer);
        if (delta?.kind === "error") throw new QwenStreamError(delta.message);
        if (delta?.kind === "answer") content += delta.text;
        else if (delta?.kind === "think") reasoning += delta.text;
      }
    } catch (err) {
      if (err instanceof QwenStreamError) throw err;
      /* upstream closed mid-stream — return what we have */
    }
    if (!content.trim()) {
      throw new QwenStreamError(
        "Qwen returned no assistant content. Its web-session response format may have changed; " +
          "the upstream error is now surfaced instead of returning an empty success."
      );
    }
    return { content, reasoning };
  }

  /** Transform the Qwen phase SSE into OpenAI chat.completion.chunk SSE. */
  private buildClientStream(
    upstream: Response,
    modelId: string,
    hasTools: boolean,
    requestedTools: unknown,
    signal: AbortSignal | null | undefined
  ): ReadableStream {
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const id = `chatcmpl-qwen-${Date.now()}`;
    const created = Math.floor(Date.now() / 1000);
    const emitChunk = (delta: Record<string, unknown>, finishReason: string | null) =>
      `data: ${JSON.stringify({
        id,
        object: "chat.completion.chunk",
        created,
        model: modelId,
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      })}\n\n`;

    return new ReadableStream({
      async start(controller) {
        const reader = upstream.body?.getReader();
        if (!reader) {
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
          return;
        }
        let buffer = "";
        let fullContent = "";
        let roleEmitted = false;
        const emitRole = () => {
          if (!roleEmitted) {
            roleEmitted = true;
            controller.enqueue(encoder.encode(emitChunk({ role: "assistant", content: "" }, null)));
          }
        };
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";
            for (const line of lines) {
              const delta = parseSseDelta(line);
              if (!delta) continue;
              if (delta.kind === "error") {
                controller.enqueue(encoder.encode(emitError(delta.message)));
                controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                controller.close();
                return;
              }
              if (!delta.text) continue;
              emitRole();
              if (delta.kind === "answer") {
                fullContent += delta.text;
                if (!hasTools) {
                  controller.enqueue(encoder.encode(emitChunk({ content: delta.text }, null)));
                }
              } else if (delta.kind === "think" && !hasTools) {
                controller.enqueue(
                  encoder.encode(emitChunk({ reasoning_content: delta.text }, null))
                );
              }
            }
          }
          if (buffer.trim()) {
            const delta = parseSseDelta(buffer);
            if (delta?.kind === "error") {
              controller.enqueue(encoder.encode(emitError(delta.message)));
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              controller.close();
              return;
            }
            if (delta?.text) {
              emitRole();
              if (delta.kind === "answer") {
                fullContent += delta.text;
                if (!hasTools) controller.enqueue(encoder.encode(emitChunk({ content: delta.text }, null)));
              } else if (delta.kind === "think" && !hasTools) {
                controller.enqueue(encoder.encode(emitChunk({ reasoning_content: delta.text }, null)));
              }
            }
          }
        } catch (err) {
          if (!signal?.aborted) {
            controller.error(err);
            return;
          }
        }

        if (!fullContent.trim()) {
          controller.enqueue(
            encoder.encode(
              emitError(
                "Qwen returned no assistant content. Its web-session response format may have changed."
              )
            )
          );
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
          return;
        }

        if (hasTools) {
          const { content, toolCalls, finishReason } = buildToolAwareResult(
            fullContent,
            requestedTools,
            "qwen"
          );
          const delta = toolCalls
            ? { role: "assistant", content: null, tool_calls: toolCalls }
            : { role: "assistant", content };
          controller.enqueue(encoder.encode(emitChunk(delta, null)));
          controller.enqueue(encoder.encode(emitChunk({}, finishReason)));
        } else {
          controller.enqueue(encoder.encode(emitChunk({}, "stop")));
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
  }

  private jsonResponse(
    modelId: string,
    message: Record<string, unknown>,
    finishReason: string,
    url: string,
    transformedBody: unknown
  ) {
    return {
      response: new Response(
        JSON.stringify({
          id: `chatcmpl-qwen-${Date.now()}`,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: modelId,
          choices: [{ index: 0, message, finish_reason: finishReason }],
        }),
        { headers: { "Content-Type": "application/json" } }
      ),
      url,
      headers: {} as Record<string, string>,
      transformedBody,
    };
  }
}

class QwenStreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QwenStreamError";
  }
}

function emitError(message: string): string {
  return `data: ${JSON.stringify({
    error: { message, type: "upstream_error", code: "qwen_upstream_error" },
  })}\n\n`;
}

type QwenParsedDelta =
  | { kind: "answer" | "think"; text: string }
  | { kind: "error"; message: string };

/** Parse one SSE line into a typed delta, error, or null if it carries no data. */
function parseSseDelta(line: string): QwenParsedDelta | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const payload = trimmed.startsWith("data:") ? trimmed.slice(5).trim() : trimmed;
  if (!payload || payload === "[DONE]") return null;
  let parsed: any;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }

  const error = extractQwenError(parsed);
  if (error) return { kind: "error", message: error };

  const delta =
    parsed?.choices?.[0]?.delta ??
    parsed?.data?.choices?.[0]?.delta ??
    parsed?.output?.choices?.[0]?.delta ??
    parsed?.data?.output?.choices?.[0]?.delta;
  const phase = delta?.phase;
  const content =
    firstString(
      delta?.content,
      parsed?.choices?.[0]?.message?.content,
      parsed?.data?.choices?.[0]?.message?.content,
      parsed?.data?.content,
      parsed?.content,
      parsed?.data?.output_text,
      parsed?.data?.output?.text,
      parsed?.output_text,
      parsed?.output?.text
    ) ?? "";
  if (!delta && !content) return null;
  if (["think", "thinking", "reasoning", "analysis", "thinking_summary"].includes(phase)) {
    return { kind: "think", text: content };
  }
  // `answer` phase or a null/absent phase both carry assistant content.
  if (["answer", "content"].includes(phase) || phase === null || phase === undefined) {
    return { kind: "answer", text: content };
  }
  return null;
}

function firstString(...values: unknown[]): string | null {
  return values.find((value): value is string => typeof value === "string") ?? null;
}

function extractQwenError(parsed: any): string | null {
  const errorObject = parsed?.error;
  const retCode = Array.isArray(parsed?.ret) ? parsed.ret[0] : undefined;
  const retMessage = Array.isArray(parsed?.ret) ? parsed.ret[1] : undefined;
  const code = firstString(retCode, parsed?.code, parsed?.data?.code, errorObject?.code);
  const message = firstString(
    errorObject,
    errorObject?.message,
    retMessage,
    parsed?.data?.message,
    parsed?.message,
    parsed?.data?.error
  );
  if (parsed?.success === false || errorObject || code) {
    return `Qwen upstream error${code ? ` (${code})` : ""}: ${message || "request rejected"}`;
  }
  return null;
}
