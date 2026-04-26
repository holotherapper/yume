import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_SUPPORTING_ACTORS,
  DEFAULT_ROLE_PROFILE,
  INITIAL_STATE_DEFAULTS,
  INTERACTION_EVALUATION_RULES,
  LOCATION_PROFILE_PATTERNS,
  LOCATION_TEMPLATES,
  MBTI_BEHAVIOR_GUIDE,
  MBTI_TYPES,
  ORCHESTRATOR_LIMITS,
  ORCHESTRATOR_PROTOCOL,
  ROLE_DEFAULTS,
  SIMULATION_BOUNDS,
  SUPPORTING_ACTOR_INFERENCE,
  TIME_SLOTS,
  WEEKDAYS,
  resolveRunModelId,
  resolveRunModelSpeed,
  type SupportedModelId,
} from "./simulator-config";
import {
  applyAction,
  checkEventTriggers,
  createInitialState,
  getAvailableActions,
  LifeState as LifeStateSchema,
  monthlyUpdate,
  type ActionEffect,
  type AvailableAction,
  type LifeState,
  type SimAction,
} from "./simulation-engine";
import { createManagedAgentsDriverFromEnv } from "./managed-agents-driver";
import { SimulatorStore } from "./simulator-store";
import { RunInput as RunInputSchema } from "./schema";
import type {
  AgentAvailableAction,
  ActorLocationMap,
  AgentActorProfile,
  AgentDriver,
  AgentKnownActor,
  AgentObservedState,
  AgentScheduleUpdate,
  AgentTurnRequest,
  AgentTurnResponse,
  AgentWorldContext,
  InteractionEvaluationRequest,
  InteractionEvaluationResponse,
  InteractionOutcome,
} from "./agents/types";
import type {
  Actor,
  ActorRole,
  ActorSession,
  Event,
  Location,
  MBTIType,
  RunInput,
  SimState,
  SupportingActorInput,
  TimeSlot,
  Weekday,
  WorldBuilding,
  WorldPath,
} from "./schema";

export type {
  AgentActorProfile,
  AgentDriver,
  AgentDriverSetup,
  AgentObservedState,
  AgentTurnRequest,
  AgentTurnResponse,
  AgentWorldContext,
  InteractionEvaluationRequest,
  InteractionEvaluationResponse,
  InteractionOutcome,
} from "./agents/types";

export type DesignOrchestratorOptions = {
  runId?: string;
  store?: SimulatorStore;
  agentDriver?: AgentDriver;
  signal?: AbortSignal;
  debug?: boolean;
  onEvent?: (event: Event) => void;
  onDebug?: (record: SimulationDebugRecord) => void;
  onSetup?: (handle: {
    environmentId: string;
    actorSessions: ActorSession[];
    actors: Actor[];
    locations: Location[];
  }) => void;
  onState?: (state: SimState) => void;
};

export type SimulationDebugRecord = {
  type: "yume.debug";
  kind: string;
  run_id: string;
  turn_id?: string;
  day?: number;
  slot?: TimeSlot;
  sim_hour?: number;
  actor_id?: string;
  at_wall_clock: string;
  message: string;
  data?: Record<string, unknown>;
};

type SimulationDebugInput = Omit<SimulationDebugRecord, "type" | "run_id" | "at_wall_clock">;
type SimulationDebugLogger = (record: SimulationDebugInput) => void;

type SchedulerRuntimeSettings = {
  maxActiveActorsPerTurn: number;
  backgroundUpdateIntervalTurns: number;
};

type ParsedRunInput = ReturnType<typeof RunInputSchema.parse>;

type SchedulerPlan = {
  participants: string[];
  observers: string[];
  background_agents: string[];
  inactive_agents: string[];
};

type ActorTurnRecord = {
  actor: Actor;
  availableActions: AvailableAction[];
  response: AgentTurnResponse;
  selected: SimAction;
  worldContext?: AgentWorldContext;
};

type InteractionPlan = {
  initiatorActorId: string;
  targetActorId: string;
  selected: SimAction;
  initiatorResponse: AgentTurnResponse;
  targetResponse?: AgentTurnResponse;
  locationId: string;
  worldContext?: AgentWorldContext;
  spontaneous?: boolean;
};

