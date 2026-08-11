import WebSocket from "ws";
import { FETCH_TIMEOUT_MS } from "../config/constants.ts";
import { buildGrokCookieHeader, extractGrokRequestHeader } from "@/lib/providers/webCookieAuth";
import { sanitizeErrorMessage } from "../utils/error.ts";
import type { ExecutorLog, ProviderCredentials } from "../executors/base.ts";

const GROK_WS_URL = "wss://grok.com/ws/mgw/";
const GROK_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";

type JsonRecord = Record<string, any>;

function eventEnvelope(sessionId: string | null, event: JsonRecord): string {
  return JSON.stringify({ ...(sessionId ? { session_id: sessionId } : {}), event });
}

function ndjson(value: JsonRecord): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(value)}\n`);
}

function fakeResponseEvent(text: string, isThinking: boolean): JsonRecord {
  return { result: { response: { token: text, isThinking } } };
}

function resolveUid(credentials: ProviderCredentials): string {
  const raw = credentials.apiKey || "";
  const fromHeader = extractGrokRequestHeader(raw, "x-userid");
  const configured = credentials.providerSpecificData?.grokUid;
  return fromHeader || (typeof configured === "string" ? configured.trim() : "");
}

/** Adapt Grok's current realtime WebSocket protocol to the existing NDJSON parser. */
export function createGrokWebSocketStream(input: {
  credentials: ProviderCredentials;
  model: string;
  message: string;
  signal?: AbortSignal | null;
  log?: ExecutorLog | null;
}): ReadableStream<Uint8Array> {
  const uid = resolveUid(input.credentials);
  const cookie = buildGrokCookieHeader(input.credentials.apiKey || "");
  const url = `${GROK_WS_URL}${uid ? `?uid=${encodeURIComponent(uid)}` : ""}`;

  return new ReadableStream<Uint8Array>({
    start(controller) {
      let ws: WebSocket | null = null;
      let sessionId: string | null = null;
      let settled = false;
      let responseStarted = false;
      const timeout = setTimeout(() => fail("Grok WebSocket timed out"), FETCH_TIMEOUT_MS);

      const cleanup = () => {
        clearTimeout(timeout);
        try { ws?.close(); } catch { /* socket may already be closed */ }
        ws = null;
      };
      const finish = () => {
        if (settled) return;
        settled = true;
        cleanup();
        try { controller.close(); } catch { /* consumer may have cancelled */ }
      };
      function fail(reason: string) {
        if (settled) return;
        settled = true;
        cleanup();
        controller.enqueue(ndjson({ error: { message: sanitizeErrorMessage(reason), code: "GROK_WS_ERROR" } }));
        controller.close();
      }
      const send = (event: JsonRecord) => {
        if (ws?.readyState === WebSocket.OPEN) ws.send(eventEnvelope(sessionId, event));
      };
      const sendPrompt = () => {
        if (responseStarted) return;
        responseStarted = true;
        send({
          type: "conversation.item.create",
          event_id: `evt_msg_${Date.now()}`,
          item: {
            type: "message", role: "user",
            x_grok: { client_message_id: crypto.randomUUID(), input_chunks: [{ text: { text: input.message } }] },
          },
        });
        send({ type: "response.create", event_id: `evt_resp_${Date.now()}` });
      };
      input.signal?.addEventListener("abort", () => fail("Request aborted"), { once: true });
      try {
        ws = new WebSocket(url, {
          headers: { ...(cookie ? { Cookie: cookie } : {}), Origin: "https://grok.com", Referer: "https://grok.com/", "User-Agent": GROK_USER_AGENT },
          origin: "https://grok.com", handshakeTimeout: FETCH_TIMEOUT_MS,
        });
        input.log?.debug?.("GROK-WS", `connecting → wss://grok.com/ws/mgw/${uid ? "?uid=present" : ""}`);
        ws.on("open", () => send({
          type: "session.create", event_id: `evt_init_${crypto.randomUUID()}`,
          session: {
            model: input.model,
            x_grok: {
              protocol_capabilities: ["conversation_attached", "custom_methods_v1"], use_chunk: true,
              enable_side_by_side: true, force_side_by_side: false, enable_image_generation: true,
              image_generation_count: 2, disable_text_follow_ups: false, disable_artifact: true, force_concise: false,
            },
          },
        }));
        ws.on("message", (data) => {
          if (settled) return;
          let payload: JsonRecord;
          try { payload = JSON.parse(data.toString()) as JsonRecord; } catch { return; }
          const event = (payload.event || payload) as JsonRecord;
          if (event.type === "session.created") { sessionId = typeof payload.session_id === "string" ? payload.session_id : null; return; }
          if (event.type === "conversation.attached") { sendPrompt(); return; }
          if (event.type === "response.chunk") {
            const text = event.chunk?.text;
            if (typeof text?.text === "string" && text.text) controller.enqueue(ndjson(fakeResponseEvent(text.text, text.channel !== "CHANNEL_ASSISTANT_RESPONSE")));
            return;
          }
          if (event.type === "response.done") { finish(); return; }
          if (event.type === "error" || event.type === "response.error") fail(event.error?.message || event.message || "Grok WebSocket upstream error");
        });
        ws.on("error", (error) => fail(error instanceof Error ? error.message : "Grok WebSocket connection error"));
        ws.on("close", () => { if (!settled) finish(); });
      } catch (error) { fail(error instanceof Error ? error.message : "Failed to connect to Grok WebSocket"); }
    },
  });
}
