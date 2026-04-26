import { buildReplayState, runSimulation } from "../orchestrator";
import { createManagedAgentsDriverFromEnv } from "../managed-agents-driver";
import { SimulatorStore } from "../simulator-store";
import type {
  Actor,
  Event,
  Location,
  RunInput,
  SimState,
} from "../schema";

export type EventListener = (ev: Event) => void;

export type RunHandle = {
  id: string;
  input: RunInput;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  createdAt: string;
  updatedAt: string;
  events: Event[];
  state: SimState | null;
  actors: Actor[];
  locations: Location[];
  listeners: Set<EventListener>;
  abortController: AbortController;
  cancelRequested: boolean;
  cancelledEventEmitted: boolean;
  error?: string;
  ready: Promise<void>;
};

/**
 * In-memory registry for active HTTP clients.
 * SQLite is the authoritative simulation ledger; this map only keeps live
 * handles, listeners, and the last in-process state for HTTP polling/SSE.
 */
const runs = new Map<string, RunHandle>();

export function getRun(id: string): RunHandle | undefined {
  return runs.get(id);
}

export function listRuns() {
  const liveSummaries = new Map(Array.from(runs.values()).map((handle) => [handle.id, summarizeHandle(handle)]));
  const store = new SimulatorStore();
  try {
    const persisted = store.listRuns().map((row) => summarizePersistedRun(row));
    for (const [id, summary] of liveSummaries) {
      const index = persisted.findIndex((candidate) => candidate.id === id);
      if (index >= 0) persisted[index] = { ...persisted[index], ...summary };
      else persisted.push(summary);
    }
    return persisted.sort((a, b) => runSummaryRank(a.status) - runSummaryRank(b.status) || b.created_at.localeCompare(a.created_at));
  } finally {
    store.close();
  }
}

export function getPersistedRunResponse(id: string) {
  const store = new SimulatorStore();
  try {
    const row = store.getRun(id);
    if (!row) return undefined;
    const input = JSON.parse(row.input_json) as RunInput;
    const events = store.getEvents(id);
    const state = buildReplayState(input, { runId: row.id, events });
    return {
      id: row.id,
      status: normalizePersistedStatus(row.status, row.error),
      events_count: events.length,
      actors: state.actors,
      locations: state.locations,
      world: state.input.world ?? { locations: state.locations },
      relationships: extractRelationshipsFromState(state),
      state,
      error: row.error ?? undefined,
    };
  } finally {
    store.close();
  }
}

export function cancelRun(id: string): { handle: RunHandle | undefined; changed: boolean } {
  const handle = runs.get(id);
  if (!handle) return { handle: undefined, changed: false };
  if (isTerminalStatus(handle.status)) return { handle, changed: false };

  handle.cancelRequested = true;
  handle.status = "cancelled";
  handle.error = "Run cancelled by user";
  touch(handle);
  const event = emitCancelledEvent(handle);
  persistCancelledRun(handle.id, event);
  if (!handle.abortController.signal.aborted) {
    handle.abortController.abort(new Error(handle.error));
  }
  return { handle, changed: true };
}

/**
 * Allocates a RunHandle + starts `runSimulation` in the background. The
 * returned promise resolves as soon as setup (actor IDs, locations) is
 * available so the HTTP caller can return rich info immediately, while
 * the event stream continues in the background.
 */
export function createAndStartRun(input: RunInput): {
  handle: RunHandle;
  ready: Promise<void>;
} {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  let markReady!: () => void;
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });
  const handle: RunHandle = {
    id,
    input,
    status: "pending",
    createdAt: now,
    updatedAt: now,
    events: [],
    state: null,
    actors: [],
    locations: [],
    listeners: new Set(),
    abortController: new AbortController(),
    cancelRequested: false,
    cancelledEventEmitted: false,
    ready,
  };
  runs.set(id, handle);
  void startRun(handle, markReady).catch(() => {});
  return { handle, ready };
}

async function startRun(handle: RunHandle, markReady: () => void): Promise<void> {
  handle.status = "running";
  touch(handle);
  let setupReceived = false;
  let stateReceived = false;
  let readyMarked = false;
  const maybeMarkReady = () => {
    if (readyMarked || !setupReceived || !stateReceived) return;
    readyMarked = true;
    markReady();
  };

  try {
    const state = await runSimulation(handle.input, {
      runId: handle.id,
      signal: handle.abortController.signal,
      agentDriver: await createManagedAgentsDriverFromEnv({
        signal: handle.abortController.signal,
        modelId: handle.input.model_id,
        modelSpeed: handle.input.model_speed,
      }),
      onSetup: ({ actors, locations }) => {
        handle.actors = actors;
        handle.locations = locations;
        touch(handle);
        setupReceived = true;
        maybeMarkReady();
      },
      onState: (state) => {
        if (handle.cancelRequested) return;
        handle.state = state;
        touch(handle);
        stateReceived = true;
        maybeMarkReady();
      },
      onEvent: (ev) => {
        if (handle.cancelRequested) return;
        handle.events.push(ev);
        touch(handle);
        for (const l of handle.listeners) {
          try {
            l(ev);
          } catch {
            /* ignore */
          }
        }
      },
    });
    handle.state = state;
    if (handle.cancelRequested) {
      handle.status = "cancelled";
      touch(handle);
      emitCancelledEvent(handle);
      return;
    }
    handle.status = "completed";
    touch(handle);
  } catch (e) {
    if (handle.cancelRequested || isAbortError(e)) {
      handle.cancelRequested = true;
      handle.status = "cancelled";
      handle.error = "Run cancelled by user";
      touch(handle);
      emitCancelledEvent(handle);
      if (!readyMarked) {
        readyMarked = true;
        markReady();
      }
      return;
    }
    handle.status = "failed";
    handle.error = (e as Error).message;
    touch(handle);
    const last = handle.events.at(-1);
    const failedEvent: Event = {
      type: "run.failed",
      seq: (last?.seq ?? 0) + 1,
      day: last?.day ?? 1,
      slot: last?.slot ?? "morning",
      sim_hour: last?.sim_hour ?? 0,
      at_wall_clock: new Date().toISOString(),
      message: handle.error,
    };
    handle.events.push(failedEvent);
    touch(handle);
    for (const l of handle.listeners) {
      try {
        l(failedEvent);
      } catch {
        /* ignore */
      }
    }
    console.error(`run ${handle.id} failed:`, e);
    if (!readyMarked) {
      readyMarked = true;
      markReady();
    }
  }
}

