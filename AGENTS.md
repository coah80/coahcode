# AGENTS.md

## Task Completion Requirements

- All of `bun fmt`, `bun lint`, and `bun typecheck` must pass before considering tasks completed.
- NEVER run `bun test`. Always use `bun run test` (runs Vitest).

## Project Snapshot

T3 Code is a minimal web GUI for using coding agents like Codex and Claude.

This repository is a VERY EARLY WIP. Proposing sweeping changes that improve long-term maintainability is encouraged.

## Core Priorities

1. Performance first.
2. Reliability first.
3. Keep behavior predictable under load and during failures (session restarts, reconnects, partial streams).

If a tradeoff is required, choose correctness and robustness over short-term convenience.

## Maintainability

Long term maintainability is a core priority. If you add new functionality, first check if there is shared logic that can be extracted to a separate module. Duplicate logic across multiple files is a code smell and should be avoided. Don't be afraid to change existing code. Don't take shortcuts by just adding local logic to solve a problem.

## Package Roles

- `apps/server`: Node.js WebSocket server. Wraps Codex app-server (JSON-RPC over stdio), serves the React web app, and manages provider sessions.
- `apps/web`: React/Vite UI. Owns session UX, conversation/event rendering, and client-side state. Connects to the server via WebSocket.
- `packages/contracts`: Shared effect/Schema schemas and TypeScript contracts for provider events, WebSocket protocol, and model/session types. Keep this package schema-only — no runtime logic.
- `packages/shared`: Shared runtime utilities consumed by both server and web. Uses explicit subpath exports (e.g. `@t3tools/shared/git`) — no barrel index.

## Codex App Server (Important)

T3 Code is currently Codex-first. The server starts `codex app-server` (JSON-RPC over stdio) per provider session, then streams structured events to the browser through WebSocket push messages.

How we use it in this codebase:

- Session startup/resume and turn lifecycle are brokered in `apps/server/src/codexAppServerManager.ts`.
- Provider dispatch and thread event logging are coordinated in `apps/server/src/providerManager.ts`.
- WebSocket server routes NativeApi methods in `apps/server/src/wsServer.ts`.
- Web app consumes orchestration domain events via WebSocket push on channel `orchestration.domainEvent` (provider runtime activity is projected into orchestration events server-side).

Docs:

- Codex App Server docs: https://developers.openai.com/codex/sdk/#app-server

## Reference Repos

- Open-source Codex repo: https://github.com/openai/codex
- Codex-Monitor (Tauri, feature-complete, strong reference implementation): https://github.com/Dimillian/CodexMonitor

Use these as implementation references when designing protocol handling, UX flows, and operational safeguards.

## Cursor Cloud specific instructions

### Runtime versions

Requires Node.js 24.13.1 and Bun 1.3.9 (pinned in `.mise.toml`). The VM update script handles `bun install`; Node and Bun are pre-installed in the environment.

### Running services

- `T3CODE_NO_BROWSER=1 bun dev` starts both the backend (port 13773) and Vite dev server (port 5733) via turbo TUI. Use `T3CODE_NO_BROWSER=1` to suppress auto-open in headless environments.
- Backend serves WebSocket/HTTP on port 13773; web app connects to it via `VITE_WS_URL=ws://localhost:13773`.
- SQLite data lives at `~/.t3/dev/state.sqlite` (auto-created on first run, migrations run automatically).

### Lint / Format / Typecheck / Test

- `bun lint` — oxlint (0 errors expected; warnings are acceptable)
- `bun fmt` — oxfmt (auto-fix); `bun fmt:check` for CI
- `bun typecheck` — turbo-orchestrated tsc across all 8 packages
- `bun run test` — turbo-orchestrated Vitest (never use bare `bun test`)

### Provider CLIs not available

Codex CLI and Claude CLI are not installed in the Cloud Agent VM. The app starts and is fully interactive without them — provider sessions just can't be created. This is expected and does not block UI development or non-provider tests.

### Desktop (Electron) dev mode

`bun dev:desktop` does not work in the Cloud Agent VM for two reasons:
1. `tsdown --watch` hangs during the desktop bundle build step, preventing Electron from launching via the standard orchestration.
2. `/dev/shm` is only 64MB in the VM, causing Chromium's `ERR_INSUFFICIENT_RESOURCES` when Electron loads the Vite dev server. The `--disable-dev-shm-usage` flag fixes the resource error, but the auth bootstrap still fails because the desktop IPC channel isn't wired without the full `dev:desktop` orchestration.

Use `bun dev` (web mode) for all UI development. The web mode is functionally equivalent — the same React app runs in both modes.
