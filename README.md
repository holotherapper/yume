# YUME

[![Built for Built with Opus 4.7 Hackathon](https://img.shields.io/badge/Built%20for-Built%20with%20Opus%204.7%20Hackathon-D97757?logo=anthropic&logoColor=white)](https://cerebralvalley.ai/e/built-with-4-7-hackathon)

YUME is a local AI life-simulation app. A Bun backend runs the simulation,
creates one Anthropic Managed Agents session per actor, applies deterministic
state changes, stores run data in SQLite, and streams events to a React/Three.js
frontend. The frontend starts runs, follows live server-sent events, displays
actor state and relationships, and replays the city timeline in 3D.

## Architecture

| Layer | Path | Runtime | Default port | Responsibility |
|---|---|---|---:|---|
| Backend | `core/` | Bun + TypeScript | `3001` | HTTP API, simulation loop, Managed Agents, SQLite, SSE |
| Frontend | `web/` | Vite + React + Three.js | `8080` | Setup UI, live event stream, actor panels, 3D replay |
| Sample data | `web/sample-data/` | JSON | n/a | Example actors and locations |

Important backend files:

- `core/src/server.ts`: HTTP routes, env loading, request parsing, run creation.
- `core/src/server/sse.ts`: server-sent event streaming and replay.
- `core/src/schema.ts`: Zod schemas for run input, state, and events.
- `core/src/design-orchestrator.ts`: main simulation loop.
- `core/src/simulation-engine.ts`: local state transitions and action effects.
- `core/src/simulator-config.ts`: defaults, thresholds, slots, action rules.
- `core/src/managed-agents-driver.ts`: Anthropic Managed Agents sessions,
  memory stores, turn requests, interaction evaluation.
- `core/src/simulator-store.ts`: SQLite persistence.
- `web/src/App.tsx`: top-level React app and run UI.
- `web/src/api/client.ts`: backend client, SSE subscription, event mapping.
- `web/src/scene/YumeScene.ts`: Three.js city renderer and replay scene.

## Requirements

- Bun.
- An Anthropic API key for real simulation runs.
- Local browser access to the Vite frontend.

The backend is local-first. Its CORS implementation only allows origins starting
with `http://localhost` or `http://127.0.0.1`.

## Setup

Install dependencies:

```sh
cd core
bun install

cd ../web
bun install
```

Create a backend env file and set your API key:

```sh
cd ../core
cp .env.example .env.local
# edit core/.env.local and set ANTHROPIC_API_KEY
```

Optional: pre-create Managed Agents resources:

```sh
cd core
bun run setup:agents
```

The setup script writes non-secret resource IDs to
`core/data/managed-agents.json`. Secrets should stay in `.env.local`.

## Run

Start the backend:

```sh
cd core
bun run server
```

Start the frontend in a second terminal:

```sh
cd web
bun run dev
```

Open:

```text
http://localhost:8080/
```

If backend port `3001` is unavailable:

```sh
cd core
PORT=3101 bun run server

cd ../web
VITE_YUME_API_BASE=http://localhost:3101 bun run dev -- --port 8081
```

Root scripts:

| Command | What it runs |
|---|---|
| `bun run dev` | frontend only: `cd web && bun run dev` |
| `bun run dev:web` | frontend only |
| `bun run dev:core` | backend only |
| `bun run build` | frontend production build |
| `bun run typecheck` | backend typecheck, then frontend typecheck |
| `bun run check` | typecheck both projects, then build frontend |

## Environment

The backend loads environment variables from `core/.env` and `core/.env.local`.

Backend variables:

| Variable | Default | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | none | Required for Managed Agents setup and runs |
| `HOST` | `127.0.0.1` | Bun server host |
| `PORT` | `3001` | Bun server port |
| `YUME_MAX_REQUEST_BYTES` | `1000000` | Maximum JSON request body size |
| `YUME_SQLITE_PATH` | `core/data/yume.sqlite` | SQLite database path |
| `YUME_DEFAULT_MODEL_ID` | `claude-opus-4-7` in `.env.example` | Default run model |
| `YUME_SIMULATOR_MODEL_ID` | none | Alias for `YUME_DEFAULT_MODEL_ID` |
| `YUME_DEFAULT_MODEL_SPEED` | `standard` in `.env.example` | Default model speed |
| `YUME_SIMULATOR_MODEL_SPEED` | none | Alias for `YUME_DEFAULT_MODEL_SPEED` |
| `YUME_MANAGED_AGENTS_ENVIRONMENT_ID` | none | Reuse an existing Managed Agents environment |
| `YUME_WORLD_MEMORY_STORE_ID` | none | Reuse shared world memory |
| `YUME_RUN_CONTEXT_MEMORY_STORE_ID` | none | Reuse run-context memory |
| `YUME_DEFAULT_ACTOR_MEMORY_STORE_ID` | none | Reuse default actor memory |
| `YUME_DEFAULT_RELATIONSHIP_MEMORY_STORE_ID` | none | Reuse default relationship memory |
| `YUME_FOCUS_ACTOR_AGENT_ID` | none | Reuse focus actor agent if model/speed match |
| `YUME_PROTAGONIST_AGENT_ID` | none | Alias for `YUME_FOCUS_ACTOR_AGENT_ID` |
| `YUME_DEFAULT_ACTOR_AGENT_ID` | none | Reuse default actor agent if model/speed match |
| `YUME_SUPPORTING_AGENT_ID` | none | Alias for `YUME_DEFAULT_ACTOR_AGENT_ID` |
| `YUME_ACTOR_MEMORY_STORE_IDS_JSON` | none | JSON map of actor IDs to memory store IDs |
| `YUME_RELATIONSHIP_MEMORY_STORE_IDS_JSON` | none | JSON map of actor IDs to relationship memory store IDs |
| `YUME_DEBUG_LOGS` | none | Enables orchestrator debug logs |
| `YUME_SIM_DEBUG` | none | Enables orchestrator debug logs |
| `PERIOD_DAYS` | `3` | Used by `core/scripts/demo-run.ts` |

Frontend variable:

| Variable | Default | Purpose |
|---|---|---|
| `VITE_YUME_API_BASE` | `http://localhost:3001` | Backend API base URL |

Generated local state is ignored by git:

- `core/data/`
- `core/runs/`
- `core/tmp/`
- `.env`
- `.env.local`

## Supported Models

Supported model IDs:

- `claude-haiku-4-5`
- `claude-haiku-4-5-20251001`
- `claude-sonnet-4-6`
- `claude-opus-4-7`

Supported speeds:

- `standard`
- `fast`

Each run can pass `model_id` and `model_speed`. If omitted, the backend uses the
environment defaults, then falls back to `claude-opus-4-7` and `standard`.

Each run uses a single model and speed throughout.

## Managed Agents

`bun run setup:agents` provisions or reuses:

- one cloud Managed Agents environment;
- shared world memory store;
- shared run-context memory store;
- default actor memory store;
- default relationship memory store;
- one focus actor agent;
- one default actor agent.

Created environments run in a sandboxed configuration. Created agents use
the selected model and speed, `agent_toolset_20260401`, and memory read/write
tools.

Profiles are stored in `core/data/managed-agents.json` with keys:

```text
{modelId}__{speed}
```

If a selected profile is missing, the first run can provision it automatically.

During a run the driver:

1. opens one Managed Agents session per actor;
2. attaches shared world and run-context memories as read-only resources;
3. attaches actor and relationship memories as read-write resources;
4. sends each active actor a JSON-only turn prompt;
5. validates the returned run ID, turn ID, and selected action;
6. optionally asks an evaluator prompt to score interactions;
7. records episodic, relationship, and summary memory updates.

Memory write paths used by the implementation:

- `/rules/simulation.md`
- `/memories/episodic/{turnId}-{agentId}.md`
- `/relationships/{targetActorId}.md`
- `/summaries/month_###.md`

## HTTP API

The backend server is implemented with `Bun.serve`.

| Endpoint | Method | Behavior |
|---|---|---|
| `/health` | `GET` | Returns plain text `ok` |
| `/runs` | `GET` | Lists live and persisted runs |
| `/runs` | `POST` | Validates input, checks cost risk, starts a run |
| `/runs/:id` | `GET` | Returns live run state or persisted run response |
| `/runs/:id/cancel` | `POST` | Cancels an in-memory live run |
| `/runs/:id/events` | `GET` | Opens SSE stream for a live run |

`POST /runs` responses:

- `400`: invalid JSON or invalid `RunInput`;
- `413`: request body exceeds `YUME_MAX_REQUEST_BYTES`;
- `409`: cost risk acknowledgement required;
- `500`: run failed before initial state became available.

Successful run creation returns the run ID, status, event count, actors,
locations, world, relationships, and current state.

SSE behavior:

- emits `retry: 3000`;
- supports `Last-Event-ID`;
- replays buffered events with higher sequence numbers;
- sends a keepalive comment every `15000` ms;
- closes on `run.complete`, `run.failed`, or `run.cancelled`.

## Run Input

The input schema is defined in `core/src/schema.ts`.

Top-level fields:

| Field | Behavior |
|---|---|
| `model_id` | Optional model override |
| `model_speed` | Optional speed override |
| `actors` | Generic actor list |
| `focus_actor_id` | Explicit focus actor selector |
| `scenario` | Scenario and decision context |
| `world` | Locations, buildings, paths, layout, description |
| `scheduler` | Accepted scheduler config |
| `protagonist` | Single-protagonist input |
| `supporting` | Supporting actors, default `[]` |
| `decision_context` | Stored with the run when present |
| `mode` | `day` or `life`, default `day` |
| `period_days` | Default `3`, range `1..30` |
| `period_months` | Range `1..3` |
| `scenes_per_day` | Default `4`, range `1..8` |
| `seed` | Optional deterministic seed |
| `config` | Runtime flags such as `cost_risk_acknowledged` |

Either `actors` or `protagonist` is required.

Important limits:

| Item | Limit |
|---|---:|
| ID string | 128 chars |
| label string | 256 chars |
| text field | 8000 chars |
| list field | 50 items |
| actors | 100 |
| supporting actors | 20 |
| locations | 200 |
| buildings | 200 |
| paths | 1000 |
| period days | 30 |
| period months | 3 |
| scenes per day | 8 |

Generic actor fields include ID/name/display name, role, focus flag, age,
gender, MBTI code, profile, values, interests, fears, goals, constraints,
relationship description, memo, schedule, initial state, initial location, and
metadata.

Supported personality codes are the 16 standard values:

```text
INTJ INTP ENTJ ENTP INFJ INFP ENFJ ENFP
ISTJ ISFJ ESTJ ESFJ ISTP ISFP ESTP ESFP
```

If omitted, personality type is assigned deterministically from role and index.
Agents receive derived behavior traits from `core/config/personality-traits.json`.

## World and Schedule

Weekdays:

```text
Mon Tue Wed Thu Fri Sat Sun
```

Slots and backend simulated hours:

| Slot | Hour |
|---|---:|
| `morning` | `7` |
| `noon` | `12` |
| `evening` | `18` |
| `night` | `22` |

World input supports:

- locations with ID, display name, description, residents, kind, building ID,
  position, and metadata;
- buildings with ID, display name, kind, description, position, size, floors,
  capacity, residents, tags, and metadata;
- paths with from/to IDs, distance, travel time, mode, bidirectionality, and
  metadata;
- layout mode `free` or `grid`.

If no locations are supplied, the backend creates default locations:

- `home`
- `workplace` or `school`
- `cafe`
- `park`

`school` is used when the focus actor profile looks student-like. If buildings
exist but locations do not, buildings are converted into locations.

Actor initial location priority:

1. valid `initial_location_id`;
2. resident location;
3. valid `Mon.morning` schedule location;
4. first location;
5. `home`.

## Simulation Loop

Mode duration:

| Mode | Duration |
|---|---|
| `day` | `period_days` |
| `life` | at least `30` days, otherwise `period_months * 30` |

The orchestrator runs up to 4 slots per day. All actors participate in every turn.

Actor requests run in batches of up to 10 concurrent requests. Each request has
a 90-second timeout and 1 retry. If an actor is still unreachable, the run emits
`agent.unavailable` and continues without that actor for the turn.

## Actor State and Actions

Life state tracks money, monthly income, monthly expenses, energy, health,
stress, mood, job satisfaction, skills, and relationships.

Default starting state:

| Field | Value |
|---|---:|
| money | `500000` |
| monthly income | `250000` |
| monthly expenses | `180000` |
| energy | `80` |
| health | `75` |
| stress | `30` |
| mood | `60` |
| job satisfaction | `50` |

Profile keywords adjust these defaults. For example, student-like profiles lower
money and income, freelance-like profiles raise money and income, medical
profiles lower job satisfaction, and distress keywords raise stress and lower
energy.

Available action rules:

| Action | Availability |
|---|---|
| `work` | energy > 15 and slot is morning/noon |
| `exercise` | energy > 25 |
| `eat_out` | money > 2000 and slot is noon/evening |
| `study` | energy > 20 |
| `socialize` | energy > 10 and another actor is local or reachable |
| `reach_out` | energy > 10 and a relationship is reachable |
| `sleep` | night slot |
| `rest`, `cook`, `save_money`, `consider_decision`, `maintenance` | always available |

Core action effects:

| Action | Deterministic effect |
|---|---|
| `work` | money + monthly_income/20, energy -20, stress +8 or +15 |
| `rest` | energy +30, stress -10, mood +5 |
| `exercise` | energy -25, health +3, stress -15, mood +10 |
| `eat_out` | money -1500, energy +15, mood +5 or +10 |
| `cook` | energy +15, mood +8 |
| `study` | energy -15, stress +5, mood -3, selected skill +3 |
| `socialize` | energy -10, stress -12, mood +15 |
| `reach_out` | energy -3, stress -5, mood +5 |
| `save_money` | money +2500, energy -5, stress -3, mood -2 |
| `consider_decision` | energy -8, stress -4, mood +2, job satisfaction -1 |
| `maintenance` | money -1000, energy -8, health +2, stress -4 |
| `sleep` | energy recovers up to 50, stress -5, health +/- depending on exhaustion |

Meters are clamped to `0..100` during action effects. Action money changes are
clamped at zero.

Movement rules:

- home-like actions return to resident/home location when possible;
- `work` and `study` use the current schedule location when valid;
- other actions stay at the current location.

Travel penalty is:

```text
round(min(20, distance / 50))
```

It subtracts energy and adds `round(penalty / 3)` stress.

## Relationships and Events

Relationship state tracks closeness, trust, tension, last interaction day, and
notes. New relationships start at closeness `12`, trust `30`, tension `0`.

Interactions can be explicit (`socialize`, `reach_out`) or spontaneous between
actors at the same projected location. Spontaneous interactions are deterministic
from seed/turn/location/pair data and are capped at 12 per turn.

Interaction evaluation accepts relationship and actor-state deltas. Relationship
deltas are clamped to magnitude 15, actor-state deltas to magnitude 12. Low
confidence evaluations below 0.45 become neutral fallback evaluations.

Backend event types:

```text
day.start slot.start decision scene.start utterance internal_reaction
scene.end move transition reach_out state.update sim.event
agent.unavailable run.complete run.failed run.cancelled timeskip episode.start
```

The frontend displays utterances, internal reactions, movement, state updates,
simulation events, reach-outs, completion, failure, and cancellation.

Monthly update every 30 simulated days:

- money += monthly income - monthly expenses;
- relationship closeness -2;
- relationship last interaction day +30;
- stress +20 when money is below monthly expenses;
- health -5 when stress is above 80;
- monthly summary memory is written.

Deterministic trigger checks include burnout risk, health crisis, decision
pressure, low mood, relationship conflict, relationship drift, financial
security, stress slip, and social invitation.

## Persistence

SQLite database default:

```text
core/data/yume.sqlite
```

The store enables WAL and foreign keys.

Tables:

```text
runs turns world_state_snapshots events relationships pending_changes
agent_sessions memory_versions action_logs decision_contexts
```

Run statuses:

```text
running completed failed cancelled
```

Incomplete runs from a previous process are marked `failed` on next listing.
On completion, `runs.final_state_json` stores the focus actor's final state.
Persisted run responses are reconstructed from stored input and events.

## Cost Risk Guard

The backend estimates actor turns:

```text
period_days * scenes_per_day * max(1, actor_count)
```

Risk levels:

- `normal`: below thresholds;
- `elevated`: actor turns >= 300, actor count >= 50, or period >= 7 days;
- `high`: Opus with actor turns >= 80, actor count >= 50, or period >= 7 days.

Non-normal risk requires:

```json
{
  "config": {
    "cost_risk_acknowledged": true
  }
}
```

Otherwise `POST /runs` returns `409`.

## Frontend and 3D Replay

Sample data is available under `web/sample-data/` (50 actors, 71 locations).
The frontend form starts empty.

Current default form values include:

- mode `day`;
- 3 days;
- 4 scenes per day;
- model `claude-opus-4-7`;
- speed `standard`;
- empty `world.paths`;
- scheduler `background_update_interval_turns: 1`.

The UI supports setup, connecting, running, completed, failed, and cancelled
phases. It can start runs, cancel live runs, list recent runs, open persisted
runs, subscribe to live SSE, filter events by actor/type, show focus actor
meters, show relationships, scrub the timeline, and follow the latest event.

The Three.js scene:

- uses provided positions when present;
- otherwise computes a force layout from paths;
- renders ground, grid, buildings, labels, proximity lines, and actors;
- supports left-drag orbit, right-drag pan, mouse-wheel zoom, and actor picking;
- animates actor movement over 1600 ms;
- uses app settings `mode: research`, `camera: isometric`, `actorStyle: pillar`.

Renderer modes: `research`, `clay`, `night`, `topo`, and `blueprint`.

Replay applies raw events up to the selected tick for movement, scene start,
state updates, and relationship deltas embedded in state updates.

## CLI Demo

```sh
cd core
bun run demo
```

The demo uses the protagonist path with an Ayaka scenario, `seed: 7`,
`scenes_per_day: 4`, and `PERIOD_DAYS` defaulting to 3. It saves output under:

```text
core/runs/run-{timestamp}.json
```

## Verify

Run all configured checks:

```sh
bun run check
```

This type-checks backend and frontend, then builds the frontend.

## License

MIT. See `LICENSE`.