function isTerminalStatus(status: RunHandle["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function emitCancelledEvent(handle: RunHandle): Event | undefined {
  if (handle.cancelledEventEmitted) return undefined;
  handle.cancelledEventEmitted = true;
  const last = handle.events.at(-1);
  const cancelledEvent: Event = {
    type: "run.cancelled",
    seq: (last?.seq ?? 0) + 1,
    day: last?.day ?? 1,
    slot: last?.slot ?? "morning",
    sim_hour: last?.sim_hour ?? 0,
    at_wall_clock: new Date().toISOString(),
    message: "Run cancelled by user",
  };
  handle.events.push(cancelledEvent);
  touch(handle);
  for (const listener of handle.listeners) {
    try {
      listener(cancelledEvent);
    } catch {
      /* ignore */
    }
  }
  return cancelledEvent;
}

function touch(handle: RunHandle): void {
  handle.updatedAt = new Date().toISOString();
}

function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const record = error as { name?: unknown; message?: unknown };
  return record.name === "AbortError" ||
    (typeof record.message === "string" && /aborted|cancelled|canceled/i.test(record.message));
}

function summarizeHandle(handle: RunHandle) {
  return {
    id: handle.id,
    status: handle.status,
    created_at: handle.createdAt,
    updated_at: handle.updatedAt,
    events_count: handle.events.length,
    title: handle.input.scenario?.title ?? "Simulation",
    description: handle.input.scenario?.description ?? "",
    period_days: handle.input.period_days,
    scenes_per_day: handle.input.scenes_per_day,
    actors_count: handle.actors.length || handle.input.actors?.length || 0,
    locations_count: handle.locations.length || handle.input.world?.locations?.length || 0,
    focus_actor_name: handle.actors.find((actor) => actor.id === handle.state?.focus_actor_id)?.display_name ??
      handle.actors.find((actor) => actor.is_focus)?.display_name ??
      handle.actors[0]?.display_name,
    error: handle.error,
  };
}

function summarizePersistedRun(row: ReturnType<SimulatorStore["listRuns"]>[number]) {
  const input = JSON.parse(row.input_json) as RunInput;
  let focusActorName: string | undefined;
  try {
    const state = buildReplayState(input, { runId: row.id });
    focusActorName = state.actors.find((actor) => actor.id === state.focus_actor_id)?.display_name;
  } catch {
    focusActorName = input.actors?.find((actor) => actor.is_focus)?.display_name ?? input.actors?.[0]?.display_name;
  }
  return {
    id: row.id,
    status: normalizePersistedStatus(row.status, row.error),
    created_at: row.created_at,
    updated_at: row.updated_at,
    events_count: Number(row.events_count ?? 0),
    title: input.scenario?.title ?? "Simulation",
    description: input.scenario?.description ?? "",
    period_days: input.period_days,
    scenes_per_day: input.scenes_per_day,
    actors_count: input.actors?.length ?? 0,
    locations_count: input.world?.locations?.length ?? 0,
    focus_actor_name: focusActorName,
    error: row.error ?? undefined,
  };
}

function normalizePersistedStatus(status: string, error?: string | null): RunHandle["status"] {
  if (status === "cancelled") return "cancelled";
  if (status === "failed" && error && /aborted|cancelled|canceled/i.test(error)) return "cancelled";
  if (status === "running" || status === "pending") return "failed";
  if (status === "completed" || status === "failed") return status;
  return "failed";
}

function runSummaryRank(status: string): number {
  return status === "running" || status === "pending" ? 0 : 1;
}

function extractRelationshipsFromState(state: SimState) {
  const actorStates = state.actor_states;
  if (!actorStates) return [];
  return Object.entries(actorStates).flatMap(([from, lifeState]) =>
    lifeState.relationships.map((relationship) => ({
      from,
      to: relationship.actor_id,
      closeness: relationship.closeness,
      trust: relationship.trust,
      tension: relationship.tension,
      last_interaction_day: relationship.last_interaction_day,
    })),
  );
}

function persistCancelledRun(runId: string, event: Event | undefined): void {
  const store = new SimulatorStore();
  try {
    store.cancelRun(runId, "Run cancelled by user", event);
  } finally {
    store.close();
  }
}