export async function runDesignSimulation(
  input: RunInput,
  opts: DesignOrchestratorOptions = {},
): Promise<SimState> {
  throwIfAborted(opts.signal);
  const parsedRunInput = RunInputSchema.parse(input);
  const runModelId = resolveRunModelId(parsedRunInput.model_id);
  const runModelSpeed = resolveRunModelSpeed(parsedRunInput.model_speed);
  const runInput = { ...parsedRunInput, model_id: runModelId, model_speed: runModelSpeed };
  const runId = opts.runId ?? crypto.randomUUID();
  const store = opts.store ?? new SimulatorStore();
  const actors = buildActors(runInput, runModelId);
  const focusActor = actors.find((actor) => actor.is_focus) ?? actors[0];
  if (!focusActor) throw new Error("Focus actor is missing");

  const locations = buildLocations(runInput, focusActor, actors);
  const scheduler = buildSchedulerRuntime(runInput);
  const mode = runInput.mode ?? "day";
  const periodDays = runInput.period_days ?? ORCHESTRATOR_LIMITS.default_period_days;
  const scenesPerDay = runInput.scenes_per_day ?? ORCHESTRATOR_LIMITS.default_scenes_per_day;
  const agentDriver: AgentDriver = opts.agentDriver
    ?? await createManagedAgentsDriverFromEnv({ signal: opts.signal, modelId: runModelId, modelSpeed: runModelSpeed });
  throwIfAborted(opts.signal);
  const agentSetup = await agentDriver.setup({ runId, input: runInput, actors });
  throwIfAborted(opts.signal);
  const actorSessions = agentSetup.actorSessions;
  const maxDays = mode === "life"
    ? Math.max(ORCHESTRATOR_LIMITS.min_life_days, (runInput.period_months ?? 1) * ORCHESTRATOR_LIMITS.days_per_month)
    : periodDays;
  const turnsPerDay = Math.min(scenesPerDay, TIME_SLOTS.length);

  const actorStates = createInitialActorStates(actors);
  const actorLocations = createInitialActorLocations(runInput, locations, actors);
  let seq = ORCHESTRATOR_LIMITS.initial_sequence;
  let turnIndex = ORCHESTRATOR_LIMITS.initial_turn_index;
  const events: Event[] = [];
  const debug = createDebugLogger(runInput, opts, runId);

  store.createRun(runId, runInput);
  for (const session of actorSessions) {
    store.recordAgentSession({
      runId,
      actorId: session.actor_id,
      agentId: session.agent_id,
      sessionId: session.session_id,
      memoryStoreId: session.memory_store_id,
      worldMemoryStoreId: session.world_memory_store_id,
      runContextMemoryStoreId: session.run_context_memory_store_id,
      relationshipMemoryStoreId: session.relationship_memory_store_id,
    });
  }

  opts.onSetup?.({
    environmentId: agentSetup.environmentId,
    actorSessions,
    actors,
    locations,
  });
  debug({
    kind: "run.setup",
    message: "Simulation setup completed.",
    data: {
      mode,
      max_days: maxDays,
      turns_per_day: turnsPerDay,
      focus_actor_id: focusActor.id,
      actor_ids: actors.map((actor) => actor.id),
      location_ids: locations.map((location) => location.id),
      actor_locations: { ...actorLocations },
      scheduler,
      managed_environment_id: agentSetup.environmentId,
      session_count: actorSessions.length,
    },
  });

  const emit = (event: Event) => {
    events.push(event);
    store.insertEvent(runId, event);
    opts.onEvent?.(event);
    debug({
      kind: "event.emit",
      turn_id: "turn_id" in event ? event.turn_id : undefined,
      day: event.day,
      slot: event.slot,
      sim_hour: event.sim_hour,
      message: `Event emitted: ${event.type}.`,
      data: { event },
    });
  };
  const nextSeq = () => ++seq;
  const wallClock = () => new Date().toISOString();

  const simState: SimState = {
    run_id: runId,
    input: runInput,
    actors,
    locations,
    focus_actor_id: focusActor.id,
    protagonist_id: focusActor.id,
    current_day: 1,
    current_slot: "morning",
    current_sim_hour: TIME_SLOTS[0]!.hour,
    current_location_id: actorLocations[focusActor.id]!,
    life_state: actorStates[focusActor.id]!,
    actor_states: cloneActorStates(actorStates),
    actor_locations: { ...actorLocations },
    events,
    cost_usd: ORCHESTRATOR_LIMITS.default_cost_usd,
    managed_agents: {
      environment_id: agentSetup.environmentId,
      actor_sessions: actorSessions,
    },
  };
  opts.onState?.(simState);

  try {
    for (let day = 1; day <= maxDays; day++) {
      throwIfAborted(opts.signal);
      const weekday = WEEKDAYS[(day - 1) % WEEKDAYS.length]!;
      simState.current_day = day;
      emit({
        type: "day.start",
        seq: nextSeq(),
        day,
        slot: "morning",
        sim_hour: TIME_SLOTS[0]!.hour,
        at_wall_clock: wallClock(),
        weekday,
      });

      for (let slotIndex = 0; slotIndex < turnsPerDay; slotIndex++) {
        throwIfAborted(opts.signal);
        const clock = TIME_SLOTS[slotIndex]!;
        turnIndex += 1;
        const turnId = `${ORCHESTRATOR_PROTOCOL.day_turn_prefix}_${pad(day)}_${clock.slot}`;

        const actorStatesBefore = cloneActorStates(actorStates);
        const actorLocationsBefore = { ...actorLocations };
        const focusLocationId = actorLocationsBefore[focusActor.id]!;
        const schedulerPlan = buildSynchronousSchedulerPlan(actors, turnIndex, scheduler);
        const availableActionsByActor = buildAvailableActionsByActor(actors, actorStatesBefore, actorLocationsBefore, clock.slot);
        const focusAvailableActions = availableActionsByActor.get(focusActor.id) ?? [];
        const focusWorldContext = buildAgentWorldContext(runInput, locations, focusLocationId);

        simState.current_day = day;
        simState.current_slot = clock.slot;
        simState.current_sim_hour = clock.hour;
        simState.current_location_id = focusLocationId;
        simState.life_state = actorStatesBefore[focusActor.id];
        simState.actor_states = cloneActorStates(actorStates);
        simState.actor_locations = { ...actorLocations };
        opts.onState?.(simState);

        const snapshot = buildWorldSnapshot({
          runId,
          turnId,
          turnIndex,
          day,
          slot: clock.slot,
          hour: clock.hour,
          locationId: focusLocationId,
          focusActorId: focusActor.id,
          worldContext: focusWorldContext,
          state: actorStatesBefore[focusActor.id]!,
          actorStates: actorStatesBefore,
          actorLocations: actorLocationsBefore,
          events,
          availableActions: focusAvailableActions,
          availableActionsByActor,
        });
        debug({
          kind: "turn.start",
          turn_id: turnId,
          day,
          slot: clock.slot,
          sim_hour: clock.hour,
          message: "Synchronous city turn started.",
          data: {
            focus_location_id: focusLocationId,
            active_actor_ids: schedulerPlan.participants,
            inactive_actor_ids: schedulerPlan.inactive_agents,
            actor_locations: actorLocationsBefore,
            focus_state: summarizeStateForDebug(actorStatesBefore[focusActor.id]!),
            available_actions_by_actor: Object.fromEntries(
              [...availableActionsByActor.entries()].map(([actorId, actions]) => [
                actorId,
                availableActionsForDebug(actions),
              ]),
            ),
            world_context: summarizeWorldContextForDebug(focusWorldContext),
            recent_event_types: events.slice(-ORCHESTRATOR_LIMITS.recent_event_count).map((event) => event.type),
          },
        });

        store.beginTurn({
          runId,
          turnId,
          turnIndex,
          day,
          slot: clock.slot,
          simHour: clock.hour,
          worldSnapshot: snapshot,
        });

        emit({
          type: "slot.start",
          seq: nextSeq(),
          day,
          slot: clock.slot,
          sim_hour: clock.hour,
          at_wall_clock: wallClock(),
          time_of_day_label: `${formatHour(clock.hour)} synchronized city turn`,
        });

        try {
          store.recordPendingChange({
            runId,
            turnId,
            source: "scheduler",
            kind: "scheduler",
            payload: schedulerPlan,
          });
          debug({
            kind: "scheduler.plan",
            turn_id: turnId,
            day,
            slot: clock.slot,
            sim_hour: clock.hour,
            message: "Scheduler selected synchronized active actors.",
            data: schedulerPlan,
          });

          const turnSummary = await runSynchronousCityTurn({
            agentDriver,
            debug,
            runId,
            turnId,
            turnIndex,
            day,
            slot: clock.slot,
            hour: clock.hour,
            weekday,
            runInput,
            actors,
            locations,
            focusActorId: focusActor.id,
            schedulerPlan,
            actorStates,
            actorStatesBefore,
            actorLocations,
            actorLocationsBefore,
            availableActionsByActor,
            events,
            emit,
            nextSeq,
            wallClock,
            store,
            actorSessions,
          });
          throwIfAborted(opts.signal);
          const currentState = actorStates[focusActor.id]!;
          simState.current_location_id = actorLocations[focusActor.id]!;
          simState.life_state = currentState;
          simState.actor_states = cloneActorStates(actorStates);
          simState.actor_locations = { ...actorLocations };
          opts.onState?.(simState);

          store.commitTurn({
            runId,
            turnId,
            turnIndex,
            day,
            slot: clock.slot,
            simHour: clock.hour,
            worldSnapshot: snapshot,
            stateBefore: actorStatesBefore[focusActor.id]!,
            stateAfter: currentState,
            actorStatesAfter: cloneActorStates(actorStates),
            worldSnapshotAfter: {
              ...snapshot,
              life_state: currentState,
              actor_states: cloneActorStates(actorStates),
              actor_locations: { ...actorLocations },
            },
            summary: turnSummary.summary,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          store.failTurn(runId, turnId, message);
          throw error;
        }
      }

      if (day % ORCHESTRATOR_LIMITS.days_per_month === 0) {
        throwIfAborted(opts.signal);
        const actorStatesBeforeMonthly = cloneActorStates(actorStates);
        const monthlyEventsByActor: Array<{ actor: Actor; events: ReturnType<typeof monthlyUpdate>["events"] }> = [];
        for (const actor of actors) {
          const monthlyActor = monthlyUpdate(actorStates[actor.id]!);
          actorStates[actor.id] = monthlyActor.state;
          monthlyEventsByActor.push({ actor, events: monthlyActor.events });
        }
        simState.current_location_id = actorLocations[focusActor.id]!;
        simState.life_state = actorStates[focusActor.id]!;
        simState.actor_states = cloneActorStates(actorStates);
        simState.actor_locations = { ...actorLocations };
        opts.onState?.(simState);
        debugActorStateDeltas({
          debug,
          turnId: `${ORCHESTRATOR_PROTOCOL.day_turn_prefix}_${pad(day)}_${ORCHESTRATOR_PROTOCOL.monthly_turn_suffix}`,
          day,
          slot: "night",
          hour: ORCHESTRATOR_LIMITS.monthly_tick_hour,
          before: actorStatesBeforeMonthly,
          after: actorStates,
          actionsByActor: new Map(),
          source: "monthly_update",
        });
        for (const actor of actors) {
          await recordMonthlySummary({
            agentDriver,
            actorSessions,
            store,
            debug,
            runId,
            turnId: `${ORCHESTRATOR_PROTOCOL.day_turn_prefix}_${pad(day)}_${TIME_SLOTS[turnsPerDay - 1]!.slot}`,
            agentId: actor.id,
            monthIndex: Math.ceil(day / ORCHESTRATOR_LIMITS.days_per_month),
            state: actorStates[actor.id]!,
          });
        }
        for (const { actor, events: monthlyEvents } of monthlyEventsByActor) {
          for (const simEvent of monthlyEvents) {
            emit({
              type: "sim.event",
              seq: nextSeq(),
              day,
              slot: "night",
              sim_hour: ORCHESTRATOR_LIMITS.monthly_tick_hour,
              at_wall_clock: wallClock(),
              turn_id: `${ORCHESTRATOR_PROTOCOL.day_turn_prefix}_${pad(day)}_${ORCHESTRATOR_PROTOCOL.monthly_turn_suffix}`,
              actor_id: actor.id,
              sim_event_type: simEvent.type,
              severity: simEvent.severity,
              description: `${actor.display_name}: ${simEvent.description}`,
            });
          }
        }
      }

      if (day < maxDays) {
        throwIfAborted(opts.signal);
        emit({
          type: "transition",
          seq: nextSeq(),
          day,
          slot: "night",
          sim_hour: ORCHESTRATOR_LIMITS.monthly_tick_hour,
          at_wall_clock: wallClock(),
          kind: "sleep",
          note: "sleep -> next morning",
        });
      }
    }

    throwIfAborted(opts.signal);
    emit({
      type: "run.complete",
      seq: nextSeq(),
      day: maxDays,
      slot: "night",
      sim_hour: ORCHESTRATOR_LIMITS.monthly_tick_hour,
      at_wall_clock: wallClock(),
      summary: summarizePopulationRun(actorStates, events),
      turning_points: events
        .filter((event) => event.type === "sim.event" || event.type === "state.update")
        .slice(0, ORCHESTRATOR_LIMITS.turning_point_limit)
        .map((event) => ({
          day: event.day,
          slot: event.slot,
          description: event.type === "sim.event"
            ? event.description
            : `${event.action_type} changed the state`,
        })),
      final_state: finalPopulationStateLine(actorStates),
      decision_readout: runInput.decision_context?.question
        ? decisionReadout(runInput.decision_context.question, actorStates[focusActor.id]!, events)
        : undefined,
    });
    store.completeRun(runId, actorStates[focusActor.id]!);
    return simState;
  } catch (error) {
    if (isAbortError(error)) {
      store.cancelRun(runId, error instanceof Error ? error.message : String(error));
    } else {
      store.failRun(runId, error instanceof Error ? error.message : String(error));
    }
    throw error;
  }
}

export function buildReplayState(input: RunInput, args: { runId?: string; events?: Event[] } = {}): SimState {
  const parsedRunInput = RunInputSchema.parse(input);
  const runModelId = resolveRunModelId(parsedRunInput.model_id);
  const runModelSpeed = resolveRunModelSpeed(parsedRunInput.model_speed);
  const runInput = { ...parsedRunInput, model_id: runModelId, model_speed: runModelSpeed };
  const actors = buildActors(runInput, runModelId);
  const focusActor = actors.find((actor) => actor.is_focus) ?? actors[0];
  if (!focusActor) throw new Error("Focus actor is missing");
  const locations = buildLocations(runInput, focusActor, actors);
  const actorStates = createInitialActorStates(actors);
  const actorLocations = createInitialActorLocations(runInput, locations, actors);
  return {
    run_id: args.runId,
    input: runInput,
    actors,
    locations,
    focus_actor_id: focusActor.id,
    protagonist_id: focusActor.id,
    current_day: 1,
    current_slot: "morning",
    current_sim_hour: TIME_SLOTS[0]!.hour,
    current_location_id: actorLocations[focusActor.id]!,
    life_state: actorStates[focusActor.id]!,
    actor_states: cloneActorStates(actorStates),
    actor_locations: { ...actorLocations },
    events: args.events ?? [],
    cost_usd: ORCHESTRATOR_LIMITS.default_cost_usd,
  };
}

async function runSynchronousCityTurn(args: {
  agentDriver: AgentDriver;
  debug: SimulationDebugLogger;
  runId: string;
  turnId: string;
  turnIndex: number;
  day: number;
  slot: TimeSlot;
  hour: number;
  weekday: string;
  runInput: ParsedRunInput;
  actors: Actor[];
  locations: Location[];
  focusActorId: string;
  schedulerPlan: SchedulerPlan;
  actorStates: Record<string, LifeState>;
  actorStatesBefore: Record<string, LifeState>;
  actorLocations: ActorLocationMap;
  actorLocationsBefore: ActorLocationMap;
  availableActionsByActor: Map<string, AvailableAction[]>;
  events: Event[];
  emit: (event: Event) => void;
  nextSeq: () => number;
  wallClock: () => string;
  store: SimulatorStore;
  actorSessions: ActorSession[];
}): Promise<{ summary: string }> {
  const activeActorIds = new Set(args.schedulerPlan.participants);
  const activeActors = args.actors.filter((actor) => activeActorIds.has(actor.id));
  const records = await collectActorTurnRecords({ ...args, activeActors });
  const recordsByActor = new Map(records.map((record) => [record.actor.id, record]));
  const selectedActionsByActor = new Map(records.map((record) => [record.actor.id, record.selected]));
  const projectedActorLocations = resolveActorLocationsAfterActions({
    runInput: args.runInput,
    locations: args.locations,
    actors: args.actors,
    actorLocationsBefore: args.actorLocationsBefore,
    selectedActionsByActor,
    weekday: args.weekday,
    slot: args.slot,
  });
  const interactionPlans = buildInteractionPlans({
    records,
    recordsByActor,
    actors: args.actors,
    actorStates: args.actorStatesBefore,
    runInput: args.runInput,
    locations: args.locations,
    projectedActorLocations,
    turnId: args.turnId,
    day: args.day,
    slot: args.slot,
    hour: args.hour,
  });
  await collectMissingSceneResponses({
    ...args,
    plans: interactionPlans,
  });

  const interactionEvaluations: InteractionEvaluationResponse[] = [];
  for (const plan of interactionPlans) {
    const evaluation = await evaluateInteractionIfNeeded({
      agentDriver: args.agentDriver,
      debug: args.debug,
      runId: args.runId,
      turnId: args.turnId,
      turnIndex: args.turnIndex,
      day: args.day,
      slot: args.slot,
      hour: args.hour,
      locationId: plan.locationId,
      worldContext: plan.worldContext,
      actorStates: args.actorStatesBefore,
      actors: args.actors,
      events: args.events,
      selected: plan.selected,
      initiatorActorId: plan.initiatorActorId,
      initiatorResponse: plan.initiatorResponse,
      targetResponse: plan.targetResponse,
    });
    if (!evaluation) continue;
    interactionEvaluations.push(evaluation);
    args.store.recordPendingChange({
      runId: args.runId,
      turnId: args.turnId,
      source: evaluation.evaluator_id,
      kind: "interaction_evaluation",
      payload: evaluation,
    });
  }

  const actionEffectsByActor = new Map<string, ActionEffect>();
  const actionsByActor = new Map<string, SimAction>();
  for (const record of records) {
    const actorState = args.actorStates[record.actor.id];
    if (!actorState) continue;
    const applied = applyAction(actorState, record.selected);
    args.actorStates[record.actor.id] = applied.state;
    actionEffectsByActor.set(record.actor.id, applied.effect);
    actionsByActor.set(record.actor.id, record.selected);
  }
  for (const evaluation of interactionEvaluations) {
    applyInteractionEvaluation(args.actorStates, evaluation);
  }
  applyProjectedLocationsAndTravelCosts({
    runInput: args.runInput,
    locations: args.locations,
    actorStates: args.actorStates,
    actorLocations: args.actorLocations,
    actorLocationsBefore: args.actorLocationsBefore,
    projectedActorLocations,
    actionEffectsByActor,
  });
  applyProposedScheduleUpdates({
    records,
    locations: args.locations,
    day: args.day,
    slot: args.slot,
    hour: args.hour,
    turnId: args.turnId,
    emit: args.emit,
    nextSeq: args.nextSeq,
    wallClock: args.wallClock,
    store: args.store,
    debug: args.debug,
  });

  debugActorStateDeltas({
    debug: args.debug,
    turnId: args.turnId,
    day: args.day,
    slot: args.slot,
    hour: args.hour,
    before: args.actorStatesBefore,
    after: args.actorStates,
    actionsByActor,
  });

  emitTurnEvents({
    ...args,
    records,
    recordsByActor,
    interactionPlans,
    interactionEvaluations,
    actionEffectsByActor,
  });
  await recordTurnMemories({
    ...args,
    records,
    recordsByActor,
    interactionPlans,
    interactionEvaluations,
  });

  return {
    summary: records
      .map((record) => `${record.actor.id}: ${record.response.reasoning}`)
      .join("\n"),
  };
}

async function collectActorTurnRecords(args: {
  agentDriver: AgentDriver;
  debug: SimulationDebugLogger;
  runId: string;
  turnId: string;
  turnIndex: number;
  day: number;
  slot: TimeSlot;
  hour: number;
  actors: Actor[];
  activeActors: Actor[];
  focusActorId: string;
  runInput: ParsedRunInput;
  locations: Location[];
  actorStatesBefore: Record<string, LifeState>;
  actorLocationsBefore: ActorLocationMap;
  availableActionsByActor: Map<string, AvailableAction[]>;
  events: Event[];
  emit: (event: Event) => void;
  nextSeq: () => number;
  wallClock: () => string;
  store: SimulatorStore;
}): Promise<ActorTurnRecord[]> {
  const records: ActorTurnRecord[] = [];
  const concurrency = Math.max(1, ORCHESTRATOR_LIMITS.max_concurrent_agent_requests);

  for (let index = 0; index < args.activeActors.length; index += concurrency) {
    const batch = args.activeActors.slice(index, index + concurrency);
    const settledResponses = await Promise.allSettled(batch.map((actor) => collectSingleActorTurnRecord(args, actor)));
    const rejected = settledResponses.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (rejected) throw rejected.reason;
    records.push(...settledResponses
      .map((result) => result.status === "fulfilled" ? result.value : undefined)
      .filter((response): response is ActorTurnRecord => Boolean(response)));
  }

  return records;
}

async function collectSingleActorTurnRecord(
  args: Parameters<typeof collectActorTurnRecords>[0],
  actor: Actor,
): Promise<ActorTurnRecord | undefined> {
  const state = args.actorStatesBefore[actor.id];
  if (!state) return undefined;
  const locationId = args.actorLocationsBefore[actor.id] ?? selectInitialLocationId(args.runInput, args.locations, actor);
  const availableActions = args.availableActionsByActor.get(actor.id) ?? [];
  const worldContext = buildAgentWorldContext(args.runInput, args.locations, locationId);
  const request: AgentTurnRequest = {
    type: "yume.turn_request",
    run_id: args.runId,
    turn_id: args.turnId,
    clock: {
      turn_index: args.turnIndex,
      day: args.day,
      time_slot: args.slot,
      sim_hour: args.hour,
    },
    agent_id: actor.id,
    task: "choose_action",
    world_snapshot: {
      actor_profile: buildAgentActorProfile(actor),
      location_id: locationId,
      focus_actor_id: args.focusActorId,
      actor_locations: args.actorLocationsBefore,
      world_context: worldContext,
      scenario_context: args.runInput.scenario?.description,
      life_state: state,
      observed_actors: buildObservedActors(
        actor.id,
        args.focusActorId,
        args.actorStatesBefore,
        args.actors,
        visibleActorIdsForActor(actor.id, locationId, state, args.actorLocationsBefore),
      ),
      known_actors: buildKnownActors(actor.id, args.actorStatesBefore, args.actors),
      recent_events: args.events.slice(-ORCHESTRATOR_LIMITS.recent_event_count),
    },
    available_actions: availableActionsForAgent(availableActions),
  };
  const response = await requestAgentTurnWithRetry({
    agentDriver: args.agentDriver,
    request,
    debug: args.debug,
    emit: args.emit,
    nextSeq: args.nextSeq,
    wallClock: args.wallClock,
    day: args.day,
    slot: args.slot,
    hour: args.hour,
  });
  if (!response) return undefined;
  if (!response.agent_id) response.agent_id = actor.id;
  validateAgentResponse(args.runId, args.turnId, response);
  validateSelectedAction(response, availableActions);
  const selected = response.selected_action
    ?? availableActions[ORCHESTRATOR_LIMITS.initial_sequence]?.action
    ?? { type: "rest" };
  args.store.recordPendingChange({
    runId: args.runId,
    turnId: args.turnId,
    source: actor.id,
    kind: "agent_response",
    payload: response,
  });
  args.store.recordActionLog({
    runId: args.runId,
    turnId: args.turnId,
    candidates: availableActions,
    selected,
  });
  return { actor, availableActions, response, selected, worldContext };
}

function buildAvailableActionsByActor(
  actors: Actor[],
  actorStates: Record<string, LifeState>,
  actorLocations: ActorLocationMap,
  slot: TimeSlot,
): Map<string, AvailableAction[]> {
  const actionsByActor = new Map<string, AvailableAction[]>();
  for (const actor of actors) {
    const state = actorStates[actor.id];
    if (!state) continue;
    const currentLocationId = actorLocations[actor.id];
    const localActorIds = actors
      .map((candidate) => candidate.id)
      .filter((actorId) => actorId !== actor.id && actorLocations[actorId] === currentLocationId);
    const reachableActorIds = state.relationships.map((relationship) => relationship.actor_id);
    actionsByActor.set(actor.id, getAvailableActions(state, slot, localActorIds, reachableActorIds));
  }
  return actionsByActor;
}

function buildSynchronousSchedulerPlan(
  actors: Actor[],
  turnIndex: number,
  scheduler: SchedulerRuntimeSettings,
): SchedulerPlan {
  if (actors.length === 0) {
    return { participants: [], observers: [], background_agents: [], inactive_agents: [] };
  }
  const capacity = actors.length;
  const start = (turnIndex - 1) % actors.length;
  const participants = Array.from({ length: capacity }, (_, offset) =>
    actors[(start + offset) % actors.length]!.id
  );
  const participantSet = new Set(participants);
  return {
    participants,
    observers: [],
    background_agents: [],
    inactive_agents: actors
      .map((actor) => actor.id)
      .filter((actorId) => !participantSet.has(actorId)),
  };
}

function resolveActorLocationsAfterActions(args: {
  runInput: ParsedRunInput;
  locations: Location[];
  actors: Actor[];
  actorLocationsBefore: ActorLocationMap;
  selectedActionsByActor: Map<string, SimAction>;
  weekday: string;
  slot: TimeSlot;
}): ActorLocationMap {
  const next = { ...args.actorLocationsBefore };
  for (const actor of args.actors) {
    const selected = args.selectedActionsByActor.get(actor.id);
    const current = next[actor.id] ?? selectInitialLocationId(args.runInput, args.locations, actor);
    next[actor.id] = selected
      ? resolveLocationAfterAction(current, selected, args.locations, actor, args.weekday, args.slot)
      : current;
  }
  return next;
}

function buildInteractionPlans(args: {
  records: ActorTurnRecord[];
  recordsByActor: Map<string, ActorTurnRecord>;
  actors: Actor[];
  actorStates: Record<string, LifeState>;
  runInput: ParsedRunInput;
  locations: Location[];
  projectedActorLocations: ActorLocationMap;
  turnId: string;
  day: number;
  slot: TimeSlot;
  hour: number;
}): InteractionPlan[] {
  const actorIds = new Set(args.actors.map((actor) => actor.id));
  const plannedPairKeys = new Set<string>();
  const busyActors = new Set<string>();
  const plans: InteractionPlan[] = [];
  for (const record of args.records) {
    const targetActorId = getActionTargetActorId(record.selected);
    if (!targetActorId || !actorIds.has(targetActorId)) continue;
    const targetRecord = args.recordsByActor.get(targetActorId);
    const reciprocal = targetRecord && getActionTargetActorId(targetRecord.selected) === record.actor.id;
    let initiatorRecord = record;
    let targetResponse = targetRecord?.response;
    if (reciprocal && targetRecord) {
      const pairKey = [record.actor.id, targetActorId].sort().join(":");
      if (plannedPairKeys.has(pairKey)) continue;
      plannedPairKeys.add(pairKey);
      if (targetActorId < record.actor.id) {
        initiatorRecord = targetRecord;
        targetResponse = record.response;
      }
    } else {
      targetResponse = undefined;
      plannedPairKeys.add([record.actor.id, targetActorId].sort().join(":"));
    }
    busyActors.add(initiatorRecord.actor.id);
    busyActors.add(getActionTargetActorId(initiatorRecord.selected)!);
    const locationId = args.projectedActorLocations[initiatorRecord.actor.id]
      ?? selectInitialLocationId(args.runInput, args.locations, initiatorRecord.actor);
    plans.push({
      initiatorActorId: initiatorRecord.actor.id,
      targetActorId: getActionTargetActorId(initiatorRecord.selected)!,
      selected: initiatorRecord.selected,
      initiatorResponse: initiatorRecord.response,
      targetResponse,
      locationId,
      worldContext: buildAgentWorldContext(args.runInput, args.locations, locationId),
    });
  }
  addSpontaneousCoLocationPlans({
    ...args,
    plans,
    plannedPairKeys,
    busyActors,
  });
  return plans;
}

function addSpontaneousCoLocationPlans(args: {
  records: ActorTurnRecord[];
  actorStates: Record<string, LifeState>;
  runInput: ParsedRunInput;
  locations: Location[];
  projectedActorLocations: ActorLocationMap;
  turnId: string;
  day: number;
  slot: TimeSlot;
  hour: number;
  plans: InteractionPlan[];
  plannedPairKeys: Set<string>;
  busyActors: Set<string>;
}): void {
  const recordsByLocation = new Map<string, ActorTurnRecord[]>();
  for (const record of args.records) {
    if (args.busyActors.has(record.actor.id)) continue;
    if (blocksSpontaneousInteraction(record.selected)) continue;
    const locationId = args.projectedActorLocations[record.actor.id];
    if (!locationId) continue;
    const bucket = recordsByLocation.get(locationId) ?? [];
    bucket.push(record);
    recordsByLocation.set(locationId, bucket);
  }

  let spontaneousCount = 0;
  for (const [locationId, locationRecords] of recordsByLocation) {
    for (let leftIndex = 0; leftIndex < locationRecords.length; leftIndex++) {
      const left = locationRecords[leftIndex]!;
      if (args.busyActors.has(left.actor.id)) continue;
      for (let rightIndex = leftIndex + 1; rightIndex < locationRecords.length; rightIndex++) {
        if (spontaneousCount >= ORCHESTRATOR_LIMITS.spontaneous_interactions_per_turn) return;
        const right = locationRecords[rightIndex]!;
        if (args.busyActors.has(right.actor.id)) continue;
        const pairKey = [left.actor.id, right.actor.id].sort().join(":");
        if (args.plannedPairKeys.has(pairKey)) continue;
        const chance = spontaneousInteractionChance(left.actor.id, right.actor.id, args.actorStates);
        const roll = deterministicPercent([
          args.runInput.seed ?? ORCHESTRATOR_LIMITS.default_seed,
          args.turnId,
          args.day,
          args.slot,
          args.hour,
          locationId,
          pairKey,
        ].join(":"));
        if (roll >= chance) continue;

        const initiatorFirst = deterministicPercent(`${pairKey}:initiator:${args.turnId}`) < 50;
        const initiatorRecord = initiatorFirst ? left : right;
        const targetRecord = initiatorFirst ? right : left;
        args.plannedPairKeys.add(pairKey);
        args.busyActors.add(initiatorRecord.actor.id);
        args.busyActors.add(targetRecord.actor.id);
        args.plans.push({
          initiatorActorId: initiatorRecord.actor.id,
          targetActorId: targetRecord.actor.id,
          selected: { type: "socialize", actor_id: targetRecord.actor.id },
          initiatorResponse: initiatorRecord.response,
          locationId,
          worldContext: buildAgentWorldContext(args.runInput, args.locations, locationId),
          spontaneous: true,
        });
        spontaneousCount += 1;
        break;
      }
    }
  }
}

function blocksSpontaneousInteraction(action: SimAction): boolean {
  return action.type === "sleep" ||
    action.type === "socialize" ||
    action.type === "reach_out" ||
    action.type === "consider_decision";
}

function spontaneousInteractionChance(
  leftActorId: string,
  rightActorId: string,
  actorStates: Record<string, LifeState>,
): number {
  const leftRelationship = actorStates[leftActorId]?.relationships.find((relationship) => relationship.actor_id === rightActorId);
  const rightRelationship = actorStates[rightActorId]?.relationships.find((relationship) => relationship.actor_id === leftActorId);
  const relationship = leftRelationship ?? rightRelationship;
  let chance = ORCHESTRATOR_LIMITS.spontaneous_interaction_base_percent;
  if (relationship) {
    chance += ORCHESTRATOR_LIMITS.spontaneous_interaction_known_bonus_percent;
    if (relationship.closeness > 65) chance += ORCHESTRATOR_LIMITS.spontaneous_interaction_close_bonus_percent;
    if (relationship.tension > 55) chance += ORCHESTRATOR_LIMITS.spontaneous_interaction_tension_bonus_percent;
  }
  return Math.min(chance, ORCHESTRATOR_LIMITS.spontaneous_interaction_max_percent);
}

function deterministicPercent(key: string): number {
  return Math.abs(hash(key)) % 100;
}

async function collectMissingSceneResponses(args: {
  agentDriver: AgentDriver;
  debug: SimulationDebugLogger;
  runId: string;
  turnId: string;
  turnIndex: number;
  day: number;
  slot: TimeSlot;
  hour: number;
  focusActorId: string;
  runInput: ParsedRunInput;
  actors: Actor[];
  locations: Location[];
  actorStatesBefore: Record<string, LifeState>;
  actorLocationsBefore: ActorLocationMap;
  events: Event[];
  emit: (event: Event) => void;
  nextSeq: () => number;
  wallClock: () => string;
  store: SimulatorStore;
  plans: InteractionPlan[];
}): Promise<void> {
  const settledResponses = await Promise.allSettled(args.plans.map(async (plan) => {
    if (plan.targetResponse) return;
    const targetActor = args.actors.find((actor) => actor.id === plan.targetActorId);
    if (!targetActor) return;
    const targetState = args.actorStatesBefore[plan.targetActorId];
    if (!targetState) return;
    const targetLocationId = plan.selected.type === "reach_out"
      ? args.actorLocationsBefore[plan.targetActorId] ?? plan.locationId
      : plan.locationId;
    const targetWorldContext = targetLocationId === plan.locationId
      ? plan.worldContext
      : buildAgentWorldContext(args.runInput, args.locations, targetLocationId);
    const request: AgentTurnRequest = {
      type: "yume.turn_request",
      run_id: args.runId,
      turn_id: args.turnId,
      clock: {
        turn_index: args.turnIndex,
        day: args.day,
        time_slot: args.slot,
        sim_hour: args.hour,
      },
      agent_id: plan.targetActorId,
      task: "respond_to_scene",
      world_snapshot: {
        actor_profile: buildAgentActorProfile(targetActor),
        location_id: targetLocationId,
        focus_actor_id: args.focusActorId,
        actor_locations: args.actorLocationsBefore,
        world_context: targetWorldContext,
        scenario_context: args.runInput.scenario?.description,
        life_state: targetState,
        observed_actors: buildObservedActors(
          plan.targetActorId,
          args.focusActorId,
          args.actorStatesBefore,
          args.actors,
          visibleActorIdsForActor(
            plan.targetActorId,
            targetLocationId,
            targetState,
            args.actorLocationsBefore,
            [plan.initiatorActorId],
          ),
        ),
        known_actors: buildKnownActors(plan.targetActorId, args.actorStatesBefore, args.actors),
        recent_events: args.events.slice(-ORCHESTRATOR_LIMITS.recent_event_count),
      },
      available_actions: [],
      scene_context: {
        initiator_actor_id: plan.initiatorActorId,
        selected_action: plan.selected,
        location_id: plan.locationId,
        initiator_reasoning: plan.initiatorResponse.reasoning,
      },
    };
    const response = await requestAgentTurnWithRetry({
      agentDriver: args.agentDriver,
      request,
      debug: args.debug,
      emit: args.emit,
      nextSeq: args.nextSeq,
      wallClock: args.wallClock,
      day: args.day,
      slot: args.slot,
      hour: args.hour,
    });
    if (!response) return;
    if (!response.agent_id) response.agent_id = plan.targetActorId;
    validateAgentResponse(args.runId, args.turnId, response);
    if (response.selected_action) {
      console.warn(`[YUME] Scene response unexpectedly selected an action — ignoring`);
      delete (response as any).selected_action;
    }
    args.store.recordPendingChange({
      runId: args.runId,
      turnId: args.turnId,
      source: plan.targetActorId,
      kind: "agent_scene_response",
      payload: response,
    });
    plan.targetResponse = response;
  }));
  const rejected = settledResponses.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (rejected) throw rejected.reason;
}

function applyProjectedLocationsAndTravelCosts(args: {
  runInput: ParsedRunInput;
  locations: Location[];
  actorStates: Record<string, LifeState>;
  actorLocations: ActorLocationMap;
  actorLocationsBefore: ActorLocationMap;
  projectedActorLocations: ActorLocationMap;
  actionEffectsByActor: Map<string, ActionEffect>;
}): void {
  for (const [actorId, toLocationId] of Object.entries(args.projectedActorLocations)) {
    const fromLocationId = args.actorLocationsBefore[actorId];
    args.actorLocations[actorId] = toLocationId;
    if (!fromLocationId || fromLocationId === toLocationId) continue;
    const state = args.actorStates[actorId];
    if (!state) continue;
    const distance = resolveMovementDistance(args.runInput, args.locations, fromLocationId, toLocationId);
    if (distance <= 0) continue;
    const travelPenalty = Math.round(Math.min(20, distance / 50));
    args.actorStates[actorId] = {
      ...state,
      energy: Math.max(SIMULATION_BOUNDS.min_meter, state.energy - travelPenalty),
      stress: Math.min(SIMULATION_BOUNDS.max_meter, state.stress + Math.round(travelPenalty / 3)),
    };
    const effect = args.actionEffectsByActor.get(actorId) ?? {};
    effect.energy = (effect.energy ?? 0) - travelPenalty;
    effect.stress = (effect.stress ?? 0) + Math.round(travelPenalty / 3);
    args.actionEffectsByActor.set(actorId, effect);
  }
}

function applyProposedScheduleUpdates(args: {
  records: ActorTurnRecord[];
  locations: Location[];
  day: number;
  slot: TimeSlot;
  hour: number;
  turnId: string;
  emit: (event: Event) => void;
  nextSeq: () => number;
  wallClock: () => string;
  store: SimulatorStore;
  debug: SimulationDebugLogger;
}): void {
  const validLocationIds = new Set(args.locations.map((location) => location.id));
  for (const record of args.records) {
    const updates = sanitizeScheduleUpdates(record.response.proposed_schedule_updates, validLocationIds, record.actor.schedule);
    if (updates.length === 0) continue;
    const schedule = record.actor.schedule ?? {};
    for (const update of updates) {
      const daySchedule = schedule[update.weekday] ?? {};
      daySchedule[update.time_slot] = update.location_id;
      schedule[update.weekday] = daySchedule;
    }
    record.actor.schedule = schedule;
    args.store.recordPendingChange({
      runId: record.response.run_id,
      turnId: args.turnId,
      source: record.actor.id,
      kind: "schedule_update",
      payload: { actor_id: record.actor.id, updates },
    });
    args.debug({
      kind: "schedule.update",
      turn_id: args.turnId,
      day: args.day,
      slot: args.slot,
      sim_hour: args.hour,
      actor_id: record.actor.id,
      message: `Schedule updated for ${record.actor.id}.`,
      data: { updates },
    });
    for (const update of updates) {
      args.emit({
        type: "sim.event",
        seq: args.nextSeq(),
        day: args.day,
        slot: args.slot,
        sim_hour: args.hour,
        at_wall_clock: args.wallClock(),
        turn_id: args.turnId,
        actor_id: record.actor.id,
        sim_event_type: "schedule_update",
        severity: "low",
        description: `${record.actor.display_name} changed a recurring ${update.weekday} ${update.time_slot} routine to ${locationDisplayName(update.location_id, args.locations)}.`,
      });
    }
  }
}

function sanitizeScheduleUpdates(
  updates: unknown,
  validLocationIds: Set<string>,
  currentSchedule: Actor["schedule"] | undefined,
): AgentScheduleUpdate[] {
  if (!Array.isArray(updates)) return [];
  const validWeekdays = new Set<Weekday>(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
  const validSlots = new Set<TimeSlot>(["morning", "noon", "evening", "night"]);
  const sanitized: AgentScheduleUpdate[] = [];
  const seen = new Set<string>();
  for (const rawUpdate of updates) {
    if (!rawUpdate || typeof rawUpdate !== "object") continue;
    const update = rawUpdate as Partial<AgentScheduleUpdate>;
    if (typeof update.weekday !== "string") continue;
    if (typeof update.time_slot !== "string") continue;
    if (typeof update.location_id !== "string") continue;
    if (!validWeekdays.has(update.weekday)) continue;
    if (!validSlots.has(update.time_slot)) continue;
    if (!validLocationIds.has(update.location_id)) continue;
    if (currentSchedule?.[update.weekday]?.[update.time_slot] === update.location_id) continue;
    const key = `${update.weekday}:${update.time_slot}`;
    if (seen.has(key)) continue;
    seen.add(key);
    sanitized.push({
      weekday: update.weekday,
      time_slot: update.time_slot,
      location_id: update.location_id,
      reason: typeof update.reason === "string" ? sanitizePublicText(update.reason, []) : undefined,
    });
    if (sanitized.length >= ORCHESTRATOR_LIMITS.schedule_updates_per_actor_per_turn) break;
  }
  return sanitized;
}

function locationDisplayName(locationId: string, locations: Location[]): string {
  return locations.find((location) => location.id === locationId)?.display_name ?? humanizeInternalId(locationId);
}

function emitTurnEvents(args: {
  emit: (event: Event) => void;
  nextSeq: () => number;
  wallClock: () => string;
  day: number;
  slot: TimeSlot;
  hour: number;
  turnId: string;
  actors: Actor[];
  actorStates: Record<string, LifeState>;
  actorLocations: ActorLocationMap;
  actorLocationsBefore: ActorLocationMap;
  records: ActorTurnRecord[];
  recordsByActor: Map<string, ActorTurnRecord>;
  interactionPlans: InteractionPlan[];
  interactionEvaluations: InteractionEvaluationResponse[];
  actionEffectsByActor: Map<string, ActionEffect>;
  runInput: ParsedRunInput;
}): void {
  for (const record of args.records) {
    emitDecisionEvent({
      emit: args.emit,
      nextSeq: args.nextSeq,
      wallClock: args.wallClock,
      day: args.day,
      slot: args.slot,
      hour: args.hour,
      selected: record.selected,
      fromLocationId: args.actorLocationsBefore[record.actor.id]!,
      currentLocationId: args.actorLocations[record.actor.id]!,
      actorId: record.actor.id,
      reasoning: record.response.reasoning,
      actors: args.actors,
    });
  }

  const actorsInInteractionPlans = new Set<string>();
  for (const plan of args.interactionPlans) {
    actorsInInteractionPlans.add(plan.initiatorActorId);
    actorsInInteractionPlans.add(plan.targetActorId);
    const initiatorActor = args.actors.find((actor) => actor.id === plan.initiatorActorId);
    if (!initiatorActor) continue;
    emitSceneEvents({
      emit: args.emit,
      nextSeq: args.nextSeq,
      wallClock: args.wallClock,
      day: args.day,
      slot: args.slot,
      hour: args.hour,
      selected: plan.selected,
      initiatorActor,
      actors: args.actors,
      locationId: plan.locationId,
      response: plan.initiatorResponse,
      targetResponse: plan.targetResponse,
    });
  }

  for (const record of args.records) {
    if (actorsInInteractionPlans.has(record.actor.id)) continue;
    emitSceneEvents({
      emit: args.emit,
      nextSeq: args.nextSeq,
      wallClock: args.wallClock,
      day: args.day,
      slot: args.slot,
      hour: args.hour,
      selected: record.selected,
      initiatorActor: record.actor,
      actors: args.actors,
      locationId: args.actorLocations[record.actor.id]!,
      response: record.response,
    });
  }

  for (const record of args.records) {
    const relevantEvaluations = args.interactionEvaluations
      .filter((evaluation) => evaluationTouchesActor(evaluation, record.actor.id))
      .map(summarizeInteractionEvaluationForDebug);
    args.emit({
      type: "state.update",
      seq: args.nextSeq(),
      day: args.day,
      slot: args.slot,
      sim_hour: args.hour,
      at_wall_clock: args.wallClock(),
      turn_id: args.turnId,
      actor_id: record.actor.id,
      action_type: record.selected.type,
      effect: {
        ...((args.actionEffectsByActor.get(record.actor.id) ?? {}) as Record<string, unknown>),
        interaction_evaluations: relevantEvaluations,
      },
      state_summary: summarizeLifeState(args.actorStates[record.actor.id]!),
    });
  }

  for (const evaluation of args.interactionEvaluations) {
    const actorId = evaluation.evaluator_id.split(":")[0];
    for (const suggestion of evaluation.event_suggestions) {
      args.emit({
        type: "sim.event",
        seq: args.nextSeq(),
        day: args.day,
        slot: args.slot,
        sim_hour: args.hour,
        at_wall_clock: args.wallClock(),
        turn_id: args.turnId,
        actor_id: actorId,
        sim_event_type: suggestion.type,
        severity: suggestion.severity,
        description: suggestion.description,
      });
    }
  }

  for (const record of args.records) {
    for (const simEvent of checkEventTriggers(args.actorStates[record.actor.id]!, args.runInput.decision_context?.question)) {
      args.emit({
        type: "sim.event",
        seq: args.nextSeq(),
        day: args.day,
        slot: args.slot,
        sim_hour: args.hour,
        at_wall_clock: args.wallClock(),
        turn_id: args.turnId,
        actor_id: record.actor.id,
        sim_event_type: simEvent.type,
        severity: simEvent.severity,
        description: `${record.actor.display_name}: ${simEvent.description}`,
      });
    }
  }
}

async function recordTurnMemories(args: {
  agentDriver: AgentDriver;
  actorSessions: ActorSession[];
  store: SimulatorStore;
  debug: SimulationDebugLogger;
  runId: string;
  turnId: string;
  actors: Actor[];
  records: ActorTurnRecord[];
  recordsByActor: Map<string, ActorTurnRecord>;
  interactionPlans: InteractionPlan[];
  interactionEvaluations: InteractionEvaluationResponse[];
}): Promise<void> {
  for (const record of args.records) {
    for (const memory of record.response.proposed_memory_updates) {
      await recordMemoryVersion({
        agentDriver: args.agentDriver,
        actorSessions: args.actorSessions,
        store: args.store,
        debug: args.debug,
        runId: args.runId,
        turnId: args.turnId,
        agentId: record.actor.id,
        content: sanitizePublicText(memory, args.actors),
      });
    }
    const targetActorId = getActionTargetActorId(record.selected);
    if (targetActorId) {
      await recordRelationshipNote({
        agentDriver: args.agentDriver,
        actorSessions: args.actorSessions,
        store: args.store,
        debug: args.debug,
        runId: args.runId,
        turnId: args.turnId,
        agentId: record.actor.id,
        targetActorId,
        content: `Relationship note about ${actorDisplayName(targetActorId, args.actors)}: ${sanitizePublicText(record.response.reasoning, args.actors)}`,
      });
    }
  }

  for (const plan of args.interactionPlans) {
    const targetRecordResponse = args.recordsByActor.get(plan.targetActorId)?.response;
    if (!plan.targetResponse || plan.targetResponse === targetRecordResponse) continue;
    for (const memory of plan.targetResponse.proposed_memory_updates) {
      await recordMemoryVersion({
        agentDriver: args.agentDriver,
        actorSessions: args.actorSessions,
        store: args.store,
        debug: args.debug,
        runId: args.runId,
        turnId: args.turnId,
        agentId: plan.targetActorId,
        content: sanitizePublicText(memory, args.actors),
      });
    }
    await recordRelationshipNote({
      agentDriver: args.agentDriver,
      actorSessions: args.actorSessions,
      store: args.store,
      debug: args.debug,
      runId: args.runId,
      turnId: args.turnId,
      agentId: plan.targetActorId,
      targetActorId: plan.initiatorActorId,
      content: `Relationship note about ${actorDisplayName(plan.initiatorActorId, args.actors)}: ${sanitizePublicText(plan.targetResponse.reasoning, args.actors)}`,
    });
  }

  for (const evaluation of args.interactionEvaluations) {
    for (const note of evaluation.memory_notes) {
      if (note.target_actor_id) {
        await recordRelationshipNote({
          agentDriver: args.agentDriver,
          actorSessions: args.actorSessions,
          store: args.store,
          debug: args.debug,
          runId: args.runId,
          turnId: args.turnId,
          agentId: note.actor_id,
          targetActorId: note.target_actor_id,
          content: `Evaluator note about ${actorDisplayName(note.target_actor_id, args.actors)}: ${sanitizePublicText(note.content, args.actors)}`,
        });
      } else {
        await recordMemoryVersion({
          agentDriver: args.agentDriver,
          actorSessions: args.actorSessions,
          store: args.store,
          debug: args.debug,
          runId: args.runId,
          turnId: args.turnId,
          agentId: note.actor_id,
          content: `Evaluator note: ${sanitizePublicText(note.content, args.actors)}`,
        });
      }
    }
  }
}

function evaluationTouchesActor(evaluation: InteractionEvaluationResponse, actorId: string): boolean {
  return evaluation.relationship_deltas.some((delta) => delta.from_actor_id === actorId || delta.to_actor_id === actorId) ||
    evaluation.actor_state_deltas.some((delta) => delta.actor_id === actorId);
}

async function collectTargetResponse(args: {
  agentDriver: AgentDriver;
  debug: SimulationDebugLogger;
  runId: string;
  turnId: string;
  turnIndex: number;
  day: number;
  slot: TimeSlot;
  hour: number;
  currentLocationId: string;
  worldContext?: AgentWorldContext;
  actors: Actor[];
  actorStates: Record<string, LifeState>;
  events: Event[];
  selected: SimAction;
  focusActorId: string;
  focusActorReasoning: string;
  emit: (event: Event) => void;
  nextSeq: () => number;
  wallClock: () => string;
  store: SimulatorStore;
}): Promise<AgentTurnResponse | undefined> {
  const targetActorId = "actor_id" in args.selected ? args.selected.actor_id : undefined;
  if (!targetActorId) return undefined;
  const targetActor = args.actors.find((actor) => actor.id === targetActorId);
  if (!targetActor) return undefined;
  const targetState = args.actorStates[targetActorId];
  if (!targetState) return undefined;

  const request: AgentTurnRequest = {
    type: "yume.turn_request",
    run_id: args.runId,
    turn_id: args.turnId,
    clock: {
      turn_index: args.turnIndex,
      day: args.day,
      time_slot: args.slot,
      sim_hour: args.hour,
    },
    agent_id: targetActorId,
    task: "respond_to_scene",
    world_snapshot: {
      actor_profile: buildAgentActorProfile(targetActor),
      location_id: args.currentLocationId,
      focus_actor_id: args.focusActorId,
      world_context: args.worldContext,
      life_state: targetState,
      observed_actors: buildObservedActors(
        targetActorId,
        args.focusActorId,
        args.actorStates,
        args.actors,
        visibleActorIdsForActor(targetActorId, args.currentLocationId, targetState, {}, [args.focusActorId]),
      ),
      known_actors: buildKnownActors(targetActorId, args.actorStates, args.actors),
      recent_events: args.events.slice(-ORCHESTRATOR_LIMITS.recent_event_count),
    },
    available_actions: [],
    scene_context: {
      initiator_actor_id: args.focusActorId,
      selected_action: args.selected,
      location_id: args.currentLocationId,
      initiator_reasoning: args.focusActorReasoning,
    },
  };

  const response = await requestAgentTurnWithRetry({
    agentDriver: args.agentDriver,
    request,
    debug: args.debug,
    emit: args.emit,
    nextSeq: args.nextSeq,
    wallClock: args.wallClock,
    day: args.day,
    slot: args.slot,
    hour: args.hour,
  });
  if (!response) return;
  validateAgentResponse(args.runId, args.turnId, response);
  if (response.selected_action) {
    console.warn(`[YUME] Scene response unexpectedly selected an action — ignoring`);
    delete (response as any).selected_action;
  }
  args.store.recordPendingChange({
    runId: args.runId,
    turnId: args.turnId,
    source: targetActorId,
    kind: "agent_scene_response",
    payload: response,
  });
  return response;
}

async function requestAgentTurnWithRetry(args: {
  agentDriver: AgentDriver;
  request: AgentTurnRequest;
  debug: SimulationDebugLogger;
  emit: (event: Event) => void;
  nextSeq: () => number;
  wallClock: () => string;
  day: number;
  slot: TimeSlot;
  hour: number;
}): Promise<AgentTurnResponse | null> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= ORCHESTRATOR_LIMITS.agent_turn_retries; attempt++) {
    try {
      args.debug({
        kind: "agent.request",
        turn_id: args.request.turn_id,
        day: args.day,
        slot: args.slot,
        sim_hour: args.hour,
        actor_id: args.request.agent_id,
        message: `Agent request: ${args.request.task}.`,
        data: summarizeAgentRequestForDebug(args.request, attempt),
      });
      const response = await withTimeout(
        args.agentDriver.requestTurn(args.request),
        ORCHESTRATOR_LIMITS.agent_turn_timeout_ms,
      );
      args.debug({
        kind: "agent.response",
        turn_id: args.request.turn_id,
        day: args.day,
        slot: args.slot,
        sim_hour: args.hour,
        actor_id: args.request.agent_id,
        message: `Agent response: ${args.request.task}.`,
        data: summarizeAgentResponseForDebug(response),
      });
      return response;
    } catch (error) {
      if (isAbortError(error)) throw error;
      lastError = error;
      args.debug({
        kind: "agent.retry",
        turn_id: args.request.turn_id,
        day: args.day,
        slot: args.slot,
        sim_hour: args.hour,
        actor_id: args.request.agent_id,
        message: "Agent request failed and may be retried.",
        data: {
          attempt,
          reason: error instanceof Error ? error.message : String(error),
        },
      });
      if (attempt >= ORCHESTRATOR_LIMITS.agent_turn_retries) break;
    }
  }

  const reason = lastError instanceof Error ? lastError.message : String(lastError);
  args.emit({
    type: "agent.unavailable",
    seq: args.nextSeq(),
    day: args.day,
    slot: args.slot,
    sim_hour: args.hour,
    at_wall_clock: args.wallClock(),
    turn_id: args.request.turn_id,
    agent_id: args.request.agent_id,
    task: args.request.task,
    retry_count: ORCHESTRATOR_LIMITS.agent_turn_retries,
    reason,
  });
  console.warn(`[YUME] Agent unavailable after retry: ${args.request.agent_id} ${args.request.task}: ${reason} — skipping`);
  return null;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`Agent turn timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error(typeof signal.reason === "string" ? signal.reason : "Run cancelled");
}

function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const record = error as { name?: unknown; message?: unknown };
  return record.name === "AbortError" ||
    (typeof record.message === "string" && /aborted|cancelled|canceled/i.test(record.message));
}

function createDebugLogger(
  input: ParsedRunInput,
  opts: DesignOrchestratorOptions,
  runId: string,
): SimulationDebugLogger {
  const consoleEnabled = opts.debug === true ||
    input.config?.debug_logs === true ||
    envFlag("YUME_DEBUG_LOGS") ||
    envFlag("YUME_SIM_DEBUG");
  const enabled = consoleEnabled || Boolean(opts.onDebug);
  return (record) => {
    if (!enabled) return;
    const fullRecord: SimulationDebugRecord = {
      type: "yume.debug",
      run_id: runId,
      at_wall_clock: new Date().toISOString(),
      ...record,
    };
    opts.onDebug?.(fullRecord);
    if (consoleEnabled) console.log(JSON.stringify(fullRecord));
  };
}

function summarizeAgentRequestForDebug(request: AgentTurnRequest, attempt: number): Record<string, unknown> {
  return {
    attempt,
    task: request.task,
    agent_id: request.agent_id,
    clock: request.clock,
    actor_profile: {
      display_name: request.world_snapshot.actor_profile.display_name,
      role: request.world_snapshot.actor_profile.role,
      behavior_summary: request.world_snapshot.actor_profile.behavior_traits.summary,
    },
    location_id: request.world_snapshot.location_id,
    focus_actor_id: request.world_snapshot.focus_actor_id,
    own_state: request.world_snapshot.life_state
      ? summarizeStateForDebug(request.world_snapshot.life_state)
      : undefined,
    observed_actors: request.world_snapshot.observed_actors,
    known_actors: request.world_snapshot.known_actors,
    recent_events: request.world_snapshot.recent_events.map((event) => summarizeEventForDebug(event)),
    available_actions: agentAvailableActionsForDebug(request.available_actions),
    scene_context: request.scene_context
      ? {
          initiator_actor_id: request.scene_context.initiator_actor_id,
          selected_action: actionForDebug(request.scene_context.selected_action),
          location_id: request.scene_context.location_id,
          initiator_reasoning: request.scene_context.initiator_reasoning,
        }
      : undefined,
    world_context: summarizeWorldContextForDebug(request.world_snapshot.world_context),
  };
}

function summarizeAgentResponseForDebug(response: AgentTurnResponse): Record<string, unknown> {
  return {
    agent_id: response.agent_id,
    turn_id: response.turn_id,
    selected_action: response.selected_action ? actionForDebug(response.selected_action) : undefined,
    utterance: response.utterance,
    reasoning: response.reasoning,
    proposed_memory_update_count: response.proposed_memory_updates.length,
    proposed_memory_updates: response.proposed_memory_updates.map((memory) => previewText(memory)),
    proposed_schedule_updates: response.proposed_schedule_updates,
    observed_memory_writes: response.observed_memory_writes,
  };
}

function summarizeInteractionEvaluationRequestForDebug(request: InteractionEvaluationRequest): Record<string, unknown> {
  return {
    evaluator_id: request.evaluator_id,
    initiator_actor_id: request.initiator_actor_id,
    target_actor_id: request.target_actor_id,
    selected_action: actionForDebug(request.selected_action),
    location_id: request.location_id,
    initiator_reasoning: request.initiator_response.reasoning,
    initiator_utterance: request.initiator_response.utterance,
    target_reasoning: request.target_response?.reasoning,
    target_utterance: request.target_response?.utterance,
    initiator_state: summarizeStateForDebug(request.initiator_state),
    target_state: summarizeStateForDebug(request.target_state),
    recent_events: request.recent_events.map((event) => summarizeEventForDebug(event)),
    world_context: summarizeWorldContextForDebug(request.world_context),
  };
}

function summarizeInteractionEvaluationForDebug(evaluation: InteractionEvaluationResponse): Record<string, unknown> {
  return {
    evaluator_id: evaluation.evaluator_id,
    outcome: evaluation.outcome,
    confidence: evaluation.confidence,
    relationship_deltas: evaluation.relationship_deltas,
    actor_state_deltas: evaluation.actor_state_deltas,
    event_suggestions: evaluation.event_suggestions,
    memory_notes: evaluation.memory_notes.map((note) => ({
      actor_id: note.actor_id,
      target_actor_id: note.target_actor_id,
      content_preview: previewText(note.content),
    })),
    evidence: evaluation.evidence,
    reasoning: evaluation.reasoning,
  };
}

function defaultInteractionEvaluation(request: InteractionEvaluationRequest): InteractionEvaluationResponse {
  const text = [
    request.initiator_response.reasoning,
    request.initiator_response.utterance,
    request.target_response?.reasoning,
    request.target_response?.utterance,
    ...request.initiator_response.proposed_memory_updates,
    ...(request.target_response?.proposed_memory_updates ?? []),
  ].filter(Boolean).join(" ").toLowerCase();

  const supportive = /\b(willing|open|support|thank|appreciate|understand|talk this through|repair|apolog)/i.test(text);
  const hostile = /\b(angry|furious|ignored|hurt|upset|not enough|refuse|blame|fault|unfair|betray|still upset)\b/i.test(text);
  const avoidant = /\b(avoid|later|not now|leave me|silence|no response)\b/i.test(text);
  const outcome: InteractionOutcome = hostile && !supportive
    ? "conflict"
    : hostile && supportive
      ? "repair"
      : avoidant
        ? "avoidance"
        : supportive
          ? "support"
          : "neutral";
  return buildRuleBasedEvaluation(request, outcome, "Rule-based fallback evaluated the interaction text.");
}

function neutralInteractionEvaluation(
  request: InteractionEvaluationRequest,
  reasoning: string,
): InteractionEvaluationResponse {
  return buildRuleBasedEvaluation(request, "neutral", reasoning);
}

function buildRuleBasedEvaluation(
  request: InteractionEvaluationRequest,
  outcome: InteractionOutcome,
  reasoning: string,
): InteractionEvaluationResponse {
  const rule = INTERACTION_EVALUATION_RULES[outcome];
  const initiator = rule.initiator;
  const target = rule.target;
  const relationshipDeltas = [
    relationshipDeltaFromRule(request.initiator_actor_id, request.target_actor_id, initiator),
    relationshipDeltaFromRule(request.target_actor_id, request.initiator_actor_id, target),
  ];
  const actorStateDeltas = [
    actorStateDeltaFromRule(request.initiator_actor_id, initiator),
    actorStateDeltaFromRule(request.target_actor_id, target),
  ].filter((delta) => Object.keys(delta).length > 1);
  const eventSuggestions = eventSuggestionsForOutcome(outcome);
  return {
    type: "yume.interaction_evaluation",
    run_id: request.run_id,
    turn_id: request.turn_id,
    evaluator_id: request.evaluator_id,
    outcome,
    confidence: INTERACTION_EVALUATION_RULES.fallback_confidence,
    relationship_deltas: relationshipDeltas,
    actor_state_deltas: actorStateDeltas,
    event_suggestions: eventSuggestions,
    memory_notes: [
      {
        actor_id: request.initiator_actor_id,
        target_actor_id: request.target_actor_id,
        content: `${outcome}: ${reasoning}`,
      },
      {
        actor_id: request.target_actor_id,
        target_actor_id: request.initiator_actor_id,
        content: `${outcome}: ${reasoning}`,
      },
    ],
    evidence: [
      request.initiator_response.reasoning,
      request.target_response?.utterance ?? request.target_response?.reasoning ?? "No target response was available.",
    ].filter(Boolean),
    reasoning,
  };
}

function relationshipDeltaFromRule(
  fromActorId: string,
  toActorId: string,
  rule: { closeness?: number; trust?: number; tension?: number },
) {
  return {
    from_actor_id: fromActorId,
    to_actor_id: toActorId,
    closeness: rule.closeness ?? 0,
    trust: rule.trust ?? 0,
    tension: rule.tension ?? 0,
    reset_last_interaction: true,
  };
}

function actorStateDeltaFromRule(
  actorId: string,
  rule: {
    closeness?: number;
    trust?: number;
    tension?: number;
    energy?: number;
    health?: number;
    stress?: number;
    mood?: number;
    job_satisfaction?: number;
  },
) {
  const delta: InteractionEvaluationResponse["actor_state_deltas"][number] = { actor_id: actorId };
  if (rule.energy) delta.energy = rule.energy;
  if (rule.health) delta.health = rule.health;
  if (rule.stress) delta.stress = rule.stress;
  if (rule.mood) delta.mood = rule.mood;
  if (rule.job_satisfaction) delta.job_satisfaction = rule.job_satisfaction;
  return delta;
}

function eventSuggestionsForOutcome(outcome: InteractionOutcome): InteractionEvaluationResponse["event_suggestions"] {
  if (outcome === "conflict" || outcome === "escalation") {
    return [{
      type: "conflict_risk",
      severity: outcome === "escalation" ? "high" : "medium",
      description: "The interaction increased relationship tension.",
    }];
  }
  if (outcome === "repair" || outcome === "support") {
    return [{
      type: outcome === "repair" ? "relationship_repair" : "support_received",
      severity: "low",
      description: "The interaction improved the relationship or provided support.",
    }];
  }
  if (outcome === "avoidance") {
    return [{
      type: "relationship_avoidance",
      severity: "low",
      description: "The interaction avoided the underlying issue.",
    }];
  }
  return [];
}

function sanitizeInteractionEvaluation(
  raw: InteractionEvaluationResponse,
  request: InteractionEvaluationRequest,
  actorIds: string[],
  actors: Actor[] = [],
): InteractionEvaluationResponse {
  const actorIdSet = new Set(actorIds);
  const outcome = isInteractionOutcome(raw.outcome) ? raw.outcome : "neutral";
  const confidence = clampNumber(
    Number.isFinite(raw.confidence) ? raw.confidence : 0,
    0,
    1,
  );
  if (
    raw.type !== "yume.interaction_evaluation" ||
    raw.run_id !== request.run_id ||
    raw.turn_id !== request.turn_id ||
    confidence < INTERACTION_EVALUATION_RULES.min_confidence_for_commit
  ) {
    return neutralInteractionEvaluation(request, "Evaluator output was invalid or low confidence; neutral fallback used.");
  }

  return {
    type: "yume.interaction_evaluation",
    run_id: request.run_id,
    turn_id: request.turn_id,
    evaluator_id: typeof raw.evaluator_id === "string" ? raw.evaluator_id : request.evaluator_id,
    outcome,
    confidence,
    relationship_deltas: (raw.relationship_deltas ?? [])
      .filter((delta) => actorIdSet.has(delta.from_actor_id) && actorIdSet.has(delta.to_actor_id))
      .map((delta) => ({
        from_actor_id: delta.from_actor_id,
        to_actor_id: delta.to_actor_id,
        closeness: clampDelta(delta.closeness, INTERACTION_EVALUATION_RULES.max_relationship_delta),
        trust: clampDelta(delta.trust, INTERACTION_EVALUATION_RULES.max_relationship_delta),
        tension: clampDelta(delta.tension, INTERACTION_EVALUATION_RULES.max_relationship_delta),
        reset_last_interaction: delta.reset_last_interaction ?? true,
      })),
    actor_state_deltas: (raw.actor_state_deltas ?? [])
      .filter((delta) => actorIdSet.has(delta.actor_id))
      .map((delta) => ({
        actor_id: delta.actor_id,
        energy: clampDelta(delta.energy, INTERACTION_EVALUATION_RULES.max_actor_state_delta),
        health: clampDelta(delta.health, INTERACTION_EVALUATION_RULES.max_actor_state_delta),
        stress: clampDelta(delta.stress, INTERACTION_EVALUATION_RULES.max_actor_state_delta),
        mood: clampDelta(delta.mood, INTERACTION_EVALUATION_RULES.max_actor_state_delta),
        job_satisfaction: clampDelta(delta.job_satisfaction, INTERACTION_EVALUATION_RULES.max_actor_state_delta),
      })),
    event_suggestions: (raw.event_suggestions ?? [])
      .filter((event) => typeof event.type === "string" && isSeverity(event.severity) && typeof event.description === "string")
      .map((event) => ({
        type: event.type,
        severity: event.severity,
        description: sanitizePublicText(event.description, actors),
      })),
    memory_notes: (raw.memory_notes ?? [])
      .filter((note) =>
        actorIdSet.has(note.actor_id) &&
        (note.target_actor_id === undefined || actorIdSet.has(note.target_actor_id)) &&
        typeof note.content === "string" &&
        note.content.trim().length > 0
      )
      .map((note) => ({
        actor_id: note.actor_id,
        target_actor_id: note.target_actor_id,
        content: sanitizePublicText(note.content, actors),
      })),
    evidence: Array.isArray(raw.evidence)
      ? raw.evidence
          .filter((item): item is string => typeof item === "string")
          .slice(0, 6)
          .map((item) => sanitizePublicText(item, actors))
      : [],
    reasoning: typeof raw.reasoning === "string"
      ? sanitizePublicText(raw.reasoning, actors)
      : "Interaction evaluation sanitized.",
  };
}

function isInteractionOutcome(value: unknown): value is InteractionOutcome {
  return value === "repair" ||
    value === "support" ||
    value === "neutral" ||
    value === "avoidance" ||
    value === "conflict" ||
    value === "escalation";
}

function isSeverity(value: unknown): value is "low" | "medium" | "high" {
  return value === "low" || value === "medium" || value === "high";
}

function clampDelta(value: number | undefined, maxAbs: number): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value)) return undefined;
  return clampNumber(value, -maxAbs, maxAbs);
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function summarizeEventForDebug(event: Event): Record<string, unknown> {
  return {
    type: event.type,
    day: event.day,
    slot: event.slot,
    sim_hour: event.sim_hour,
    seq: event.seq,
  };
}

function summarizeWorldContextForDebug(context: AgentWorldContext | undefined): Record<string, unknown> | undefined {
  if (!context) return undefined;
  return {
    current_location_id: context.current_location?.id,
    current_building_id: context.current_building?.id,
    location_ids: context.locations.map((location) => location.id),
    building_ids: context.buildings.map((building) => building.id),
    nearby_buildings: context.nearby_buildings,
    path_count: context.paths.length,
    has_distance_matrix: Boolean(context.distance_matrix),
  };
}

function availableActionsForDebug(actions: AvailableAction[]): Array<Record<string, unknown>> {
  return actions.map((candidate) => ({
    action: actionForDebug(candidate.action),
  }));
}

function availableActionsForAgent(actions: AvailableAction[]): AgentAvailableAction[] {
  return actions
    .map((candidate) => ({ action: candidate.action }))
    .sort((left, right) => stableActionKey(left.action).localeCompare(stableActionKey(right.action)));
}

function agentAvailableActionsForDebug(actions: AgentAvailableAction[]): Array<Record<string, unknown>> {
  return actions.map((candidate) => ({
    action: actionForDebug(candidate.action),
  }));
}

function actionForDebug(action: SimAction): Record<string, unknown> {
  return {
    key: stableActionKey(action),
    ...action,
  };
}

function summarizeStateForDebug(state: LifeState): Record<string, unknown> {
  return {
    money: state.money,
    monthly_income: state.monthly_income,
    monthly_expenses: state.monthly_expenses,
    energy: state.energy,
    health: state.health,
    stress: state.stress,
    mood: state.mood,
    job_satisfaction: state.job_satisfaction,
    skills: state.skills,
    relationships: state.relationships.map((relationship) => ({
      actor_id: relationship.actor_id,
      closeness: relationship.closeness,
      trust: relationship.trust,
      tension: relationship.tension,
      last_interaction_day: relationship.last_interaction_day,
    })),
  };
}

function debugActorStateDeltas(args: {
  debug: SimulationDebugLogger;
  turnId: string;
  day: number;
  slot: TimeSlot;
  hour: number;
  before: Record<string, LifeState>;
  after: Record<string, LifeState>;
  actionsByActor: Map<string, SimAction>;
  source?: string;
}): void {
  const actorIds = [...new Set([...Object.keys(args.before), ...Object.keys(args.after)])].sort();
  for (const actorId of actorIds) {
    const before = args.before[actorId];
    const after = args.after[actorId];
    if (!before || !after) continue;
    const delta = lifeStateDeltaForDebug(before, after);
    if (!hasDebugDelta(delta)) continue;
    args.debug({
      kind: "state.delta",
      turn_id: args.turnId,
      day: args.day,
      slot: args.slot,
      sim_hour: args.hour,
      actor_id: actorId,
      message: `State changed for ${actorId}.`,
      data: {
        source: args.source ?? "turn_action",
        selected_action: args.actionsByActor.get(actorId)
          ? actionForDebug(args.actionsByActor.get(actorId)!)
          : undefined,
        delta,
        before: summarizeStateForDebug(before),
        after: summarizeStateForDebug(after),
      },
    });
  }
}

function lifeStateDeltaForDebug(before: LifeState, after: LifeState): Record<string, unknown> {
  const scalars: Record<string, { before: number; after: number; delta: number }> = {};
  for (const key of ["money", "monthly_income", "monthly_expenses", "energy", "health", "stress", "mood", "job_satisfaction"] as const) {
    if (before[key] !== after[key]) {
      scalars[key] = { before: before[key], after: after[key], delta: after[key] - before[key] };
    }
  }

  const beforeRelationships = new Map(before.relationships.map((relationship) => [relationship.actor_id, relationship]));
  const relationships = after.relationships
    .map((relationship) => {
      const previous = beforeRelationships.get(relationship.actor_id);
      if (!previous) return undefined;
      const changes: Record<string, { before: number; after: number; delta: number }> = {};
      for (const key of ["closeness", "trust", "tension", "last_interaction_day"] as const) {
        if (previous[key] !== relationship[key]) {
          changes[key] = {
            before: previous[key],
            after: relationship[key],
            delta: relationship[key] - previous[key],
          };
        }
      }
      return Object.keys(changes).length > 0
        ? { actor_id: relationship.actor_id, changes }
        : undefined;
    })
    .filter((relationship): relationship is { actor_id: string; changes: Record<string, { before: number; after: number; delta: number }> } => Boolean(relationship));

  const beforeSkillKeys = Object.keys(before.skills);
  const afterSkillKeys = Object.keys(after.skills);
  const skillKeys = [...new Set([...beforeSkillKeys, ...afterSkillKeys])].sort();
  const skills: Record<string, { before: number; after: number; delta: number }> = {};
  for (const key of skillKeys) {
    const beforeValue = before.skills[key] ?? 0;
    const afterValue = after.skills[key] ?? 0;
    if (beforeValue !== afterValue) {
      skills[key] = { before: beforeValue, after: afterValue, delta: afterValue - beforeValue };
    }
  }

  return { scalars, relationships, skills };
}

function hasDebugDelta(delta: Record<string, unknown>): boolean {
  const scalars = delta.scalars as Record<string, unknown> | undefined;
  const relationships = delta.relationships as unknown[] | undefined;
  const skills = delta.skills as Record<string, unknown> | undefined;
  return Boolean(
    scalars && Object.keys(scalars).length > 0 ||
    relationships && relationships.length > 0 ||
    skills && Object.keys(skills).length > 0
  );
}

function previewText(value: string, limit = 240): string {
  const singleLine = value.replace(/\s+/g, " ").trim();
  return singleLine.length > limit ? `${singleLine.slice(0, limit)}...` : singleLine;
}

function envFlag(name: string): boolean {
  const value = process.env[name]?.toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function buildSchedulerPlan(
  focusActorId: string,
  actors: Actor[],
  targetActorId: string | undefined,
  turnIndex: number,
  scheduler: SchedulerRuntimeSettings,
) {
  const participants = targetActorId ? [focusActorId, targetActorId] : [focusActorId];
  const backgroundAgents = selectBackgroundActors(actors, participants, turnIndex, scheduler)
    .map((actor) => actor.id);
  return {
    participants,
    observers: [],
    background_agents: backgroundAgents,
    inactive_agents: actors
      .map((actor) => actor.id)
      .filter((actorId) => !participants.includes(actorId) && !backgroundAgents.includes(actorId)),
  };
}

function selectBackgroundActors(
  actors: Actor[],
  excludedActorIds: string[],
  _turnIndex: number,
  _scheduler: SchedulerRuntimeSettings,
): Actor[] {
  return actors.filter((actor) => !excludedActorIds.includes(actor.id));
}

function getActionTargetActorId(action: SimAction): string | undefined {
  return "actor_id" in action ? action.actor_id : undefined;
}

async function evaluateInteractionIfNeeded(args: {
  agentDriver: AgentDriver;
  debug: SimulationDebugLogger;
  runId: string;
  turnId: string;
  turnIndex: number;
  day: number;
  slot: TimeSlot;
  hour: number;
  locationId: string;
  worldContext?: AgentWorldContext;
  actorStates: Record<string, LifeState>;
  actors: Actor[];
  events: Event[];
  selected: SimAction;
  initiatorActorId: string;
  initiatorResponse: AgentTurnResponse;
  targetResponse?: AgentTurnResponse;
}): Promise<InteractionEvaluationResponse | undefined> {
  const targetActorId = getActionTargetActorId(args.selected);
  if (!targetActorId) return undefined;
  const initiatorState = args.actorStates[args.initiatorActorId];
  const targetState = args.actorStates[targetActorId];
  if (!initiatorState || !targetState) return undefined;

  const request: InteractionEvaluationRequest = {
    type: "yume.interaction_evaluation_request",
    run_id: args.runId,
    turn_id: args.turnId,
    clock: {
      turn_index: args.turnIndex,
      day: args.day,
      time_slot: args.slot,
      sim_hour: args.hour,
    },
    evaluator_id: `${args.initiatorActorId}:interaction_evaluator`,
    location_id: args.locationId,
    world_context: args.worldContext,
    initiator_actor_id: args.initiatorActorId,
    target_actor_id: targetActorId,
    selected_action: args.selected,
    initiator_response: {
      reasoning: args.initiatorResponse.reasoning,
      utterance: args.initiatorResponse.utterance,
      proposed_memory_updates: args.initiatorResponse.proposed_memory_updates,
    },
    target_response: args.targetResponse
      ? {
          reasoning: args.targetResponse.reasoning,
          utterance: args.targetResponse.utterance,
          proposed_memory_updates: args.targetResponse.proposed_memory_updates,
        }
      : undefined,
    initiator_state: initiatorState,
    target_state: targetState,
    recent_events: args.events.slice(-ORCHESTRATOR_LIMITS.recent_event_count),
  };

  args.debug({
    kind: "interaction.evaluator.request",
    turn_id: args.turnId,
    day: args.day,
    slot: args.slot,
    sim_hour: args.hour,
    actor_id: args.initiatorActorId,
    message: "Interaction evaluator request prepared.",
    data: summarizeInteractionEvaluationRequestForDebug(request),
  });

  let rawEvaluation: InteractionEvaluationResponse;
  try {
    rawEvaluation = args.agentDriver.evaluateInteraction
      ? await withTimeout(
          args.agentDriver.evaluateInteraction(request),
          ORCHESTRATOR_LIMITS.agent_turn_timeout_ms,
        )
      : defaultInteractionEvaluation(request);
  } catch (error) {
    if (isAbortError(error)) throw error;
    args.debug({
      kind: "interaction.evaluator.fallback",
      turn_id: args.turnId,
      day: args.day,
      slot: args.slot,
      sim_hour: args.hour,
      actor_id: args.initiatorActorId,
      message: "Interaction evaluator failed; using neutral fallback.",
      data: { reason: error instanceof Error ? error.message : String(error) },
    });
    rawEvaluation = neutralInteractionEvaluation(request, "Evaluator unavailable; neutral fallback used.");
  }

  const evaluation = ensureInteractionParticipantDeltas(
    sanitizeInteractionEvaluation(rawEvaluation, request, Object.keys(args.actorStates), args.actors),
    request,
  );
  args.debug({
    kind: "interaction.evaluator.response",
    turn_id: args.turnId,
    day: args.day,
    slot: args.slot,
    sim_hour: args.hour,
    actor_id: args.initiatorActorId,
    message: `Interaction evaluator outcome: ${evaluation.outcome}.`,
    data: summarizeInteractionEvaluationForDebug(evaluation),
  });
  return evaluation;
}

function ensureInteractionParticipantDeltas(
  evaluation: InteractionEvaluationResponse,
  request: InteractionEvaluationRequest,
): InteractionEvaluationResponse {
  const hasInitiatorToTarget = evaluation.relationship_deltas.some((delta) =>
    delta.from_actor_id === request.initiator_actor_id && delta.to_actor_id === request.target_actor_id
  );
  const hasTargetToInitiator = evaluation.relationship_deltas.some((delta) =>
    delta.from_actor_id === request.target_actor_id && delta.to_actor_id === request.initiator_actor_id
  );
  if (hasInitiatorToTarget && hasTargetToInitiator) return evaluation;
  return {
    ...evaluation,
    relationship_deltas: [
      ...evaluation.relationship_deltas,
      ...(!hasInitiatorToTarget ? [{
        from_actor_id: request.initiator_actor_id,
        to_actor_id: request.target_actor_id,
        closeness: 0,
        trust: 0,
        tension: 0,
        reset_last_interaction: true,
      }] : []),
      ...(!hasTargetToInitiator ? [{
        from_actor_id: request.target_actor_id,
        to_actor_id: request.initiator_actor_id,
        closeness: 0,
        trust: 0,
        tension: 0,
        reset_last_interaction: true,
      }] : []),
    ],
  };
}

function applyInteractionEvaluation(
  actorStates: Record<string, LifeState>,
  evaluation: InteractionEvaluationResponse,
): void {
  for (const delta of evaluation.relationship_deltas) {
    const fromState = actorStates[delta.from_actor_id];
    if (!fromState) continue;
    actorStates[delta.from_actor_id] = {
      ...fromState,
      relationships: applyRelationshipDelta(fromState.relationships, delta),
    };
  }

  for (const delta of evaluation.actor_state_deltas) {
    const state = actorStates[delta.actor_id];
    if (!state) continue;
    actorStates[delta.actor_id] = {
      ...state,
      energy: clampMeter(state.energy + (delta.energy ?? 0)),
      health: clampMeter(state.health + (delta.health ?? 0)),
      stress: clampMeter(state.stress + (delta.stress ?? 0)),
      mood: clampMeter(state.mood + (delta.mood ?? 0)),
      job_satisfaction: clampMeter(state.job_satisfaction + (delta.job_satisfaction ?? 0)),
    };
  }
}

function applyRelationshipDelta(
  relationships: LifeState["relationships"],
  delta: InteractionEvaluationResponse["relationship_deltas"][number],
): LifeState["relationships"] {
  const existing = relationships.find((relationship) => relationship.actor_id === delta.to_actor_id);
  const base = existing ?? {
    actor_id: delta.to_actor_id,
    ...INITIAL_STATE_DEFAULTS.new_relationship,
  };
  const next = {
    ...base,
    closeness: clampMeter(base.closeness + (delta.closeness ?? 0)),
    trust: clampMeter(base.trust + (delta.trust ?? 0)),
    tension: clampMeter(base.tension + (delta.tension ?? 0)),
    last_interaction_day: delta.reset_last_interaction ? 0 : base.last_interaction_day,
  };
  if (existing) {
    return relationships.map((relationship) =>
      relationship.actor_id === delta.to_actor_id ? next : relationship,
    );
  }
  return [...relationships, next];
}

async function collectBackgroundResponses(args: {
  agentDriver: AgentDriver;
  debug: SimulationDebugLogger;
  runId: string;
  turnId: string;
  turnIndex: number;
  day: number;
  slot: TimeSlot;
  hour: number;
  currentLocationId: string;
  worldContext?: AgentWorldContext;
  actorStates: Record<string, LifeState>;
  actors: Actor[];
  focusActorId: string;
  targetActorId?: string;
  scheduler: SchedulerRuntimeSettings;
  events: Event[];
  emit: (event: Event) => void;
  nextSeq: () => number;
  wallClock: () => string;
  store: SimulatorStore;
}): Promise<AgentTurnResponse[]> {
  const selectedBackgroundActors = selectBackgroundActors(
    args.actors,
    [args.focusActorId, args.targetActorId].filter((actorId): actorId is string => Boolean(actorId)),
    args.turnIndex,
    args.scheduler,
  );
  const responses = await Promise.all(selectedBackgroundActors.map(async (actor) => {
    const state = args.actorStates[actor.id];
    if (!state) return undefined;
    const localActorIds = args.actors
      .map((candidate) => candidate.id)
      .filter((actorId) => actorId !== actor.id);
    const reachableActorIds = state.relationships.map((relationship) => relationship.actor_id);
    const availableActions = getAvailableActions(state, args.slot, localActorIds, reachableActorIds);
    const request: AgentTurnRequest = {
      type: "yume.turn_request",
      run_id: args.runId,
      turn_id: args.turnId,
      clock: {
        turn_index: args.turnIndex,
        day: args.day,
        time_slot: args.slot,
        sim_hour: args.hour,
      },
      agent_id: actor.id,
      task: "background_update",
      world_snapshot: {
        actor_profile: buildAgentActorProfile(actor),
        location_id: args.currentLocationId,
        focus_actor_id: args.focusActorId,
        world_context: args.worldContext,
        life_state: state,
        observed_actors: buildObservedActors(
          actor.id,
          args.focusActorId,
          args.actorStates,
          args.actors,
          visibleActorIdsForActor(actor.id, args.currentLocationId, state, {}),
        ),
        known_actors: buildKnownActors(actor.id, args.actorStates, args.actors),
        recent_events: args.events.slice(-ORCHESTRATOR_LIMITS.recent_event_count),
      },
      available_actions: availableActionsForAgent(availableActions),
    };
    const response = await requestAgentTurnWithRetry({
      agentDriver: args.agentDriver,
      request,
      debug: args.debug,
      emit: args.emit,
      nextSeq: args.nextSeq,
      wallClock: args.wallClock,
      day: args.day,
      slot: args.slot,
      hour: args.hour,
    });
    if (!response) return;
    if (!response.agent_id) response.agent_id = actor.id;
    validateAgentResponse(args.runId, args.turnId, response);
    validateSelectedAction(response, availableActions);
    args.store.recordPendingChange({
      runId: args.runId,
      turnId: args.turnId,
      source: actor.id,
      kind: "agent_background_update",
      payload: response,
    });
    return response;
  }));

  return responses.filter((response): response is AgentTurnResponse => Boolean(response));
}

async function recordMemoryVersion(args: {
  agentDriver: AgentDriver;
  actorSessions: ActorSession[];
  store: SimulatorStore;
  debug?: SimulationDebugLogger;
  runId: string;
  turnId: string;
  agentId: string;
  content: string;
}): Promise<void> {
  if (!args.agentId) return;
  const memoryStoreId = args.actorSessions.find((session) => session.actor_id === args.agentId)?.memory_store_id
    ?? `${ORCHESTRATOR_PROTOCOL.memory_prefix}-${args.agentId}`;
  const memoryPath = `${ORCHESTRATOR_PROTOCOL.episodic_memory_path}/${args.turnId}-${args.agentId}.md`;
  const memoryVersion = args.agentDriver.recordMemoryUpdate
    ? await args.agentDriver.recordMemoryUpdate({
        runId: args.runId,
        turnId: args.turnId,
        agentId: args.agentId,
        memoryStoreId,
        memoryPath,
        content: args.content,
      })
    : {
        memoryVersionId: deterministicVersionId(args.runId, args.turnId, args.agentId, args.content),
      };
  args.store.recordMemoryVersion({
    runId: args.runId,
    turnId: args.turnId,
    agentId: args.agentId,
    memoryStoreId,
    memoryPath,
    memoryVersionId: memoryVersion.memoryVersionId,
    writeMode: "orchestrator_reviewed",
    status: "committed",
  });
  args.debug?.({
    kind: "memory.write",
    turn_id: args.turnId,
    actor_id: args.agentId,
    message: "Episodic memory version committed.",
    data: {
      memory_store_id: memoryStoreId,
      memory_path: memoryPath,
      memory_version_id: memoryVersion.memoryVersionId,
      content_preview: previewText(args.content),
    },
  });
}

async function recordRelationshipNote(args: {
  agentDriver: AgentDriver;
  actorSessions: ActorSession[];
  store: SimulatorStore;
  debug?: SimulationDebugLogger;
  runId: string;
  turnId: string;
  agentId: string;
  targetActorId: string;
  content: string;
}): Promise<void> {
  if (!args.agentId) return;
  const session = args.actorSessions.find((candidate) => candidate.actor_id === args.agentId);
  const memoryStoreId = session?.relationship_memory_store_id
    ?? session?.memory_store_id
    ?? `${ORCHESTRATOR_PROTOCOL.relationship_memory_prefix}-${args.agentId}`;
  const memoryPath = `${ORCHESTRATOR_PROTOCOL.relationship_memory_path}/${args.targetActorId}.md`;
  const content = [
    `# Relationship: ${args.targetActorId}`,
    "",
    `- turn_id: ${args.turnId}`,
    `- note: ${args.content}`,
  ].join("\n");
  const memoryVersion = args.agentDriver.recordMemoryUpdate
    ? await args.agentDriver.recordMemoryUpdate({
        runId: args.runId,
        turnId: args.turnId,
        agentId: args.agentId,
        memoryStoreId,
        memoryPath,
        content,
      })
    : {
        memoryVersionId: deterministicVersionId(args.runId, args.turnId, args.agentId, content),
      };
  args.store.recordMemoryVersion({
    runId: args.runId,
    turnId: args.turnId,
    agentId: args.agentId,
    memoryStoreId,
    memoryPath,
    memoryVersionId: memoryVersion.memoryVersionId,
    writeMode: "orchestrator_reviewed",
    status: "committed",
  });
  args.debug?.({
    kind: "memory.write",
    turn_id: args.turnId,
    actor_id: args.agentId,
    message: "Relationship memory version committed.",
    data: {
      target_actor_id: args.targetActorId,
      memory_store_id: memoryStoreId,
      memory_path: memoryPath,
      memory_version_id: memoryVersion.memoryVersionId,
      content_preview: previewText(content),
    },
  });
}

