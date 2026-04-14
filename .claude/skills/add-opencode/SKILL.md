---
name: add-opencode
description: Use OpenCode as an agent provider on NanoClaw v2 (AGENT_PROVIDER=opencode). OpenRouter, OpenAI, Google, DeepSeek, etc. via OpenCode config — not the Anthropic Agent SDK. Per-session and per-group via agent_provider; host passes OPENCODE_* and XDG mount when spawning containers.
---

# OpenCode agent provider (v2)

NanoClaw **v2** runs agents in a long-lived **poll loop** inside the container. The backend is selected with **`AGENT_PROVIDER`** (`claude` | `opencode` | `mock`), not the v1 `AGENT_RUNNER` env var.

## What it does (upstream v2)

- **`container/agent-runner/src/providers/opencode.ts`** — `OpenCodeProvider` implementing `AgentProvider` (SSE via OpenCode server, session resume, MCP from merged `ProviderOptions.mcpServers` only — no `settings.json` MCP bridge).
- **`container/agent-runner/src/providers/mcp-to-opencode.ts`** — maps v2 `McpServerConfig` to OpenCode `mcp` entries.
- **`container/agent-runner/src/providers/factory.ts`** — registers `opencode`.
- **`container/agent-runner/package.json`** — dependency `@opencode-ai/sdk`.
- **`container/Dockerfile`** — global **`opencode-ai`** CLI for `opencode serve`.
- **`src/container-runner.ts`** — when effective provider is `opencode`: `XDG_DATA_HOME=/opencode-xdg`, session-scoped host mount, `NO_PROXY`/`no_proxy` merge for `127.0.0.1,localhost`, passes through `OPENCODE_PROVIDER`, `OPENCODE_MODEL`, `OPENCODE_SMALL_MODEL` from the host environment.

## Configuration

### Host `.env` (typical)

Set model/provider strings in the form OpenCode expects (often `provider/model-id`). **Put comments on their own lines** — a `#` inside a value is kept verbatim and breaks model IDs.

These variables are read **on the host** and passed into the container only when the effective provider is `opencode` (see `src/container-runner.ts`). They do not switch the provider by themselves; the DB still needs `agent_provider` set (below).

- `OPENCODE_PROVIDER` — OpenCode provider id, e.g. `openrouter`, `anthropic` (if unset, the runner defaults to `anthropic`).
- `OPENCODE_MODEL` — full model id, e.g. `openrouter/anthropic/claude-sonnet-4`.
- `OPENCODE_SMALL_MODEL` — optional second model for “small” tasks.

Credentials: OneCLI / credential proxy patterns are unchanged. For non-`anthropic` OpenCode providers, the runner registers a placeholder API key and **`ANTHROPIC_BASE_URL`** (the credential proxy) as `baseURL` so the real key never lives in the container.

#### Example: OpenRouter

Use ids that match OpenCode’s registry / your custom registrations. Adjust names to what you actually run.

```env
# OpenCode — host passes these into the container when agent_provider is opencode
OPENCODE_PROVIDER=openrouter
OPENCODE_MODEL=openrouter/anthropic/claude-sonnet-4
OPENCODE_SMALL_MODEL=openrouter/anthropic/claude-haiku-4.5
```

#### Example: Anthropic via existing proxy env

When `OPENCODE_PROVIDER` is `anthropic`, OpenCode uses normal Anthropic env inside the container (proxy + placeholder key pattern unchanged).

```env
OPENCODE_PROVIDER=anthropic
OPENCODE_MODEL=anthropic/claude-sonnet-4-20250514
```

#### Example: only a main model

```env
OPENCODE_PROVIDER=openrouter
OPENCODE_MODEL=openrouter/google/gemini-2.5-pro-preview
```

### Per group / per session

v2 schema: **`agent_groups.agent_provider`** and **`sessions.agent_provider`**. Set to `opencode` for groups or sessions that should use OpenCode. The container receives `AGENT_PROVIDER` from the resolved value (session overrides group).

Extra MCP servers still come from **`NANOCLAW_MCP_SERVERS`** / `container_config.mcpServers` on the host; the runner merges them into the same `mcpServers` object passed to **both** Claude and OpenCode providers.

## Operational notes

- OpenCode keeps a local **`opencode serve`** process and SSE subscription; the provider tears down with **`stream.return`** and **SIGKILL** on the server process on **`abort()`** / shared runtime reset to avoid MCP/zombie hangs.
- Session continuation is opaque (`ses_*` ids); stale sessions are cleared using **`isSessionInvalid`** on OpenCode-specific errors (timeouts, connection resets, not-found patterns) in addition to the poll-loop’s existing recovery.
- **`NO_PROXY`** for localhost matters when the OpenCode client talks to `127.0.0.1` inside the container while HTTP(S)_PROXY is set (e.g. OneCLI).

## Verify

```bash
grep -q opencode container/agent-runner/src/providers/factory.ts && echo "OpenCode registered" || echo "Missing"
npm run build --prefix container/agent-runner
```

Rebuild the agent image after Dockerfile changes: `./container/build.sh` (or your usual image build).

## Migrate from v1 wording

If documentation or habits still say **`AGENT_RUNNER=opencode`**, update to **`AGENT_PROVIDER=opencode`** and store **`agent_provider`** in v2 tables, not v1 runner columns.
