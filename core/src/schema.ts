import { z } from "zod";
import { PERSONALITY_TYPES } from "./config/personality-types";
import { SUPPORTED_MODEL_IDS, SUPPORTED_MODEL_SPEEDS } from "./simulator-config";
import { LifeState } from "./simulation-engine";

const INPUT_LIMITS = {
  id: 128,
  label: 256,
  text: 8_000,
  listItems: 50,
  actors: 100,
  supportingActors: 20,
  locations: 200,
  buildings: 200,
  paths: 1_000,
  periodDays: 30,
  periodMonths: 3,
  scenesPerDay: 8,
} as const;

const IdText = z.string().min(1).max(INPUT_LIMITS.id);
const LabelText = z.string().min(1).max(INPUT_LIMITS.label);
const OptionalLabelText = z.string().max(INPUT_LIMITS.label).optional();
const LongText = z.string().max(INPUT_LIMITS.text);
const OptionalLongText = LongText.optional();
const TextList = z.array(LongText).max(INPUT_LIMITS.listItems).default([]);
const LabelList = z.array(LabelText).max(INPUT_LIMITS.listItems).default([]);

// ============================================================================
// MBTI
// ============================================================================

export const MBTI_TYPES = PERSONALITY_TYPES;
export const MBTIType = z.enum(MBTI_TYPES);
export type MBTIType = z.infer<typeof MBTIType>;

// ============================================================================
// Location
// ============================================================================

export const LocationId = IdText; // e.g. "home", "school", "workplace"
export type LocationId = z.infer<typeof LocationId>;

export const WorldCoordinate = z.object({
  x: z.number(),
  y: z.number().optional(),
  z: z.number().optional(),
});
export type WorldCoordinate = z.infer<typeof WorldCoordinate>;

export const WorldSize = z.object({
  width: z.number().positive().optional(),
  depth: z.number().positive().optional(),
  height: z.number().positive().optional(),
});
export type WorldSize = z.infer<typeof WorldSize>;

