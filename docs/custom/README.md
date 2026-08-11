# OmniRoute Custom Fork Documentation (`docs/custom/`)

> 📌 **IMPORTANT**: This directory contains critical operational memory and maintenance instructions for this custom fork of OmniRoute.
>
> All AI assistants (including Gemini, Claude Code, and AGY agents) **MUST READ THESE FILES FIRST** before performing code changes, upstream merges, or deployment tasks in this repository.

## Custom Fork Maintenance Index

| Document                                                             | Purpose                                                                                                                   |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| [`OMNIROUTE-CUSTOM-MAINTENANCE.md`](OMNIROUTE-CUSTOM-MAINTENANCE.md) | Primary handoff memory for local architecture, systemd services, Grok2API, secret policies, and upstream rebase strategy. |
| [`QWEN-WEB-MAINTENANCE.md`](QWEN-WEB-MAINTENANCE.md)                 | Maintenance guide for Qwen Web patch (browser request-header preservation, anti-bot handling, and credential management). |

## Core Invariants for AI Agents

1. **Preserve Custom Code**: Never blindly pull, reset, or overwrite local Grok Web (`open-sse/services/grokWebSocket.ts`, `open-sse/executors/grok-web.ts`) or Qwen Web (`open-sse/executors/qwen-web.ts`, `src/lib/providers/webCookieAuth.ts`) modifications during upstream rebases.
2. **Loopback Only**: All services (`omniroute` on 20128, `grok-bridge` on 20129, `grok2api` on 8000) must remain strictly loopback-only (`127.0.0.1`).
3. **Documentation Sync**: Any modifications to protocols, dependencies, or services must update the maintenance memory in `docs/custom/` in the same change.