async function recordMonthlySummary(args: {
  agentDriver: AgentDriver;
  actorSessions: ActorSession[];
  store: SimulatorStore;
  debug?: SimulationDebugLogger;
  runId: string;
  turnId: string;
  agentId: string;
  monthIndex: number;
  state: LifeState;
}): Promise<void> {
  if (!args.agentId) return;
  const session = args.actorSessions.find((candidate) => candidate.actor_id === args.agentId);
  const memoryStoreId = session?.memory_store_id
    ?? `${ORCHESTRATOR_PROTOCOL.memory_prefix}-${args.agentId}`;
  const memoryPath = `${ORCHESTRATOR_PROTOCOL.monthly_summary_path}/month_${String(args.monthIndex).padStart(ORCHESTRATOR_LIMITS.id_pad_width, "0")}.md`;
  const content = [
    `# Month ${args.monthIndex} summary`,
    "",
    `Energy ended ${args.state.energy}/${SIMULATION_BOUNDS.max_meter}.`,
    `Stress ended ${args.state.stress}/${SIMULATION_BOUNDS.max_meter}.`,
    `Health ended ${args.state.health}/${SIMULATION_BOUNDS.max_meter}.`,
    `Money remained under orchestrator control and is not a memory source of truth.`,
  ].join("\n");
  const memoryVersion = args.agentDriver.recordMemoryUpdate
    ? await args.agentDriver.recordMemoryUpdate({
        runId: args.runId,
        turnId: args.turnId,
        agentId: args.agentId,
        memoryStoreId,
        memoryPath,
        content,
      })
    : {
        memoryVersionId: deterministicVersionId(args.runId, args.turnId, args.agentId, content),
      };
  args.store.recordMemoryVersion({
    runId: args.runId,
    turnId: args.turnId,
    agentId: args.agentId,
    memoryStoreId,
    memoryPath,
    memoryVersionId: memoryVersion.memoryVersionId,
    writeMode: "orchestrator_reviewed",
    status: "committed",
  });
  args.debug?.({
    kind: "memory.write",
    turn_id: args.turnId,
    actor_id: args.agentId,
    message: "Monthly summary memory version committed.",
    data: {
      month_index: args.monthIndex,
      memory_store_id: memoryStoreId,
      memory_path: memoryPath,
      memory_version_id: memoryVersion.memoryVersionId,
      content_preview: previewText(content),
    },
  });
}