export const Location = z.object({
  id: LocationId,
  display_name: LabelText,
  description: LongText,
  // Actor IDs that are usually present at this location.
  resident_actor_ids: z.array(IdText).max(INPUT_LIMITS.actors),
  // Stable location archetype used by the frontend map layer.
  kind: OptionalLabelText,
  building_id: LocationId.optional(),
  position: WorldCoordinate.optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type Location = z.infer<typeof Location>;

export const WorldBuilding = z.object({
  id: LocationId,
  display_name: LabelText,
  kind: LabelText,
  description: OptionalLongText,
  position: WorldCoordinate,
  size: WorldSize.optional(),
  floors: z.number().int().min(0).max(200).optional(),
  capacity: z.number().int().min(0).max(1_000_000).optional(),
  resident_actor_ids: z.array(IdText).max(INPUT_LIMITS.actors).default([]),
  tags: LabelList,
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type WorldBuilding = z.infer<typeof WorldBuilding>;

export const WorldPath = z.object({
  id: IdText.optional(),
  from_id: LocationId,
  to_id: LocationId,
  distance_meters: z.number().nonnegative().max(1_000_000).optional(),
  travel_minutes: z.number().nonnegative().max(1_000_000).optional(),
  mode: LabelText.default("walk"),
  bidirectional: z.boolean().default(true),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type WorldPath = z.infer<typeof WorldPath>;

export const WorldLayout = z.object({
  mode: z.enum(["free", "grid"]).default("free"),
  snap_to_grid: z.boolean().default(false),
  grid_size: z.number().positive().optional(),
}).default({ mode: "free", snap_to_grid: false });
export type WorldLayout = z.infer<typeof WorldLayout>;

// ============================================================================
// Weekday & Weekly schedule
// ============================================================================

export const Weekday = z.enum(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
export type Weekday = z.infer<typeof Weekday>;
export const WEEKDAYS: readonly Weekday[] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

// slot -> location id. Missing slots have no default.
export const DaySchedule = z.object({
  morning: LocationId.optional(),
  noon: LocationId.optional(),
  evening: LocationId.optional(),
  night: LocationId.optional(),
});
export type DaySchedule = z.infer<typeof DaySchedule>;

// Weekday -> DaySchedule. Each weekday and slot is optional.
export const WeeklySchedule = z
  .object({
    Mon: DaySchedule,
    Tue: DaySchedule,
    Wed: DaySchedule,
    Thu: DaySchedule,
    Fri: DaySchedule,
    Sat: DaySchedule,
    Sun: DaySchedule,
  })
  .partial();
export type WeeklySchedule = z.infer<typeof WeeklySchedule>;

// ============================================================================
// Actor
// ============================================================================

export const ActorId = IdText; // e.g. "ayaka", "mother", "mei"
export type ActorId = z.infer<typeof ActorId>;

export const ActorRole = LabelText;
export type ActorRole = z.infer<typeof ActorRole>;

export const ModelId = z.enum(SUPPORTED_MODEL_IDS);
export type ModelId = z.infer<typeof ModelId>;
export const ModelSpeed = z.enum(SUPPORTED_MODEL_SPEEDS);
export type ModelSpeed = z.infer<typeof ModelSpeed>;

export const Actor = z.object({
  id: ActorId,
  display_name: LabelText,
  role: ActorRole,
  is_focus: z.boolean().default(false),
  age: z.number().int().min(0).max(120),
  gender: LabelText,                // Free-form gender text
  mbti: MBTIType,
  // Free-form character details.
  profile: LongText,                // Background, habits, and current life pattern
  values: OptionalLongText,         // Values
  interests: OptionalLongText,      // Interests
  fears: OptionalLongText,          // Fears
  goals: TextList,
  constraints: TextList,
  // Relationship note from this run's focus actor point of view.
  relation_to_focus: OptionalLongText,
  // Alternative field name for relation_to_focus.
  relation_to_protagonist: OptionalLongText,
  // Default location by weekday and time slot.
  schedule: WeeklySchedule.optional(),
  // Optional initial objective state supplied by the caller.
  initial_state: LifeState.partial().optional(),
  initial_location_id: IdText.optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  // Model assigned to this actor session.
  model: ModelId,
});
export type Actor = z.infer<typeof Actor>;

// ============================================================================
// Input
// ============================================================================

export const ProtagonistInput = z.object({
  name: LabelText,
  age: z.number().int().min(0).max(120),
  gender: LabelText,
  mbti: MBTIType,
  profile: LongText,                // Free-form background and current context
  values: OptionalLongText,
  interests: OptionalLongText,
  fears: OptionalLongText,
  // Explicit output language, e.g. "English", "Japanese", "Spanish".
  language: OptionalLabelText,
  schedule: WeeklySchedule.optional(),
});
export type ProtagonistInput = z.infer<typeof ProtagonistInput>;

export const SupportingActorInput = z.object({
  role: ActorRole,
  display_name: OptionalLabelText,
  age: z.number().int().min(0).max(120).optional(),
  gender: OptionalLabelText,
  mbti: MBTIType.optional(),
  memo: OptionalLongText,           // Free-form character note
  schedule: WeeklySchedule.optional(), // Expected location by weekday and slot
});
export type SupportingActorInput = z.infer<typeof SupportingActorInput>;

export const ActorInput = z.object({
  id: ActorId.optional(),
  display_name: OptionalLabelText,
  name: OptionalLabelText,
  role: ActorRole.default("participant"),
  is_focus: z.boolean().optional(),
  age: z.number().int().min(0).max(120).optional(),
  gender: OptionalLabelText,
  mbti: MBTIType.optional(),
  profile: OptionalLongText,
  values: OptionalLongText,
  interests: OptionalLongText,
  fears: OptionalLongText,
  goals: TextList,
  constraints: TextList,
  relation_to_focus: OptionalLongText,
  relation_to_protagonist: OptionalLongText,
  memo: OptionalLongText,
  schedule: WeeklySchedule.optional(),
  initial_state: LifeState.partial().optional(),
  initial_location_id: IdText.optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type ActorInput = z.input<typeof ActorInput>;

export const ScenarioInput = z.object({
  id: IdText.optional(),
  domain: LabelText.default("life"),
  title: OptionalLabelText,
  description: OptionalLongText,
  goals: TextList,
  constraints: TextList,
  tags: LabelList,
  metadata: z.record(z.string(), z.unknown()).optional(),
}).default({ domain: "life", goals: [], constraints: [], tags: [] });
export type ScenarioInput = z.input<typeof ScenarioInput>;

export const WorldInput = z.object({
  layout: WorldLayout.optional(),
  locations: z.array(Location).max(INPUT_LIMITS.locations).default([]),
  buildings: z.array(WorldBuilding).max(INPUT_LIMITS.buildings).default([]),
  paths: z.array(WorldPath).max(INPUT_LIMITS.paths).default([]),
  distance_matrix: z.record(z.string(), z.record(z.string(), z.number().nonnegative())).optional(),
  default_location_id: LocationId.optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).optional();
export type WorldInput = z.input<typeof WorldInput>;

export const SchedulerInput = z.object({
  max_active_actors_per_turn: z.number().int().min(1).max(100).optional(),
  background_update_interval_turns: z.number().int().min(1).max(1_000).optional(),
}).optional();
export type SchedulerInput = z.input<typeof SchedulerInput>;

export const DecisionContext = z.object({
  question: OptionalLongText,
  options: z.array(LongText).max(20).default([]),
  horizon: OptionalLongText,
  success_criteria: OptionalLongText,
});
export type DecisionContext = z.infer<typeof DecisionContext>;

export const RunConfig = z.object({
  debug_logs: z.boolean().optional(),
  debug_log_agent_payloads: z.boolean().optional(),
  cost_risk_acknowledged: z.boolean().optional(),
  label: OptionalLabelText,
});
export type RunConfig = z.infer<typeof RunConfig>;

export const RunInput = z.object({
  model_id: ModelId.optional(),
  model_speed: ModelSpeed.optional(),
  actors: z.array(ActorInput).max(INPUT_LIMITS.actors).optional(),
  focus_actor_id: ActorId.optional(),
  scenario: ScenarioInput.optional(),
  world: WorldInput,
  scheduler: SchedulerInput,
  protagonist: ProtagonistInput.optional(),
  supporting: z.array(SupportingActorInput).max(INPUT_LIMITS.supportingActors).default([]),
  decision_context: DecisionContext.optional(),
  mode: z.enum(["day", "life"]).default("day"),
  period_days: z.number().int().min(1).max(INPUT_LIMITS.periodDays).default(3),
  period_months: z.number().int().min(1).max(INPUT_LIMITS.periodMonths).optional(),
  scenes_per_day: z.number().int().min(1).max(INPUT_LIMITS.scenesPerDay).default(4),
  seed: z.number().optional(),
  config: RunConfig.optional(),
}).superRefine((value, ctx) => {
  const genericActors = value.actors ?? [];
  if (genericActors.length === 0 && !value.protagonist) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "RunInput requires either actors[] or protagonist.",
      path: ["actors"],
    });
  }
  if (genericActors.length > 0) {
    const ids = genericActors
      .map((actor, index) => actor.id ?? actor.name ?? actor.display_name ?? `${actor.role}_${index + 1}`);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "actors[] must resolve to unique ids.",
        path: ["actors"],
      });
    }
    const focusFlags = genericActors.filter((actor) => actor.is_focus).length;
    if (focusFlags > 1 && !value.focus_actor_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "At most one actor may set is_focus unless focus_actor_id is explicit.",
        path: ["actors"],
      });
    }
  }
});
export type RunInput = z.input<typeof RunInput>;

// ============================================================================
// Decision
// ============================================================================

export const TimeSlot = z.enum(["morning", "noon", "evening", "night"]);
export type TimeSlot = z.infer<typeof TimeSlot>;

export const Episode = z.object({
  month: z.number().int().min(1),
  week: z.number().int().min(1).optional(),
  title: z.string(),
  time_of_day: TimeSlot,
  location_hint: z.string(),
  actors: z.array(z.string()),
  summary: z.string(),
  tone: z.string(),
});
export type Episode = z.infer<typeof Episode>;

export const DecisionAction = z.enum([
  "stay",        // Stay at the current location
  "move",        // Move to another location
  "alone",       // Spend time alone
  "reach_out",   // Contact someone remotely
  "activity",    // Concrete activity such as work, study, cooking, or exercise
]);
export type DecisionAction = z.infer<typeof DecisionAction>;

export const Decision = z.object({
  action: DecisionAction,
  destination_id: LocationId.optional(), // For action=move
  target_actor_id: ActorId.optional(),   // For stay/reach_out with another actor
  activity_label: z.string().optional(), // For action=activity
  sim_hour: z.number().min(0).max(24),   // Simulated hour
  reasoning: z.string(),                 // One-sentence reason
});
export type Decision = z.infer<typeof Decision>;

export function hourToSlot(h: number): TimeSlot {
  if (h < 11) return "morning";
  if (h < 15) return "noon";
  if (h < 20) return "evening";
  return "night";
}

// ============================================================================
// Event stream for the frontend.
// ============================================================================

const EventBase = z.object({
  seq: z.number(),                        // Global event sequence number
  day: z.number().int().min(1),
  slot: TimeSlot,                         // Derived from simulated time
  sim_hour: z.number().min(0).max(24),    // Simulated hour
  at_wall_clock: z.string(),              // ISO timestamp
});

export const DayStartEvent = EventBase.extend({
  type: z.literal("day.start"),
  weekday: z.string(),                    // e.g. "Tue"
});

export const SlotStartEvent = EventBase.extend({
  type: z.literal("slot.start"),
  time_of_day_label: z.string(),          // e.g. "07:00 at home"
});

export const DecisionEvent = EventBase.extend({
  type: z.literal("decision"),
  actor_id: ActorId.optional(),
  decision: Decision,
  from_location_id: LocationId,
});

export const SceneStartEvent = EventBase.extend({
  type: z.literal("scene.start"),
  location_id: LocationId,
  actor_ids: z.array(ActorId),
  scene_kind: z.enum(["dialogue", "alone", "activity"]),
  activity_label: z.string().optional(),
});

export const UtteranceEvent = EventBase.extend({
  type: z.literal("utterance"),
  speaker_id: ActorId,
  text: z.string(),
});

export const InternalReactionEvent = EventBase.extend({
  type: z.literal("internal_reaction"),
  subject_id: ActorId,
  text: z.string(),
});

export const SceneEndEvent = EventBase.extend({
  type: z.literal("scene.end"),
});

export const MoveEvent = EventBase.extend({
  type: z.literal("move"),
  actor_id: ActorId.optional(),
  from_location_id: LocationId,
  to_location_id: LocationId,
  note: z.string().optional(),            // Caption text
});

export const TransitionEvent = EventBase.extend({
  type: z.literal("transition"),
  kind: z.enum(["sleep", "pass_of_time"]),
  note: z.string().optional(),
});

export const ReachOutEvent = EventBase.extend({
  type: z.literal("reach_out"),
  from_actor_id: ActorId,
  to_actor_id: ActorId,
  medium: z.enum(["line", "phone"]),
  summary: z.string(),
});

export const StateUpdateEvent = EventBase.extend({
  type: z.literal("state.update"),
  turn_id: z.string(),
  actor_id: ActorId.optional(),
  action_type: z.string(),
  effect: z.record(z.string(), z.unknown()),
  state_summary: z.object({
    money: z.number(),
    energy: z.number(),
    health: z.number(),
    stress: z.number(),
    mood: z.number(),
    job_satisfaction: z.number(),
  }),
});

export const SimTriggerEvent = EventBase.extend({
  type: z.literal("sim.event"),
  turn_id: z.string(),
  actor_id: ActorId.optional(),
  sim_event_type: z.string(),
  severity: z.enum(["low", "medium", "high"]),
  description: z.string(),
});

export const AgentUnavailableEvent = EventBase.extend({
  type: z.literal("agent.unavailable"),
  turn_id: z.string(),
  agent_id: ActorId,
  task: z.enum(["choose_action", "respond_to_scene", "background_update"]),
  retry_count: z.number().int().min(0),
  reason: z.string(),
});

export const RunCompleteEvent = EventBase.extend({
  type: z.literal("run.complete"),
  summary: z.string(),
  turning_points: z.array(
    z.object({
      day: z.number(),
      slot: TimeSlot,
      description: z.string(),
    }),
  ),
  final_state: z.string(),
  decision_readout: z.string().optional(),
});

export const RunFailedEvent = EventBase.extend({
  type: z.literal("run.failed"),
  message: z.string(),
});

export const RunCancelledEvent = EventBase.extend({
  type: z.literal("run.cancelled"),
  message: z.string(),
});

export const TimeskipEvent = EventBase.extend({
  type: z.literal("timeskip"),
  from_week: z.number().int(),
  to_week: z.number().int(),
  summary: z.string(),
});

export const EpisodeStartEvent = EventBase.extend({
  type: z.literal("episode.start"),
  episode_number: z.number().int(),
  title: z.string(),
  time_label: z.string(),
});

export const Event = z.discriminatedUnion("type", [
  DayStartEvent,
  SlotStartEvent,
  DecisionEvent,
  SceneStartEvent,
  UtteranceEvent,
  InternalReactionEvent,
  SceneEndEvent,
  MoveEvent,
  TransitionEvent,
  ReachOutEvent,
  StateUpdateEvent,
  SimTriggerEvent,
  AgentUnavailableEvent,
  RunCompleteEvent,
  RunFailedEvent,
  RunCancelledEvent,
  TimeskipEvent,
  EpisodeStartEvent,
]);
export type Event = z.infer<typeof Event>;

// ============================================================================
// Sim state
// ============================================================================

// Agent/session IDs are part of state so a run can be resumed against the
// same Managed Agents session and memory stores.
export const ActorSession = z.object({
  actor_id: ActorId,
  agent_id: z.string(),
  session_id: z.string(),
  memory_store_id: z.string().optional(),
  world_memory_store_id: z.string().optional(),
  run_context_memory_store_id: z.string().optional(),
  relationship_memory_store_id: z.string().optional(),
});
export type ActorSession = z.infer<typeof ActorSession>;

export const ManagedAgentsHandle = z.object({
  environment_id: z.string(),
  actor_sessions: z.array(ActorSession),
});
export type ManagedAgentsHandle = z.infer<typeof ManagedAgentsHandle>;

export const SimState = z.object({
  run_id: z.string().optional(),
  input: RunInput,
  actors: z.array(Actor),
  locations: z.array(Location),
  focus_actor_id: ActorId.optional(),
  protagonist_id: ActorId,
  current_day: z.number().int(),
  current_slot: TimeSlot,
  current_sim_hour: z.number().min(0).max(24),
  current_location_id: LocationId,
  life_state: LifeState.optional(),
  actor_states: z.record(z.string(), LifeState).optional(),
  actor_locations: z.record(z.string(), LocationId).optional(),
  events: z.array(Event),
  cost_usd: z.number(),
  managed_agents: ManagedAgentsHandle.optional(),
  memory_store_id: z.string().optional(),
});
export type SimState = z.infer<typeof SimState>;
