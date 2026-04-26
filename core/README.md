# YUME Core

Backend for the local-first YUME simulator. It runs on Bun, talks to Anthropic Managed Agents, stores simulation history in SQLite, and streams run events to the web UI over SSE.

## Setup

```bash
bun install
[ -f .env.local ] || cp .env.example .env.local
# Edit .env.local and set ANTHROPIC_API_KEY.
bun run setup:agents
```

`setup:agents` provisions Managed Agents resources for the selected model/speed and writes generated non-secret IDs to `core/data/managed-agents.json`. That registry is local-only and ignored by git; `.env.local` should contain secrets and optional defaults only.

Set `YUME_DEFAULT_MODEL_ID` and `YUME_DEFAULT_MODEL_SPEED=standard|fast` if you want a default other than Opus 4.7. Each run can still override model and speed from the web UI. Managed Agents does not expose a separate effort setting in this app.

To pre-create a lower-cost profile explicitly:

```bash
bun run setup:agents --model claude-haiku-4-5 --speed standard
```

## Run

```bash
bun run server
```

The server listens on `http://localhost:3001`.

## Structure

- `src/server/`: local HTTP API, request limits, CORS, SSE
- `src/design-orchestrator.ts`: main simulation loop and turn commit logic
- `src/agents/`: Managed Agents prompt builders and request/response types
- `src/config/`: model/env config and personality trait loaders
- `config/personality-traits.json`: editable behavior traits used for actor role-play
- `scripts/`: setup and demo CLI entrypoints
- `src/simulation-engine.ts`: deterministic action effects and local state updates
- `src/simulator-store.ts`: local SQLite run history