function buildActors(input: ParsedRunInput, runModelId: SupportedModelId): Actor[] {
  if (input.actors?.length) return buildGenericActors(input, runModelId);
  if (!input.protagonist) throw new Error("RunInput requires actors[] or protagonist");
  const protagonist: Actor = {
    id: "protagonist",
    display_name: input.protagonist.name,
    role: "focus_actor",
    is_focus: true,
    age: input.protagonist.age,
    gender: input.protagonist.gender,
    mbti: input.protagonist.mbti,
    profile: input.protagonist.profile,
    values: input.protagonist.values,
    interests: input.protagonist.interests,
    fears: input.protagonist.fears,
    goals: [],
    constraints: [],
    relation_to_focus: "self",
    relation_to_protagonist: "self",
    schedule: input.protagonist.schedule,
    model: runModelId,
  };

  const supportingInputs = normalizeSupporting(input.supporting ?? []);
  const supportingActors = supportingInputs.map((supporting, index) =>
    buildSupportingActor(supporting, protagonist, index, runModelId),
  );
  return [protagonist, ...supportingActors];
}

function buildGenericActors(input: ParsedRunInput, runModelId: SupportedModelId): Actor[] {
  const rawActors = input.actors ?? [];
  const usedIds = new Set<string>();
  const normalized = rawActors.map((actor, index) => {
    const id = allocateActorId(actor.id ?? actor.name ?? actor.display_name ?? actor.role, index, usedIds);
    return { id, input: actor, index };
  });
  const focusActorId = resolveFocusActorId(input.focus_actor_id, normalized)
    ?? normalized.find((actor) => actor.input.is_focus)?.id
    ?? normalized[ORCHESTRATOR_LIMITS.initial_sequence]?.id;
  if (!focusActorId) throw new Error("RunInput actors[] must not be empty");
  if (!normalized.some((actor) => actor.id === focusActorId)) {
    throw new Error(`focus_actor_id does not match any actor: ${focusActorId}`);
  }
  if (normalized.length > ORCHESTRATOR_LIMITS.max_actors) {
    throw new Error(`actors[] exceeds max_actors=${ORCHESTRATOR_LIMITS.max_actors}`);
  }

  return normalized.map(({ id, input: actor, index }) => {
    const role = actor.role ?? "participant";
    const roleDefaults = ROLE_DEFAULTS[role] ?? DEFAULT_ROLE_PROFILE;
    const isFocus = id === focusActorId;
    const displayName = actor.display_name ?? actor.name ?? roleDefaults.label;
    const age = actor.age ?? Math.max(
      SIMULATION_BOUNDS.min_age,
      Math.min(SIMULATION_BOUNDS.max_age, 30 + roleDefaults.ageOffset),
    );
    const gender = actor.gender ?? roleDefaults.gender;
    const mbti = actor.mbti ?? deterministicMbti(`${id}:${displayName}:${index}`);
    const profile = [
      `${displayName} is ${age}, ${gender}.`,
      actor.profile ?? actor.memo ?? `${displayName} participates as ${role}.`,
    ].join(" ");
    return {
      id,
      display_name: displayName,
      role,
      is_focus: isFocus,
      age,
      gender,
      mbti,
      profile,
      values: actor.values,
      interests: actor.interests,
      fears: actor.fears,
      goals: actor.goals ?? [],
      constraints: actor.constraints ?? [],
      relation_to_focus: actor.relation_to_focus ?? actor.relation_to_protagonist ?? (isFocus ? "self" : roleDefaults.relation),
      relation_to_protagonist: actor.relation_to_protagonist,
      schedule: actor.schedule,
      initial_state: actor.initial_state,
      initial_location_id: actor.initial_location_id,
      metadata: actor.metadata,
      model: runModelId,
    };
  });
}

