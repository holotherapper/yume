import type {
  Actor,
  ActorSession,
  Event,
  Location,
  RunInput,
  TimeSlot,
  Weekday,
  WorldBuilding,
  WorldPath,
} from "../schema";
import type { AvailableAction, LifeState, SimAction } from "../simulation-engine";
import type { MbtiBehaviorGuide } from "../config/personality";

export type ActorLocationMap = Record<string, string>;

export type AgentWorldContext = {
  current_location?: Location;
  current_building?: WorldBuilding;
  locations: Location[];
  buildings: WorldBuilding[];
  nearby_buildings: Array<{
    building_id: string;
    display_name: string;
    kind: string;
    distance_meters: number;
  }>;
  paths: WorldPath[];
  distance_matrix?: Record<string, Record<string, number>>;
};

export type AgentTurnRequest = {
  type: "yume.turn_request";
  run_id: string;
  turn_id: string;
  clock: {
    turn_index: number;
    day: number;
    time_slot: TimeSlot;
    sim_hour: number;
  };
  agent_id: string;
  task: "choose_action" | "respond_to_scene" | "background_update";
  world_snapshot: {
    actor_profile: AgentActorProfile;
    location_id: string;
    focus_actor_id: string;
    actor_locations?: ActorLocationMap;
    world_context?: AgentWorldContext;
    scenario_context?: string;
    life_state?: LifeState;
    observed_actors: AgentObservedState[];
    known_actors: AgentKnownActor[];
    recent_events: Event[];
  };
  available_actions: AgentAvailableAction[];
  scene_context?: {
    initiator_actor_id: string;
    selected_action: SimAction;
    location_id: string;
    initiator_reasoning: string;
  };
};

export type AgentAvailableAction = Pick<AvailableAction, "action">;

export type AgentScheduleUpdate = {
  weekday: Weekday;
  time_slot: TimeSlot;
  location_id: string;
  reason?: string;
};

export type AgentActorProfile = {
  actor_id: string;
  display_name: string;
  role: string;
  age: number;
  gender: string;
  profile: string;
  values?: string;
  interests?: string;
  fears?: string;
  goals: string[];
  constraints: string[];
  relation_to_focus?: string;
  behavior_traits: MbtiBehaviorGuide;
};

export type AgentObservedState = {
  actor_id: string;
  display_name: string;
  role: string;
  energy_hint: "low" | "moderate" | "high";
  stress_hint: "low" | "moderate" | "high";
  mood_hint: "low" | "moderate" | "high";
  health_hint: "fragile" | "stable";
  financial_hint: "strained" | "stable" | "secure";
  work_satisfaction_hint: "low" | "mixed" | "high";
  relationship_to_self?: {
    closeness_hint: "distant" | "familiar" | "close";
    trust_hint: "low" | "moderate" | "high";
    tension_hint: "low" | "moderate" | "high";
  };
};

export type AgentKnownActor = {
  actor_id: string;
  display_name: string;
  role: string;
  relationship_to_self: NonNullable<AgentObservedState["relationship_to_self"]>;
};

export type AgentTurnResponse = {
  type: "yume.agent_response";
  run_id: string;
  turn_id: string;
  agent_id: string;
  selected_action?: SimAction;
  utterance?: string;
  proposed_memory_updates: string[];
  proposed_schedule_updates?: AgentScheduleUpdate[];
  observed_memory_writes?: Array<{
    memory_store_id?: string;
    path?: string;
    tool_name?: string;
  }>;
  reasoning: string;
};

export type InteractionOutcome = "repair" | "support" | "neutral" | "avoidance" | "conflict" | "escalation";

export type InteractionEvaluationRequest = {
  type: "yume.interaction_evaluation_request";
  run_id: string;
  turn_id: string;
  clock: AgentTurnRequest["clock"];
  evaluator_id: string;
  location_id: string;
  world_context?: AgentWorldContext;
  initiator_actor_id: string;
  target_actor_id: string;
  selected_action: SimAction;
  initiator_response: Pick<AgentTurnResponse, "reasoning" | "utterance" | "proposed_memory_updates">;
  target_response?: Pick<AgentTurnResponse, "reasoning" | "utterance" | "proposed_memory_updates">;
  initiator_state: LifeState;
  target_state: LifeState;
  recent_events: Event[];
};

export type InteractionEvaluationResponse = {
  type: "yume.interaction_evaluation";
  run_id: string;
  turn_id: string;
  evaluator_id: string;
  outcome: InteractionOutcome;
  confidence: number;
  relationship_deltas: Array<{
    from_actor_id: string;
    to_actor_id: string;
    closeness?: number;
    trust?: number;
    tension?: number;
    reset_last_interaction?: boolean;
  }>;
  actor_state_deltas: Array<{
    actor_id: string;
    energy?: number;
    health?: number;
    stress?: number;
    mood?: number;
    job_satisfaction?: number;
  }>;
  event_suggestions: Array<{
    type: string;
    severity: "low" | "medium" | "high";
    description: string;
  }>;
  memory_notes: Array<{
    actor_id: string;
    target_actor_id?: string;
    content: string;
  }>;
  evidence: string[];
  reasoning: string;
};

export type AgentDriverSetup = {
  environmentId: string;
  actorSessions: ActorSession[];
};

export type AgentDriver = {
  setup(args: {
    runId: string;
    input: RunInput;
    actors: Actor[];
  }): Promise<AgentDriverSetup>;
  requestTurn(request: AgentTurnRequest): Promise<AgentTurnResponse>;
  evaluateInteraction?(request: InteractionEvaluationRequest): Promise<InteractionEvaluationResponse>;
  recordMemoryUpdate?(args: {
    runId: string;
    turnId: string;
    agentId: string;
    memoryStoreId: string;
    memoryPath: string;
    content: string;
  }): Promise<{ memoryVersionId: string }>;
};
