# CoahCode — Codex Handoff Document

## What This Is

CoahCode is a fork of [T3 Code](https://github.com/pingdotgg/t3code) (Theo's open-source AI coding agent) with a Cursor-grade agent harness bolted on. The harness adds parallel tool execution, MCP server support, LSP integration, skills/rules discovery, scheduled tasks, model switching mid-chat, steering (steer vs queue follow-ups), physics-based thread drag-and-drop, checkpoint snapshots, tool result spilling, skill auto-creation nudges, and mixture-of-agents mode.

**Repo:** https://github.com/coah80/coahcode
**Local path:** `~/Projects/cursor-harness/coahcode-build`
**Status:** Builds clean, dev server runs, 0 type errors. The harness engine is fully built but not yet wired into T3 Code's orchestration layer — it exists as a parallel system that needs integration.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Monorepo | Turborepo |
| Runtime | Bun |
| Server | Effect-TS, SQLite (via `@effect/sql-sqlite-bun`), WebSocket RPC |
| Web | React 19, TanStack Router + Query, Tailwind CSS 4, Vite |
| Desktop | Electron (via `apps/desktop`) |
| AI Providers | Claude Agent SDK (`@anthropic-ai/claude-agent-sdk` v0.2.77), OpenAI Codex CLI |
| Auth | Claude: OAuth via `claude login`. Codex: API key via `codex login` |

---

## Monorepo Structure

```
coahcode-build/
  apps/
    server/           — Backend (Effect-TS services, SQLite, WebSocket RPC)
      src/
        provider/     — AI provider adapters (ClaudeAdapter, CodexAdapter)
        orchestration/ — Agent state machine (CQRS/event-sourced)
        terminal/     — PTY terminal management
        git/          — Git operations
        persistence/  — SQLite migrations + queries
        harness/      — *** OUR CODE *** (agent harness engine)
    web/              — Frontend (React, TanStack, Tailwind)
      src/
        components/   — UI components (chat/, settings/, ui/)
        hooks/        — Custom React hooks
        lib/          — React Query options, utilities
        rpc/          — WebSocket RPC client
        routes/       — TanStack Router file-based routes
    desktop/          — Electron shell
    marketing/        — Marketing site
  packages/
    contracts/        — Shared TypeScript types, RPC definitions, schemas
    shared/           — Shared utilities
```

---

## The Harness (`apps/server/src/harness/`)

This is all our custom code. 18 files, ~2,500 lines.

### File Map

```
harness/
  types.ts                    — All type definitions (ToolName, AgentConfig, AgentEvent, etc.)
  index.ts                    — Barrel exports for everything

  engine/
    loop.ts                   — Core agent loop: stream model → collect tool calls → execute in parallel → loop
    prompt.ts                 — System prompt builder (Cursor-style sections)
    home.ts                   — Home workspace: discover projects in ~/Projects, ~/Developer, etc.
    scheduler.ts              — Cron-based scheduled agent tasks (in-memory, needs persistence)
    steering.ts               — Steer vs queue follow-up behavior
    modelSwitch.ts            — Mid-chat model switching (pending switch applied after turn)
    skillNudge.ts             — Periodic nudges to save reusable skills (every N turns)
    resultSpill.ts            — Large tool outputs → temp file + preview (50K per-result, 200K per-turn)
    checkpoint.ts             — Shadow git snapshots before file mutations (~/.coahcode/checkpoints/)
    mixtureOfAgents.ts        — Fan hard problems to N models in parallel, synthesize answer

  providers/
    anthropic.ts              — Anthropic Messages API streaming with tool use
    openai.ts                 — OpenAI/OpenRouter Chat Completions streaming with tool use

  tools/
    index.ts                  — 11 tool implementations + tool definitions
                                Shell, Read, Write, StrReplace, Delete, Glob, Grep,
                                ReadLints, TodoWrite, WebSearch, WebFetch

  mcp/
    client.ts                 — MCP client: local (stdio) + remote (HTTP) servers
                                McpManager class with connectAll, getAllTools, callTool

  lsp/
    client.ts                 — LSP client: lazy spawn, JSON-RPC over stdio
                                Built-in: TypeScript, Python, Go, Rust, CSS
                                getDiagnostics, goToDefinition, hover

  skills/
    loader.ts                 — SKILL.md discovery from ~/.claude/skills, ~/.cursor/skills, project dirs
                                AGENTS.md/CLAUDE.md instruction loading
                                Exposed as "Skill" tool for the model to call
```

### How the Agent Loop Works (`engine/loop.ts`)

```
1. Discover skills + load instructions from workspace
2. Connect MCP servers (if configured)
3. Build tool list: built-in + MCP + LSP + skills
4. Build system prompt with instructions
5. LOOP:
   a. Stream model response (Anthropic or OpenAI)
   b. Accumulate text + tool calls
   c. If no tool calls → done
   d. Checkpoint files about to be mutated (shadow git)
   e. Execute ALL tool calls in PARALLEL (Promise.all)
      - Route by prefix: mcp_* → MCP, LSP → LSP, Skill → skills, else → built-in
   f. Spill oversized results to temp files
   g. Append to conversation history
   h. Nudge skill/memory creation if enough turns passed
   i. Back to (a)
6. Cleanup MCP connections
```

### Key Design Decisions

- **Parallel execution** is the speed secret. All tool calls in a single model turn execute concurrently via `Promise.all`. This matches Cursor's architecture.
- **MCP tools are namespaced** as `mcp_{serverName}_{toolName}` to avoid collisions.
- **Skills are tools, not system prompt** — the model calls `Skill({name: "foo"})` and gets the skill content as tool output. This preserves prompt caching.
- **Checkpoints are invisible** to the model. Shadow git repos in `~/.coahcode/checkpoints/` snapshot files before every Write/StrReplace/Delete.
- **Result spilling** uses a 3-layer budget: per-result 50K chars, per-turn aggregate 200K chars. Oversized outputs get a head/tail preview + file path the model can `Read` later.

---

## Frontend Components We Added

### In `apps/web/src/components/`

| File | What It Does |
|------|-------------|
| `ScheduledTasks.tsx` | CRUD UI for cron-scheduled agent runs. Create/toggle/delete tasks with preset schedules and model picker. Wired to React Query → LocalApi stubs. |
| `WorkspacePicker.tsx` | Search + select project workspaces. Shows git remote info. Create new projects. Wired to React Query → LocalApi stubs. |
| `chat/ModelSwitcher.tsx` | Dropdown to switch models mid-chat. Groups by provider (Anthropic/OpenAI/OpenRouter). Shows tier badges (fast/standard/premium/reasoning). |
| `chat/SteeringIndicator.tsx` | Shows "Steer" or "Queue" mode during active runs. Toggle between modes. |

### In `apps/web/src/hooks/`

| File | What It Does |
|------|-------------|
| `usePhysicsDrag.tsx` | Spring pendulum physics for dragging threads between folders. `DragGhost` component renders SVG string from cursor to dangling card. Uses `requestAnimationFrame` simulation loop. |

### In `apps/web/src/lib/`

| File | What It Does |
|------|-------------|
| `scheduledTasksReactQuery.ts` | TanStack Query options for scheduled tasks CRUD. Uses `ensureLocalApi()`. |
| `workspaceReactQuery.ts` | TanStack Query options for workspace discovery + creation. |

### Branding Changes

- `apps/web/src/index.css` — Primary color changed from blue (hue 264) to purple (hue 303) in both light and dark mode
- `apps/web/src/branding.ts` — `APP_BASE_NAME` changed to `"CoahCode"`
- `apps/web/index.html` — Title changed to `"CoahCode"`
- `apps/web/src/components/Sidebar.tsx` — Wordmark changed from T3 SVG logo to `<span className="text-primary font-bold">Coah</span>Code`

---

## Contracts Changes (`packages/contracts/src/`)

### `ipc.ts`
- Added `scheduledTasks` and `workspace` namespaces to `LocalApi` interface
- Added `ScheduledTaskInfo`, `ScheduledTaskCreateInput`, `WorkspaceProject` types

### `rpc.ts`
- Added `WS_METHODS` entries: `scheduledTasks.list`, `.create`, `.delete`, `.toggle`, `workspace.discover`, `.create`, `.switch`
- Added `Rpc.make()` definitions for all new methods
- Added all new RPCs to `WsRpcGroup`

---

## What Works Right Now

1. **Build** — `bun run build` passes clean (5/5 tasks, 0 errors)
2. **Dev server** — `bun run dev` starts web on :5733 and server on :13773
3. **Auth** — Claude via `claude login` OAuth, Codex via API key
4. **Chat** — Full T3 Code chat experience with Claude/Codex
5. **Diffs** — File diff visualization
6. **Terminals** — Integrated terminal sessions
7. **Plan mode** — Plan sidebar with implementation flow
8. **Purple accent** — Throughout light and dark themes
9. **CoahCode branding** — Sidebar, title, settings
10. **Steering indicator** — Shows in composer footer during active runs
11. **ScheduledTasks UI** — Renders in settings page (data is in-memory stubs)

---

## What Needs Wiring (Priority Order)

### 1. Integrate Harness with Orchestration Engine (HIGH)

The harness in `apps/server/src/harness/` is a standalone agent loop. T3 Code has its own orchestration system in `apps/server/src/orchestration/` that manages threads, turns, events, and checkpoints via CQRS/event-sourcing with Effect-TS.

**What needs to happen:**
- Create a `HarnessAdapter` that implements `ProviderAdapterShape` (see `apps/server/src/provider/Services/ProviderAdapter.ts`)
- Register it in `ProviderAdapterRegistry` alongside `ClaudeAdapter` and `CodexAdapter`
- The adapter should use `runAgentLoop()` from our harness engine
- Map harness `AgentEvent` types to T3 Code's `ProviderRuntimeEvent` types
- This lets users choose "CoahCode Harness" as a provider alongside Claude/Codex

**Key files to study:**
- `apps/server/src/provider/Layers/ClaudeAdapter.ts` — Reference implementation
- `apps/server/src/provider/Services/ProviderAdapter.ts` — Interface to implement
- `apps/server/src/provider/Layers/ProviderAdapterRegistry.ts` — Registration
- `apps/server/src/orchestration/Services/OrchestrationEngine.ts` — State machine

### 2. Wire Scheduled Tasks to Persistence (MEDIUM)

Currently `scheduledTasks` in `LocalApi` returns empty stubs. Needs:
- SQLite migration for `scheduled_tasks` table
- Effect service layer for CRUD
- RPC handler in the server's WS handler (`apps/server/src/ws.ts`)
- Wire the `scheduledTasksReactQuery` to use real RPC calls instead of stubs
- Implement the actual scheduler that invokes `runAgentLoop()` on cron triggers

### 3. Wire Workspace Discovery to Real File System (MEDIUM)

Currently `workspace` in `LocalApi` returns empty stubs. Needs:
- RPC handler that calls `discoverProjects()` from `harness/engine/home.ts`
- Wire `workspaceReactQuery` to real RPC calls
- Add workspace switcher to the sidebar (T3 Code already has project add/remove)

### 4. Wire Physics Drag into Sidebar Thread List (LOW)

`usePhysicsDrag.tsx` is built but not connected to the sidebar. Needs:
- Import `usePhysicsDrag` and `DragGhost` in `Sidebar.tsx`
- Add `onMouseDown={startDrag}` to thread items
- Render `DragGhost` at the root level
- Handle `onDrop` to move threads between projects
- `data-drop-zone` attributes are already on project `<Collapsible>` elements

### 5. Wire ModelSwitcher into Composer (LOW)

`ModelSwitcher.tsx` is built but not rendered. T3 Code already has a `ProviderModelPicker` component in the composer footer. Options:
- Replace `ProviderModelPicker` with our `ModelSwitcher` (more models, tier badges)
- Or add `ModelSwitcher` as a secondary picker for mid-chat switching
- Wire the `onSwitch` callback to `requestModelSwitch()` from `harness/engine/modelSwitch.ts`

### 6. Connect MCP Config to UI (LOW)

The harness `McpManager` accepts `McpServerConfig[]`. Needs:
- Settings UI for adding/removing MCP servers (command + args for local, URL for remote)
- Persist config to SQLite or JSON file
- Pass configs to `runAgentLoop()` via `mcpConfigs` option

### 7. Connect LSP Manager Lifecycle (LOW)

The harness `LspManager` spawns LSP servers lazily. Needs:
- Initialize `LspManager` at server startup
- Pass it to `runAgentLoop()` via `lspManager` option
- Clean up on server shutdown
- Optional: settings UI for custom LSP server configs

---

## How to Run

```bash
# Prerequisites: bun, claude login (for Claude), codex login (for Codex)
cd ~/Projects/cursor-harness/coahcode-build
bun install
bun run dev
# Open the pairing URL printed in the terminal
```

## How to Build

```bash
bun run build        # Full production build
bun run typecheck    # Type checking only
bun run test         # Run tests
bun run lint         # Lint with oxlint
```

## How to Update from Upstream T3 Code

```bash
git fetch upstream main
git merge upstream/main
# Resolve conflicts (our files are in harness/ and won't conflict with upstream)
# Re-check branding (Sidebar wordmark, index.css colors, branding.ts)
bun run build        # Verify
```

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────┐
│  React Frontend (apps/web)                          │
│  ├── ChatView + ChatComposer (existing T3 Code)     │
│  ├── ModelSwitcher (our addition)                    │
│  ├── SteeringIndicator (our addition)                │
│  ├── ScheduledTasks (our addition)                   │
│  ├── WorkspacePicker (our addition)                  │
│  └── usePhysicsDrag (our addition)                   │
├─────────────────────────────────────────────────────┤
│  WebSocket RPC (packages/contracts/src/rpc.ts)      │
├─────────────────────────────────────────────────────┤
│  Server (apps/server)                               │
│  ├── OrchestrationEngine (existing — CQRS/ES)       │
│  ├── ProviderService (existing — routes to adapters) │
│  │   ├── ClaudeAdapter (existing — Claude Agent SDK) │
│  │   ├── CodexAdapter (existing — OpenAI Codex CLI)  │
│  │   └── HarnessAdapter (TODO — our harness)         │
│  ├── TerminalManager (existing)                      │
│  ├── GitManager (existing)                           │
│  └── Harness Engine (our addition)                   │
│      ├── Agent Loop (parallel tool execution)        │
│      ├── Tools (Shell, Read, Write, Grep, etc.)      │
│      ├── MCP Client (local + remote servers)         │
│      ├── LSP Client (TS, Python, Go, Rust, CSS)      │
│      ├── Skills Loader (SKILL.md, AGENTS.md)         │
│      ├── Scheduler (cron tasks)                      │
│      ├── Checkpoints (shadow git snapshots)          │
│      ├── Result Spilling (context budget)            │
│      ├── Skill Nudges (auto-capture knowledge)       │
│      └── Mixture of Agents (multi-model synthesis)   │
└─────────────────────────────────────────────────────┘
```

---

## Reference: Cursor Decompilation

All extracted Cursor data is in `~/cursor-decompiled/` (17 files, 176KB). Key files:
- `server-prompts.md` — 7 server-side system prompt variants
- `server-tool-definitions.json` — 19 tool definitions captured from the model
- `harness-architecture.md` — How Cursor's harness achieves its speed
- `EXTRACTION-PLAYBOOK.md` — 14-step guide to re-extract after Cursor updates

The harness architecture in this codebase is modeled after Cursor's BiDi streaming tool loop with parallel execution, as documented in those files.

---

## Key Contacts

- **Original T3 Code:** https://github.com/pingdotgg/t3code (Theo/ping.gg)
- **Cursor decompilation data:** `~/cursor-decompiled/`
- **Memory system:** All project context is logged in mcp-memory (search for "CoahCode" or "cursor-decompiled")