function resolveFocusActorId(
  requestedFocusActorId: string | undefined,
  normalized: Array<{ id: string; input: NonNullable<ParsedRunInput["actors"]>[number]; index: number }>,
): string | undefined {
  if (!requestedFocusActorId) return undefined;
  const requestedSlug = slugActorId(requestedFocusActorId);
  const match = normalized.find(({ id, input }) =>
    id === requestedFocusActorId ||
    id === requestedSlug ||
    input.id === requestedFocusActorId ||
    input.display_name === requestedFocusActorId ||
    input.name === requestedFocusActorId ||
    slugActorId(input.id) === requestedSlug ||
    slugActorId(input.display_name) === requestedSlug ||
    slugActorId(input.name) === requestedSlug,
  );
  return match?.id ?? requestedFocusActorId;
}

function createInitialActorStates(actors: Actor[]): Record<string, LifeState> {
  const states: Record<string, LifeState> = {};
  for (const actor of actors) {
    const otherActorIds = actors.map((candidate) => candidate.id).filter((actorId) => actorId !== actor.id);
    const inferred = createInitialState(
      { age: actor.age, profile: actor.profile },
      [],
    );
    states[actor.id] = applyInitialStatePatch(inferred, actor.initial_state, otherActorIds);
  }
  return states;
}

