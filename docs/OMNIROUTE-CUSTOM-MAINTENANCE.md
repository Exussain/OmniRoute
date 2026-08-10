# OmniRoute Custom Maintenance Memory

This document is the durable handoff for the personal OmniRoute customization in
`/root/OmniRoute`. It records local architecture, intentional modifications,
secrets policy, validation commands, and the safe procedure for consuming future
updates from the original OmniRoute repository.

## Documentation and memory invariant

Documentation is part of the implementation. Every future code, configuration,
provider-protocol, dependency, deployment, or upstream-merge change must update
this maintenance memory and the relevant provider/runbook document in the same
change. Record what changed, why it changed, affected files/services, migration
or rollback notes, validation performed, and any unresolved follow-up. A task is
not complete until the code and its operational memory agree. Keep the initial
agent handoff prompt current as the workflow evolves.

## Repository roles

- Local checkout: `/root/OmniRoute`
- Grok2API checkout: `/root/grok2api`
- Original OmniRoute repository: `https://github.com/diegosouzapw/OmniRoute`
- Personal fork: `https://github.com/Exussain/OmniRoute`
- Current custom branch: `custom/grok-qwen-web`
- Initial custom commit: `6d6f42f7a`
- The checkout currently has local Qwen/Grok changes that must be preserved and
  committed on the personal fork before upstream updates are integrated.
- The original repository must be treated as upstream code. Do not overwrite
  local custom changes with a blind pull, reset, or checkout.

## Local services

All services are intentionally loopback-only. Do not create a public listener,
tunnel, reverse proxy, or port-forward without explicit approval.

| Service | Address | Purpose |
| --- | --- | --- |
| OmniRoute | `127.0.0.1:20128` | Main OpenAI-compatible router and dashboard |
| Grok bridge | `127.0.0.1:20129` | Existing local Grok Web WebSocket bridge |
| Grok2API | `127.0.0.1:8000` | Standalone Go Grok gateway |

Systemd units:

```text
omniroute.service
omniroute-grok-bridge.service
grok2api.service
```

Check them without exposing credentials:

```bash
systemctl is-active omniroute omniroute-grok-bridge grok2api
ss -ltnp | rg ':(20128|20129|8000)\\b'
```

The OmniRoute service was briefly stopped during the Go build because the host
had very limited RAM and the compiler was being killed. It is enabled and should
be started again after maintenance:

```bash
systemctl start omniroute
```

## What has been customized

### Grok Web

The current Grok Web frontend no longer emits the retired HTTP conversation
creation request used by the old executor path. It creates a WebSocket at:

```text
wss://grok.com/ws/mgw/?uid=<runtime user id>
```

The custom implementation is in:

- `open-sse/services/grokWebSocket.ts`
- `open-sse/executors/grok-web.ts`
- `src/lib/providers/webCookieAuth.ts`

The protocol currently requires this order:

1. `session.create`
2. `conversation.attached`
3. `conversation.item.create`
4. `response.create`
5. `response.chunk` events containing assistant text
6. `response.done` / `response.persisted`
7. heartbeat `ping` / `pong`

The implementation must preserve streaming, non-streaming collection, abort
handling, tool-call translation, and safe error mapping. Do not log WebSocket
payloads, cookies, SSO values, request tokens, or full headers.

### Qwen Web

The Qwen Web executor was updated to preserve the live browser request headers
that its anti-bot layer expects. The important changes are in:

- `open-sse/executors/qwen-web.ts`
- `src/lib/providers/webCookieAuth.ts`

The current captured frontend values include SPA version `0.2.83` and browser
fingerprint headers. These values are not permanent API contracts; re-capture
the live request when Qwen returns an empty successful response or changes its
frontend build. Never put a real cookie or token in source, fixtures, logs, or
documentation.

### Dependency maintenance

`open-sse` has its own npm dependency manifest and Dependabot entry. Updates must
be reviewed separately from the root OmniRoute dependency tree. Keep lockfiles,
runtime compatibility, and the relevant test commands aligned.

## Grok2API integration

Grok2API is built from source without Docker using Go and Make. Its protected
runtime files are deliberately outside Git history:

```text
/root/grok2api/config.yaml
/root/grok2api/.env
/root/grok2api/data/
```

The generated configuration uses SQLite, in-memory runtime state, one replica,
and `127.0.0.1:8000`. The admin password and client API key are stored only in
`/root/grok2api/.env`, which is mode `600`. The credential encryption key must
never be rotated after accounts have been stored.

The existing local Grok Web account was imported into Grok2API through the admin
API. The account import document must use the provider tag `grok_web`;
`web` is not valid. The account is synchronized before model routes are
considered ready.

Admin workflow:

1. Open `http://127.0.0.1:8000` locally.
2. Sign in with the bootstrap administrator from the local `.env` file.
3. Change the administrator password.
4. Remove the `bootstrapAdmin` block from `config.yaml` after the admin record
   is established, then restart the service.
5. Review **Model Routes** and confirm the Grok Web chat route is available.
6. Create a client key under **Client Keys**.
7. Use the exact model ID returned by `GET /v1/models`.