function createInitialActorLocations(
  input: ParsedRunInput,
  locations: Location[],
  actors: Actor[],
): ActorLocationMap {
  return Object.fromEntries(
    actors.map((actor) => [
      actor.id,
      selectInitialLocationId(input, locations, actor),
    ]),
  );
}

function applyInitialStatePatch(
  inferred: LifeState,
  patch: Actor["initial_state"],
  otherActorIds: string[],
): LifeState {
  if (!patch) return inferred;
  const patchRelationships = patch.relationships ?? [];
  const relationshipsByActor = new Map<string, LifeState["relationships"][number]>();
  for (const relationship of patchRelationships) {
    if (!otherActorIds.includes(relationship.actor_id)) continue;
    relationshipsByActor.set(relationship.actor_id, relationship);
  }
  const relationships = [...relationshipsByActor.values()];
  return LifeStateSchema.parse({
    ...inferred,
    ...patch,
    relationships,
    skills: {
      ...inferred.skills,
      ...(patch.skills ?? {}),
    },
  });
}

function cloneActorStates(actorStates: Record<string, LifeState>): Record<string, LifeState> {
  return Object.fromEntries(
    Object.entries(actorStates).map(([actorId, state]) => [
      actorId,
      {
        ...state,
        relationships: state.relationships.map((relationship) => ({ ...relationship })),
        skills: { ...state.skills },
      },
    ]),
  );
}

function normalizeSupporting(supporting: SupportingActorInput[]): SupportingActorInput[] {
  if (supporting.length >= ORCHESTRATOR_LIMITS.min_supporting_actors) {
    return supporting.slice(0, ORCHESTRATOR_LIMITS.max_supporting_actors);
  }
  return [...supporting, ...DEFAULT_SUPPORTING_ACTORS]
    .slice(0, ORCHESTRATOR_LIMITS.min_supporting_actors);
}

function buildSupportingActor(
  input: SupportingActorInput,
  protagonist: Actor,
  index: number,
  model: Actor["model"],
): Actor {
  const roleDefaults = ROLE_DEFAULTS[input.role] ?? DEFAULT_ROLE_PROFILE;
  const id = uniqueActorId(input.role, index);
  const displayName = input.display_name ?? roleDefaults.label;
  const inference = inferSupportingDefaults(displayName, input.memo);
  const ageOffset = inference?.ageOffset ?? roleDefaults.ageOffset;
  const age = input.age ?? Math.max(
    SIMULATION_BOUNDS.min_age,
    Math.min(SIMULATION_BOUNDS.max_age, protagonist.age + ageOffset),
  );
  const gender = input.gender ?? inference?.gender ?? roleDefaults.gender;
  const mbti = input.mbti ?? deterministicMbti(`${id}:${displayName}:${index}`);
  const profile = [
    `${displayName} is ${age}, ${gender}.`,
    input.memo ?? `${displayName} is the focus actor's ${roleDefaults.relation}.`,
  ].join(" ");
  return {
    id,
    display_name: displayName,
    role: input.role,
    is_focus: false,
    age,
    gender,
    mbti,
    profile,
    goals: [],
    constraints: [],
    relation_to_focus: roleDefaults.relation,
    relation_to_protagonist: roleDefaults.relation,
    schedule: input.schedule,
    model,
  };
}

function inferSupportingDefaults(
  displayName: string,
  memo?: string,
): { ageOffset?: number; gender?: string } | undefined {
  const text = `${displayName} ${memo ?? ""}`;
  const rule = SUPPORTING_ACTOR_INFERENCE.find((candidate) => candidate.pattern.test(text));
  if (!rule) return undefined;
  return {
    ageOffset: rule.ageOffset,
    gender: rule.genderByPattern.find((candidate) => candidate.pattern.test(text))?.gender,
  };
}

function uniqueActorId(role: ActorRole, index: number): string {
  const base = slugActorId(role) || "actor";
  return index === ORCHESTRATOR_LIMITS.initial_sequence ? base : `${base}_${index + 1}`;
}

function allocateActorId(rawId: string | undefined, index: number, usedIds: Set<string>): string {
  const base = slugActorId(rawId) || `actor_${index + 1}`;
  let candidate = base;
  let suffix = 2;
  while (usedIds.has(candidate)) {
    candidate = `${base}_${suffix}`;
    suffix += 1;
  }
  usedIds.add(candidate);
  return candidate;
}

function slugActorId(value: string | undefined): string {
  if (!value) return "";
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return slug.slice(0, 64);
}

function deterministicMbti(key: string): MBTIType {
  return MBTI_TYPES[Math.abs(hash(key)) % MBTI_TYPES.length]!;
}

function buildLocations(input: ParsedRunInput, focusActor: Actor, actors: Actor[]): Location[] {
  if (input.world?.locations?.length) {
    return normalizeLocationResidents(input.world.locations, input, actors);
  }
  if (input.world?.buildings?.length) {
    return normalizeLocationResidents(input.world.buildings.map((building) => ({
      id: building.id,
      display_name: building.display_name,
      description: building.description ?? `${building.display_name} (${building.kind})`,
      resident_actor_ids: building.resident_actor_ids,
      kind: building.kind,
      building_id: building.id,
      position: building.position,
      metadata: building.metadata,
    })), input, actors);
  }
  const workLocation = LOCATION_PROFILE_PATTERNS.school.test(focusActor.profile)
    ? LOCATION_TEMPLATES.school
    : LOCATION_TEMPLATES.workplace;
  return normalizeLocationResidents([
    { ...LOCATION_TEMPLATES.home },
    { ...workLocation },
    { ...LOCATION_TEMPLATES.cafe },
    { ...LOCATION_TEMPLATES.park },
  ], input, actors);
}

function normalizeLocationResidents(
  locations: Location[],
  input: ParsedRunInput,
  actors: Actor[],
): Location[] {
  const actorIds = new Set(actors.map((actor) => actor.id));
  const aliases = buildActorAliasMap(input, actors);
  const next = locations.map((location) => {
    const residents = new Set<string>();
    for (const rawResident of location.resident_actor_ids) {
      const mapped = aliases.get(rawResident) ?? aliases.get(slugActorId(rawResident)) ?? rawResident;
      if (actorIds.has(mapped)) residents.add(mapped);
    }
    return { ...location, resident_actor_ids: [...residents] };
  });
  distributeUnassignedResidents(next, actors);
  return next;
}

function buildActorAliasMap(input: ParsedRunInput, actors: Actor[]): Map<string, string> {
  const aliases = new Map<string, string>();
  const rawActors = input.actors ?? [];
  actors.forEach((actor, index) => {
    for (const alias of [
      actor.id,
      actor.display_name,
      rawActors[index]?.id,
      rawActors[index]?.display_name,
      rawActors[index]?.name,
    ]) {
      if (!alias) continue;
      aliases.set(alias, actor.id);
      aliases.set(slugActorId(alias), actor.id);
    }
  });
  if (input.protagonist && actors[0]) {
    aliases.set(input.protagonist.name, actors[0].id);
    aliases.set(slugActorId(input.protagonist.name), actors[0].id);
  }
  return aliases;
}

function distributeUnassignedResidents(
  locations: Location[],
  actors: Actor[],
): void {
  if (locations.length === 0) return;
  const assigned = new Set(locations.flatMap((location) => location.resident_actor_ids));
  const leastPopulatedLocation = (): Location =>
    locations.reduce((best, location) =>
      location.resident_actor_ids.length < best.resident_actor_ids.length ? location : best,
    locations[0]!);

  for (const actor of actors) {
    if (assigned.has(actor.id)) continue;
    const target = leastPopulatedLocation();
    target.resident_actor_ids = [...target.resident_actor_ids, actor.id];
    assigned.add(actor.id);
  }
}

function selectInitialLocationId(input: ParsedRunInput, locations: Location[], actor: Actor): string {
  if (actor.initial_location_id && locations.some((l) => l.id === actor.initial_location_id)) {
    return actor.initial_location_id;
  }
  const residentLocation = locations.find((location) => location.resident_actor_ids.includes(actor.id));
  if (residentLocation) return residentLocation.id;
  const scheduled = actor.schedule?.Mon?.morning;
  if (scheduled && locations.some((location) => location.id === scheduled)) return scheduled;
  return locations[0]?.id ?? "home";
}

function buildAgentWorldContext(
  input: ParsedRunInput,
  locations: Location[],
  currentLocationId: string,
): AgentWorldContext | undefined {
  if (!input.world) return undefined;
  const buildings = input.world.buildings ?? [];
  const currentLocation = locations.find((location) => location.id === currentLocationId);
  const currentBuilding = currentLocation?.building_id
    ? buildings.find((building) => building.id === currentLocation.building_id)
    : buildings.find((building) => building.id === currentLocationId);
  return {
    current_location: currentLocation,
    current_building: currentBuilding,
    locations,
    buildings,
    nearby_buildings: buildNearbyBuildings(input, buildings, currentLocation, currentBuilding),
    paths: input.world.paths ?? [],
    distance_matrix: input.world.distance_matrix,
  };
}

function buildNearbyBuildings(
  input: ParsedRunInput,
  buildings: WorldBuilding[],
  currentLocation: Location | undefined,
  currentBuilding: WorldBuilding | undefined,
): AgentWorldContext["nearby_buildings"] {
  if (!buildings.length) return [];
  const originId = currentBuilding?.id ?? currentLocation?.building_id ?? currentLocation?.id;
  const originPosition = currentBuilding?.position ?? currentLocation?.position;
  return buildings
    .filter((building) => building.id !== originId)
    .map((building) => ({
      building_id: building.id,
      display_name: building.display_name,
      kind: building.kind,
      distance_meters: resolveDistanceMeters(input, originId, originPosition, building),
    }))
    .sort((left, right) => left.distance_meters - right.distance_meters)
    .slice(0, ORCHESTRATOR_LIMITS.nearby_building_limit);
}

function resolveDistanceMeters(
  input: ParsedRunInput,
  originId: string | undefined,
  originPosition: Location["position"],
  target: WorldBuilding,
): number {
  if (originId) {
    const matrixDistance = input.world?.distance_matrix?.[originId]?.[target.id]
      ?? input.world?.distance_matrix?.[target.id]?.[originId];
    if (matrixDistance !== undefined) return matrixDistance;
    const path = input.world?.paths?.find((candidate) =>
      (candidate.from_id === originId && candidate.to_id === target.id) ||
      (candidate.bidirectional && candidate.from_id === target.id && candidate.to_id === originId)
    );
    if (path?.distance_meters !== undefined) return path.distance_meters;
  }
  if (originPosition) return distanceMeters(originPosition, target.position);
  return Number.POSITIVE_INFINITY;
}

function resolveMovementDistance(
  input: ParsedRunInput,
  locations: Location[],
  fromId: string,
  toId: string,
): number {
  const fromLoc = locations.find((l) => l.id === fromId);
  const toLoc = locations.find((l) => l.id === toId);
  if (fromLoc?.position && toLoc?.position) return distanceMeters(fromLoc.position, toLoc.position);
  const buildings = input.world?.buildings ?? [];
  const fromBuilding = buildings.find((b) => b.id === fromId);
  const toBuilding = buildings.find((b) => b.id === toId);
  if (fromBuilding && toBuilding) {
    return resolveDistanceMeters(input, fromId, fromBuilding.position, toBuilding);
  }
  return 0;
}

function distanceMeters(
  a: NonNullable<Location["position"]>,
  b: NonNullable<Location["position"]>,
): number {
  const dy = (a.y ?? 0) - (b.y ?? 0);
  const dz = (a.z ?? 0) - (b.z ?? 0);
  return Math.round(Math.hypot(a.x - b.x, dy, dz));
}

function buildSchedulerRuntime(input: ParsedRunInput): SchedulerRuntimeSettings {
  return {
    maxActiveActorsPerTurn: input.scheduler?.max_active_actors_per_turn
      ?? ORCHESTRATOR_LIMITS.default_max_active_actors_per_turn,
    backgroundUpdateIntervalTurns: input.scheduler?.background_update_interval_turns
      ?? ORCHESTRATOR_LIMITS.background_update_interval_turns,
  };
}

function buildWorldSnapshot(args: {
  runId: string;
  turnId: string;
  turnIndex: number;
  day: number;
  slot: TimeSlot;
  hour: number;
  locationId: string;
  focusActorId: string;
  worldContext?: AgentWorldContext;
  state: LifeState;
  actorStates: Record<string, LifeState>;
  actorLocations: ActorLocationMap;
  events: Event[];
  availableActions: AvailableAction[];
  availableActionsByActor?: Map<string, AvailableAction[]>;
}) {
  return {
    run_id: args.runId,
    turn_id: args.turnId,
    clock: {
      turn_index: args.turnIndex,
      day: args.day,
      time_slot: args.slot,
      sim_hour: args.hour,
    },
    location_id: args.locationId,
    focus_actor_id: args.focusActorId,
    world_context: args.worldContext,
    life_state: args.state,
    actor_states: cloneActorStates(args.actorStates),
    actor_locations: { ...args.actorLocations },
    recent_events: args.events.slice(-ORCHESTRATOR_LIMITS.recent_event_count),
    available_actions: availableActionsForAgent(args.availableActions),
    available_actions_by_actor: args.availableActionsByActor
      ? Object.fromEntries(
          [...args.availableActionsByActor.entries()].map(([actorId, actions]) => [
            actorId,
            availableActionsForAgent(actions),
          ]),
        )
      : undefined,
  };
}

function buildAgentActorProfile(actor: Actor): AgentActorProfile {
  return {
    actor_id: actor.id,
    display_name: actor.display_name,
    role: actor.role,
    age: actor.age,
    gender: actor.gender,
    profile: actor.profile,
    values: actor.values,
    interests: actor.interests,
    fears: actor.fears,
    goals: actor.goals,
    constraints: actor.constraints,
    relation_to_focus: actor.relation_to_focus,
    behavior_traits: MBTI_BEHAVIOR_GUIDE[actor.mbti],
  };
}

function buildObservedActors(
  observerActorId: string,
  focusActorId: string,
  actorStates: Record<string, LifeState>,
  actors: Actor[],
  visibleActorIds?: string[],
): AgentObservedState[] {
  const observerState = actorStates[observerActorId];
  const visibleActorIdSet = visibleActorIds ? new Set(visibleActorIds) : undefined;
  const actorsById = new Map(actors.map((actor) => [actor.id, actor]));
  return Object.entries(actorStates)
    .filter(([actorId]) => actorId !== observerActorId && (!visibleActorIdSet || visibleActorIdSet.has(actorId)))
    .sort(([left], [right]) => {
      if (left === focusActorId) return -1;
      if (right === focusActorId) return 1;
      return left.localeCompare(right);
    })
    .map(([actorId, state]) => {
      const actor = actorsById.get(actorId);
      const relationship = observerState?.relationships.find((candidate) => candidate.actor_id === actorId);
      return {
        actor_id: actorId,
        display_name: actor?.display_name ?? humanizeInternalId(actorId),
        role: actor?.role ?? "participant",
        energy_hint: meterHint(state.energy),
        stress_hint: meterHint(state.stress),
        mood_hint: meterHint(state.mood),
        health_hint: state.health < 50 ? "fragile" : "stable",
        financial_hint: state.money < state.monthly_expenses
          ? "strained"
          : state.money > state.monthly_expenses * 6
            ? "secure"
            : "stable",
        work_satisfaction_hint: state.job_satisfaction < 35
          ? "low"
          : state.job_satisfaction > 70
            ? "high"
            : "mixed",
        relationship_to_self: relationship
          ? {
              closeness_hint: relationship.closeness > 70
                ? "close"
                : relationship.closeness < 30
                  ? "distant"
                  : "familiar",
              trust_hint: meterHint(relationship.trust),
              tension_hint: meterHint(relationship.tension),
            }
          : undefined,
      };
    });
}

function buildKnownActors(
  observerActorId: string,
  actorStates: Record<string, LifeState>,
  actors: Actor[],
): AgentKnownActor[] {
  const observerState = actorStates[observerActorId];
  if (!observerState) return [];
  const actorsById = new Map(actors.map((actor) => [actor.id, actor]));
  return observerState.relationships.map((relationship) => {
    const actor = actorsById.get(relationship.actor_id);
    return {
      actor_id: relationship.actor_id,
      display_name: actor?.display_name ?? humanizeInternalId(relationship.actor_id),
      role: actor?.role ?? "participant",
      relationship_to_self: {
        closeness_hint: relationship.closeness > 70
          ? "close"
          : relationship.closeness < 30
            ? "distant"
            : "familiar",
        trust_hint: meterHint(relationship.trust),
        tension_hint: meterHint(relationship.tension),
      },
    };
  });
}