The Grok2API custom OpenAI provider entry intended for OmniRoute is:

```text
Name: Grok2API Local
Type: OpenAI-compatible / Custom OpenAI
Base URL: http://127.0.0.1:8000/v1
API key: the Grok2API client key from /root/grok2api/.env
Model: the exact ID returned by Grok2API /v1/models
API mode: Chat Completions
```

The key must be entered through the OmniRoute dashboard or protected local
configuration, never committed to Git or pasted into an issue, chat transcript,
test snapshot, or shell history.

## Validation checklist

Run these checks after any provider or protocol change. Keep output sanitized:

```bash
curl -fsS http://127.0.0.1:8000/healthz
curl -fsS http://127.0.0.1:8000/readyz

set -a; . /root/grok2api/.env; set +a
curl -fsS http://127.0.0.1:8000/v1/models \\\
  -H "Authorization: Bearer $GROK2API_CLIENT_API_KEY"

curl -fsS http://127.0.0.1:20128/v1/models
```

For a streaming test, use a unique harmless marker and verify that the response
contains assistant deltas and `[DONE]`; do not save the complete response if it
could contain credentials or private user content. Test the full path:

```text
client -> OmniRoute -> Grok2API -> Grok Web
```

If the test says “provider test unsupported”, that is an OmniRoute connection
test capability message, not proof that the OpenAI-compatible route is broken.
Validate the route with `/v1/models` and a real chat completion instead.

## Secret handling

- Never print, commit, upload, or quote cookies, SSO tokens, API keys, admin
  passwords, JWT secrets, encryption keys, or WebSocket request tokens.
- Keep `/root/grok2api/.env` and `/root/grok2api/config.yaml` mode `600`.
- Use environment variables or in-memory scripts for one-off local tests.
- If a credential must be refreshed, ask the user to update the local protected
  `.env` file; do not ask them to paste the value into chat.
- If a token is provided for GitHub, use it only for the requested operation,
  do not write it into Git config or repository files, and have the user revoke
  or rotate it after the short-lived operation.

## Upstream update strategy

The personal fork is configured with two remotes:

```text
origin   -> https://github.com/Exussain/OmniRoute.git (push here)
upstream -> https://github.com/diegosouzapw/OmniRoute.git (fetch only; push disabled locally)
```

When the fork is available, configure the remotes explicitly and verify them:

```bash
git remote set-url origin <user-fork-url>
git remote add upstream https://github.com/diegosouzapw/OmniRoute.git
git remote -v
```

Keep custom work on a dedicated branch, for example:

```text
custom/grok-qwen-web
```

Recommended update sequence:

```bash
git status --short --branch
git fetch upstream --prune
git switch custom/grok-qwen-web
git rebase upstream/main
```

If the project uses a release branch as the integration base, rebase onto the
matching upstream release branch instead. Before rebasing, commit or stash all
local work. Resolve conflicts by preserving the current upstream implementation
for unrelated code and re-applying only the minimal Grok/Qwen compatibility
changes. Never resolve a conflict by accepting “ours” or “theirs” for an entire
file without reviewing the protocol behavior.

After an upstream update:

1. Inspect `git diff upstream/main...HEAD` and `git range-diff` for lost custom
   commits.
2. Re-check provider route registration and model aliases.
3. Re-run type checks, unit tests, and the targeted Qwen/Grok tests.
4. Build `open-sse` and verify its lockfile is consistent.
5. Restart only the affected local service.
6. Run the loopback health and end-to-end streaming checks.
7. Push the reviewed branch to the personal fork and open a draft PR if useful.

Keep commits small and thematic:

- `fix(grok-web): use current realtime websocket transport`
- `fix(qwen-web): preserve live browser request headers`
- `docs: record local provider maintenance workflow`
- dependency-only updates in separate commits

This makes upstream conflict resolution and future cherry-picks predictable.

## Initial agent handoff prompt

Use the following as the initial context for a future maintenance session:

> You are maintaining a personal fork of OmniRoute in `/root/OmniRoute`, with
> Grok2API in `/root/grok2api`. The original OmniRoute repository is
> `https://github.com/diegosouzapw/OmniRoute.git`; the personal fork is the only
> push target. Read `docs/OMNIROUTE-CUSTOM-MAINTENANCE.md` before changing code.
> Documentation is part of every change: update the maintenance memory, the
> relevant provider/runbook notes, and this handoff prompt whenever behavior,
> configuration, dependencies, deployment, or upstream integration changes.
> Preserve local custom behavior while consuming upstream changes carefully.
> Never use destructive Git commands, never overwrite uncommitted user changes,
> and never print or commit secrets. OmniRoute is loopback-only on port 20128,
> the Grok bridge is loopback-only on 20129, and Grok2API is loopback-only on
> 8000. The custom integrations are the Qwen live-header handling and Grok Web
> WebSocket transport. Before each change inspect `git status`, identify the
> upstream base, make a focused patch, run targeted tests, and validate the full
> client -> OmniRoute -> provider path. For upstream updates, fetch the upstream
> remote, rebase the dedicated custom branch, review conflicts manually, run
> tests/builds, and report exactly what changed and what remains.