function visibleActorIdsForActor(
  observerActorId: string,
  currentLocationId: string,
  _observerState: LifeState,
  actorLocations: ActorLocationMap,
  requiredActorIds: string[] = [],
): string[] {
  const visible = new Set<string>(requiredActorIds.filter((actorId) => actorId !== observerActorId));
  for (const [actorId, locationId] of Object.entries(actorLocations)) {
    if (actorId !== observerActorId && locationId === currentLocationId) visible.add(actorId);
  }
  return [...visible];
}

function meterHint(value: number): "low" | "moderate" | "high" {
  if (value < 35) return "low";
  if (value > 70) return "high";
  return "moderate";
}

function clampMeter(value: number): number {
  return Math.max(SIMULATION_BOUNDS.min_meter, Math.min(SIMULATION_BOUNDS.max_meter, value));
}

function validateAgentResponse(runId: string, turnId: string, response: AgentTurnResponse): void {
  if (response.run_id !== runId) throw new Error(`Stale agent response: expected run ${runId}, got ${response.run_id}`);
  if (response.turn_id !== turnId) throw new Error(`Stale agent response: expected turn ${turnId}, got ${response.turn_id}`);
}

function validateSelectedAction(response: AgentTurnResponse, availableActions: AvailableAction[]): void {
  if (!response.selected_action) return;
  if (typeof response.selected_action === "string") {
    try {
      response.selected_action = JSON.parse(response.selected_action as unknown as string) as unknown as SimAction;
    } catch {
      response.selected_action = { type: response.selected_action as unknown as string } as unknown as SimAction;
    }
  }
  if (typeof (response.selected_action as any).type === "string" && (response.selected_action as any).type.startsWith("{")) {
    try {
      response.selected_action = JSON.parse((response.selected_action as any).type) as unknown as SimAction;
    } catch { /* keep as-is */ }
  }
  const actionType = response.selected_action.type;
  const selectedTargetId = getActionTargetActorId(response.selected_action);
  const match = availableActions.find((candidate) => {
    if (candidate.action.type !== actionType) return false;
    const candidateTargetId = getActionTargetActorId(candidate.action);
    return selectedTargetId ? candidateTargetId === selectedTargetId : true;
  });
  if (!match) {
    if (availableActions.length === 0) return;
    const fallback = availableActions[0]!;
    console.warn(
      `[YUME] Agent selected unavailable action: ${stableActionKey(response.selected_action)} — falling back to ${stableActionKey(fallback.action)}`,
    );
    response.selected_action = { ...fallback.action };
    return;
  }
  response.selected_action = { ...match.action, ...response.selected_action };
}

function stableActionKey(action: SimAction): string {
  return JSON.stringify(Object.keys(action)
    .sort()
    .reduce<Record<string, unknown>>((result, key) => {
      result[key] = (action as unknown as Record<string, unknown>)[key];
      return result;
    }, {}));
}

function resolveLocationAfterAction(
  current: string,
  action: SimAction,
  locations: Location[],
  actor: Actor,
  weekday: string,
  slot: TimeSlot,
): string {
  const homeId = locations.find((l) => l.resident_actor_ids?.includes(actor.id))?.id;

  if (action.type === "sleep" || action.type === "cook" || action.type === "rest" ||
      action.type === "save_money" || action.type === "consider_decision" || action.type === "maintenance") {
    return homeId ?? current;
  }

  if (action.type === "work" || action.type === "study" || action.type === "commute") {
    const scheduled = actor.schedule?.[weekday as keyof typeof actor.schedule]?.[slot];
    if (scheduled && locations.some((l) => l.id === scheduled)) return scheduled;
  }

  return current;
}


function emitDecisionEvent(args: {
  emit: (event: Event) => void;
  nextSeq: () => number;
  wallClock: () => string;
  day: number;
  slot: TimeSlot;
  hour: number;
  selected: SimAction;
  fromLocationId: string;
  currentLocationId: string;
  actorId: string;
  reasoning: string;
  actors: Actor[];
}): void {
  const reasoning = sanitizePublicText(args.reasoning, args.actors);
  args.emit({
    type: "decision",
    seq: args.nextSeq(),
    day: args.day,
    slot: args.slot,
    sim_hour: args.hour,
    at_wall_clock: args.wallClock(),
    actor_id: args.actorId,
    decision: simActionToDecision(args.selected, args.hour, reasoning, args.currentLocationId),
    from_location_id: args.fromLocationId,
  });
  if (args.fromLocationId !== args.currentLocationId) {
    args.emit({
      type: "move",
      seq: args.nextSeq(),
      day: args.day,
      slot: args.slot,
      sim_hour: args.hour,
      at_wall_clock: args.wallClock(),
      actor_id: args.actorId,
      from_location_id: args.fromLocationId,
      to_location_id: args.currentLocationId,
      note: actionLabel(args.selected, args.actors),
    });
  }
  if (args.selected.type === "reach_out") {
    args.emit({
      type: "reach_out",
      seq: args.nextSeq(),
      day: args.day,
      slot: args.slot,
      sim_hour: args.hour,
      at_wall_clock: args.wallClock(),
      from_actor_id: args.actorId,
      to_actor_id: args.selected.actor_id,
      medium: "line",
      summary: reasoning,
    });
  }
}

function emitSceneEvents(args: {
  emit: (event: Event) => void;
  nextSeq: () => number;
  wallClock: () => string;
  day: number;
  slot: TimeSlot;
  hour: number;
  selected: SimAction;
  initiatorActor: Actor;
  actors: Actor[];
  locationId: string;
  response: AgentTurnResponse;
  targetResponse?: AgentTurnResponse;
}): void {
  const targetId = "actor_id" in args.selected ? args.selected.actor_id : undefined;
  const actorIds = targetId ? [args.initiatorActor.id, targetId] : [args.initiatorActor.id];
  const sceneKind = targetId
    ? "dialogue"
    : args.selected.type === "rest" || args.selected.type === "sleep"
      ? "alone"
      : "activity";

  args.emit({
    type: "scene.start",
    seq: args.nextSeq(),
    day: args.day,
    slot: args.slot,
    sim_hour: args.hour,
    at_wall_clock: args.wallClock(),
    location_id: args.locationId,
    actor_ids: actorIds,
    scene_kind: sceneKind,
    activity_label: actionLabel(args.selected, args.actors),
  });

  if (targetId) {
    const target = args.actors.find((actor) => actor.id === targetId);
    const focusUtterance = args.response.utterance
      ? sanitizePublicText(args.response.utterance, args.actors)
      : openingUtteranceForAction(args.selected, args.actors);
    args.emit({
      type: "utterance",
      seq: args.nextSeq(),
      day: args.day,
      slot: args.slot,
      sim_hour: args.hour,
      at_wall_clock: args.wallClock(),
      speaker_id: args.initiatorActor.id,
      text: focusUtterance,
    });
    args.emit({
      type: "utterance",
      seq: args.nextSeq(),
      day: args.day,
      slot: args.slot,
      sim_hour: args.hour,
      at_wall_clock: args.wallClock(),
      speaker_id: targetId,
      text: args.targetResponse?.utterance
        ? sanitizePublicText(args.targetResponse.utterance, args.actors)
        : fallbackReplyForAction(args.selected, target?.display_name ?? actorDisplayName(targetId, args.actors)),
    });
  } else {
    const text = internalReactionForAction(args.selected, args.response.reasoning, args.actors);
    args.emit({
      type: "internal_reaction",
      seq: args.nextSeq(),
      day: args.day,
      slot: args.slot,
      sim_hour: args.hour,
      at_wall_clock: args.wallClock(),
      subject_id: args.initiatorActor.id,
      text,
    });
  }

  args.emit({
    type: "scene.end",
    seq: args.nextSeq(),
    day: args.day,
    slot: args.slot,
    sim_hour: args.hour,
    at_wall_clock: args.wallClock(),
  });
}

function openingUtteranceForAction(action: SimAction, actors: Actor[]): string {
  if (action.type === "socialize") {
    return `${actorDisplayName(action.actor_id, actors)}, got a minute?`;
  }
  if (action.type === "reach_out") {
    return `${actorDisplayName(action.actor_id, actors)}, can I check in for a minute?`;
  }
  return "Let's talk for a minute.";
}

function fallbackReplyForAction(action: SimAction, targetDisplayName: string): string {
  if (action.type === "reach_out") return "Yeah, I can talk for a minute.";
  if (action.type === "socialize") return "Yeah, I have a minute.";
  return `${targetDisplayName} answers briefly.`;
}

function internalReactionForAction(action: SimAction, reasoning: string, actors: Actor[]): string {
  const sanitized = sanitizePublicText(reasoning, actors).trim();
  if (isUsableInternalReaction(sanitized, action)) return sanitized;
  switch (action.type) {
    case "work":
      return "I focus on the work in front of me.";
    case "study":
      return `I settle into studying ${action.skill}.`;
    case "rest":
      return "I take a quiet moment to recover.";
    case "sleep":
      return "I let the day close and rest.";
    case "cook":
      return "I make something simple and steady myself.";
    case "eat_out":
      return "I step out for a meal and reset my pace.";
    case "exercise":
      return "I move my body and clear my head.";
    case "save_money":
      return "I keep my spending tight for now.";
    case "consider_decision":
      return "I turn the decision over carefully.";
    case "maintenance":
      return "I handle the small tasks that keep life moving.";
    default:
      return `I spend the moment on ${actionLabel(action, actors)}.`;
  }
}

function isUsableInternalReaction(text: string, action: SimAction): boolean {
  if (text.length < 12) return false;
  const normalized = text.toLowerCase().replace(/[.!?。！？]+$/g, "").trim();
  if (normalized === action.type) return false;
  if (normalized === actionLabel(action).toLowerCase()) return false;
  if (!/\s/.test(text)) return false;
  if (/\b(energy is|stress is|mood is|health is|job.?satisfaction)\b/i.test(text)) return false;
  if (/\b(energy|stress|mood|health)\s*[=:<>]\s*\d/i.test(text)) return false;
  if (/\b\d{2,}\s*%/.test(text)) return false;
  return true;
}

function simActionToDecision(action: SimAction, simHour: number, reasoning: string, locationId: string) {
  switch (action.type) {
    case "work":
      return { action: "move" as const, destination_id: locationId, sim_hour: simHour, reasoning };
    case "socialize":
      return { action: "stay" as const, target_actor_id: action.actor_id, sim_hour: simHour, reasoning };
    case "reach_out":
      return { action: "reach_out" as const, target_actor_id: action.actor_id, sim_hour: simHour, reasoning };
    case "study":
      return { action: "activity" as const, activity_label: `study ${action.skill}`, sim_hour: simHour, reasoning };
    case "save_money":
      return { action: "activity" as const, activity_label: "finance maintenance", sim_hour: simHour, reasoning };
    case "consider_decision":
      return { action: "activity" as const, activity_label: "decision review", sim_hour: simHour, reasoning };
    case "maintenance":
      return { action: "activity" as const, activity_label: "life maintenance", sim_hour: simHour, reasoning };
    default:
      return { action: "activity" as const, activity_label: actionLabel(action), sim_hour: simHour, reasoning };
  }
}

function actionLabel(action: SimAction, actors: Actor[] = []): string {
  switch (action.type) {
    case "study":
      return `study ${action.skill}`;
    case "socialize":
      return `spend time with ${actorDisplayName(action.actor_id, actors)}`;
    case "reach_out":
      return `reach out to ${actorDisplayName(action.actor_id, actors)}`;
    case "save_money":
      return "reduce financial pressure";
    case "consider_decision":
      return "review a major decision";
    case "maintenance":
      return "handle life maintenance";
    default:
      return action.type;
  }
}

function actorDisplayName(actorId: string | undefined, actors: Actor[]): string {
  if (!actorId) return "another actor";
  const actor = actors.find((candidate) => candidate.id === actorId);
  return actor?.display_name ?? humanizeInternalId(actorId);
}

function sanitizePublicText(text: string, actors: Actor[]): string {
  let next = text;
  for (const actor of actors) {
    next = next.split(actor.id).join(actor.display_name);
  }
  return next;
}

function humanizeInternalId(value: string): string {
  const cleaned = value
    .replace(/^(actor|location|loc|building)[_-]+/i, "")
    .replace(/[_-]+/g, " ")
    .trim();
  if (!cleaned) return "another actor";
  return cleaned
    .split(/\s+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function summarizeLifeState(state: LifeState) {
  return {
    money: state.money,
    energy: state.energy,
    health: state.health,
    stress: state.stress,
    mood: state.mood,
    job_satisfaction: state.job_satisfaction,
  };
}

function summarizeRun(state: LifeState, events: Event[]): string {
  const simEvents = events.filter((event) => event.type === "sim.event").length;
  return `The run completed with stress ${state.stress}, energy ${state.energy}, money ${state.money}, and ${simEvents} triggered simulation events.`;
}

function summarizePopulationRun(actorStates: Record<string, LifeState>, events: Event[]): string {
  const states = Object.values(actorStates);
  const simEvents = events.filter((event) => event.type === "sim.event").length;
  if (states.length === 0) return `The run completed with ${simEvents} triggered simulation events.`;
  const avg = averageLifeState(states);
  return `The run completed for ${states.length} actors with average stress ${avg.stress}, energy ${avg.energy}, health ${avg.health}, and ${simEvents} triggered simulation events.`;
}

function finalStateLine(state: LifeState): string {
  return `Money ${state.money}, energy ${state.energy}/${SIMULATION_BOUNDS.max_meter}, health ${state.health}/${SIMULATION_BOUNDS.max_meter}, stress ${state.stress}/${SIMULATION_BOUNDS.max_meter}, job satisfaction ${state.job_satisfaction}/${SIMULATION_BOUNDS.max_meter}.`;
}

function finalPopulationStateLine(actorStates: Record<string, LifeState>): string {
  const states = Object.values(actorStates);
  if (states.length === 0) return "No actor state was available.";
  const avg = averageLifeState(states);
  return `${states.length} actors, avg energy ${avg.energy}/${SIMULATION_BOUNDS.max_meter}, avg health ${avg.health}/${SIMULATION_BOUNDS.max_meter}, avg stress ${avg.stress}/${SIMULATION_BOUNDS.max_meter}, avg mood ${avg.mood}/${SIMULATION_BOUNDS.max_meter}.`;
}

function averageLifeState(states: LifeState[]): Pick<LifeState, "energy" | "health" | "stress" | "mood" | "job_satisfaction"> {
  const sum = states.reduce((acc, state) => ({
    energy: acc.energy + state.energy,
    health: acc.health + state.health,
    stress: acc.stress + state.stress,
    mood: acc.mood + state.mood,
    job_satisfaction: acc.job_satisfaction + state.job_satisfaction,
  }), {
    energy: 0,
    health: 0,
    stress: 0,
    mood: 0,
    job_satisfaction: 0,
  });
  return {
    energy: Math.round(sum.energy / states.length),
    health: Math.round(sum.health / states.length),
    stress: Math.round(sum.stress / states.length),
    mood: Math.round(sum.mood / states.length),
    job_satisfaction: Math.round(sum.job_satisfaction / states.length),
  };
}

function decisionReadout(question: string, state: LifeState, events: Event[]): string {
  const pressureEvents = events
    .filter((event) => event.type === "sim.event")
    .map((event) => event.description);
  return `For "${question}", the simulation ends with stress ${state.stress} and job satisfaction ${state.job_satisfaction}. Relevant pressure signals: ${pressureEvents.slice(0, ORCHESTRATOR_LIMITS.decision_readout_event_limit).join(" / ") || "none"}.`;
}

function formatHour(hour: number): string {
  return `${Math.floor(hour).toString().padStart(ORCHESTRATOR_LIMITS.hour_pad_width, "0")}:00`;
}

function deterministicVersionId(runId: string, turnId: string, agentId: string, content: string): string {
  return `${ORCHESTRATOR_PROTOCOL.memory_version_prefix}_${Math.abs(hash(`${runId}:${turnId}:${agentId}:${content}`)).toString(36)}`;
}

function pad(value: number): string {
  return value.toString().padStart(ORCHESTRATOR_LIMITS.id_pad_width, "0");
}

function hash(value: string): number {
  let result: number = ORCHESTRATOR_LIMITS.fnv_offset_basis;
  for (let index = 0; index < value.length; index++) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, ORCHESTRATOR_LIMITS.fnv_prime);
  }
  return result | 0;
}

export function createTestStorePath(name: string): string {
  const dir = join(import.meta.dirname, "..", "tmp");
  mkdirSync(dir, { recursive: true });
  return join(dir, `${name}-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
}
