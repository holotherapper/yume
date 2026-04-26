import type { ActorRole, MBTIType, TimeSlot, Weekday } from "./schema";
import type { ActionEffect, LifeState } from "./simulation-engine";
import { PERSONALITY_TYPES } from "./config/personality-types";
export {
  MODEL_IDS,
  MODEL_SPEEDS,
  resolveRunModelId,
  resolveRunModelSpeed,
  SUPPORTED_MODEL_IDS,
  SUPPORTED_MODEL_SPEEDS,
  type SupportedModelId,
  type SupportedModelSpeed,
} from "./config/model";
export {
  MBTI_BEHAVIOR_GUIDE,
  MBTI_BEHAVIOR_SOURCE_URLS,
  type MbtiBehaviorGuide,
} from "./config/personality";

export const TIME_SLOTS: Array<{ slot: TimeSlot; hour: number }> = [
  { slot: "morning", hour: 7 },
  { slot: "noon", hour: 12 },
  { slot: "evening", hour: 18 },
  { slot: "night", hour: 22 },
];

export const WEEKDAYS: readonly Weekday[] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export const DEFAULT_SUPPORTING_ACTORS: Array<{
  role: ActorRole;
  display_name: string;
  memo: string;
}> = [
  {
    role: "family",
    display_name: "Mother",
    memo: "Notices small changes and worries about the focus actor.",
  },
  {
    role: "close_friend",
    display_name: "Close friend",
    memo: "Listens carefully and pushes back when the focus actor avoids reality.",
  },
  {
    role: "teacher",
    display_name: "Mentor",
    memo: "Sees the focus actor through work or study.",
  },
];

export const DEFAULT_ROLE_PROFILE = {
  ageOffset: 0,
  gender: "unspecified",
  label: "Participant",
  relation: "participant",
} as const;

export const ROLE_DEFAULTS: Record<
  string,
  { ageOffset: number; gender: string; label: string; relation: string }
> = {
  focus_actor: { ageOffset: 0, gender: "unspecified", label: "Focus actor", relation: "self" },
  protagonist: { ageOffset: 0, gender: "unspecified", label: "Focus actor", relation: "self" },
  family: { ageOffset: 0, gender: "unspecified", label: "Family member", relation: "family member" },
  close_friend: { ageOffset: 0, gender: "unspecified", label: "Close friend", relation: "close friend" },
  romantic: { ageOffset: 1, gender: "unspecified", label: "Partner", relation: "romantic partner or interest" },
  classmate: { ageOffset: 0, gender: "unspecified", label: "Classmate", relation: "classmate" },
  part_time_peer: { ageOffset: 4, gender: "unspecified", label: "Coworker", relation: "work peer" },
  teacher: { ageOffset: 20, gender: "unspecified", label: "Mentor", relation: "teacher, mentor, or advisor" },
  acquaintance: { ageOffset: 0, gender: "unspecified", label: "Acquaintance", relation: "acquaintance" },
};

export const SUPPORTING_ACTOR_INFERENCE = [
  {
    pattern: /\b(mother|mom|father|dad|parent|aunt|uncle)\b/i,
    ageOffset: 28,
    genderByPattern: [
      { pattern: /\b(mother|mom|aunt)\b/i, gender: "female" },
      { pattern: /\b(father|dad|uncle)\b/i, gender: "male" },
    ],
  },
  {
    pattern: /\b(brother|sister|sibling)\b/i,
    ageOffset: 2,
    genderByPattern: [
      { pattern: /\b(brother)\b/i, gender: "male" },
      { pattern: /\b(sister)\b/i, gender: "female" },
    ],
  },
] as const;

export const MBTI_TYPES: readonly MBTIType[] = PERSONALITY_TYPES;

export const LOCATION_TEMPLATES: Record<
  "home" | "workplace" | "school" | "cafe" | "park",
  {
    id: string;
    display_name: string;
    description: string;
    resident_actor_ids: string[];
    kind: string;
  }
> = {
  home: {
    id: "home",
    display_name: "Home",
    description: "The focus actor's base of daily life.",
    resident_actor_ids: [],
    kind: "home",
  },
  workplace: {
    id: "workplace",
    display_name: "Workplace",
    description: "The focus actor's regular work environment.",
    resident_actor_ids: [],
    kind: "workplace",
  },
  school: {
    id: "school",
    display_name: "School",
    description: "The focus actor's regular study environment.",
    resident_actor_ids: [],
    kind: "school",
  },
  cafe: {
    id: "cafe",
    display_name: "Cafe",
    description: "A neutral place for quiet time or conversation.",
    resident_actor_ids: [],
    kind: "cafe",
  },
  park: {
    id: "park",
    display_name: "Park",
    description: "An outdoor place for rest, exercise, or reflection.",
    resident_actor_ids: [],
    kind: "park",
  },
};

export const LOCATION_PROFILE_PATTERNS = {
  school: /\b(student|university|college|school)\b/i,
} as const;

export const SIMULATION_BOUNDS = {
  min_age: 0,
  max_age: 120,
  min_meter: 0,
  max_meter: 100,
  zero: 0,
} as const;

export const INITIAL_STATE_DEFAULTS = {
  money: 500000,
  monthly_income: 250000,
  monthly_expenses: 180000,
  energy: 80,
  health: 75,
  stress: 30,
  mood: 60,
  job_satisfaction: 50,
  relationship: {
    closeness: 50,
    trust: 50,
    tension: 0,
    last_interaction_day: 0,
  },
  new_relationship: {
    closeness: 12,
    trust: 30,
    tension: 0,
    last_interaction_day: 0,
  },
};

export const PROFILE_PRESETS = [
  {
    pattern: /\b(student|university|college|school)\b/i,
    state: { money: 200000, monthly_income: 80000, monthly_expenses: 100000, job_satisfaction: 60 },
  },
  {
    pattern: /\b(freelance|self-employed|independent)\b/i,
    state: { money: 800000, monthly_income: 400000, monthly_expenses: 250000, job_satisfaction: 65 },
  },
  {
    pattern: /\b(nurse|medical|healthcare)\b/i,
    state: { money: 600000, monthly_income: 300000, monthly_expenses: 200000, job_satisfaction: 45 },
  },
  {
    pattern: /\b(engineer|developer|software)\b/i,
    state: { money: 700000, monthly_income: 350000, monthly_expenses: 200000, job_satisfaction: 55 },
  },
] as const;

export const DISTRESS_PROFILE_PATTERN = /\b(unstable|anxiety|anxious|burnout|tired|exhausted|overtime|debt|pressure)\b/i;

export const DISTRESS_STATE_PATCH = {
  max_money: 140000,
  max_income: 180000,
  min_expenses: 180000,
  max_job_satisfaction: 35,
  stress: 78,
  energy: 42,
};

export const ACTION_EFFECTS: Record<string, (state: LifeState) => ActionEffect> = {
  work: (state) => ({
    money: Math.round(state.monthly_income / 20),
    energy: -20,
    stress: state.job_satisfaction < 30 ? 15 : 8,
    job_satisfaction: state.stress > 70 ? -3 : 1,
  }),
  rest: () => ({ energy: 30, stress: -10, mood: 5 }),
  exercise: () => ({ energy: -25, health: 3, stress: -15, mood: 10 }),
  eat_out: (state) => ({ money: -1500, energy: 15, mood: state.stress > 50 ? 10 : 5 }),
  cook: () => ({ energy: 15, mood: 8 }),
  study: () => ({ energy: -15, stress: 5, mood: -3 }),
  socialize: () => ({ energy: -10, stress: -12, mood: 15 }),
  commute: () => ({ energy: -10, stress: 3 }),
  reach_out: () => ({ energy: -3, stress: -5, mood: 5 }),
  save_money: () => ({ money: 2500, energy: -5, stress: -3, mood: -2 }),
  consider_decision: () => ({ energy: -8, stress: -4, mood: 2, job_satisfaction: -1 }),
  maintenance: () => ({ money: -1000, energy: -8, health: 2, stress: -4 }),
  sleep: (state) => ({
    energy: Math.min(50, 100 - state.energy),
    stress: -5,
    health: state.energy < 20 ? -2 : 1,
  }),
};


export const ENGINE_DELTAS = {
  skill_growth: 3,
} as const;

export const INTERACTION_EVALUATION_RULES = {
  min_confidence_for_commit: 0.45,
  max_relationship_delta: 15,
  max_actor_state_delta: 12,
  fallback_confidence: 0.5,
  repair: {
    initiator: { closeness: 5, trust: 1, tension: -3 },
    target: { closeness: 3, trust: 1, tension: -2 },
  },
  support: {
    initiator: { closeness: 4, trust: 3, tension: -3, stress: -6, mood: 6 },
    target: { closeness: 4, trust: 3, tension: -3, stress: -4, mood: 5 },
  },
  conflict: {
    initiator: { closeness: -4, trust: -5, tension: 12, stress: 8, mood: -6 },
    target: { closeness: -3, trust: -4, tension: 10, stress: 5, mood: -4 },
  },
  escalation: {
    initiator: { closeness: -8, trust: -8, tension: 15, stress: 12, mood: -10 },
    target: { closeness: -8, trust: -8, tension: 15, stress: 10, mood: -8 },
  },
  avoidance: {
    initiator: { closeness: -1, trust: -2, tension: 3, stress: 2, mood: -2 },
    target: { closeness: -2, trust: -2, tension: 4, stress: 3, mood: -3 },
  },
  neutral: {
    initiator: { closeness: 0, trust: 0, tension: 0 },
    target: { closeness: 0, trust: 0, tension: 0 },
  },
} as const;

export const ACTION_RULES = {
  work_energy_min: 15,
  exercise_energy_min: 25,
  eat_out_min_money: 2000,
  study_energy_min: 20,
  social_energy_min: 10,
};

export const EVENT_THRESHOLDS = {
  burnout_stress: 85,
  health_crisis: 30,
  decision_pressure_stress: 70,
  decision_pressure_job_satisfaction: 40,
  low_mood: 20,
  conflict_tension: 80,
  drift_closeness: 15,
  drift_days: 30,
  financial_security_months: 12,
  probabilistic_event_percent: 25,
};

export const EVENT_COPY = {
  financial_pressure: "Available money is below one month of expenses.",
  burnout_warning: "Stress has entered a dangerous range.",
  health_crisis: "Health has deteriorated into a serious range.",
  decision_pressure: "Stress and dissatisfaction are pushing the focus actor toward a decision.",
  low_mood: "Mood is very low.",
  conflict_risk: "Relationship tension is high.",
  relationship_drift: "The relationship is drifting from lack of contact.",
  financial_security: "The focus actor has more than a year of expenses saved.",
  career_crisis: "Job dissatisfaction has reached a critical range.",
  agent_unavailable: "A Managed Agent did not produce a usable response for this turn.",
  stress_slip: "Stress and mood made a small mistake or setback more likely.",
  social_invitation: "A close relationship created an incoming social opportunity.",
} as const;

export const MONTHLY_RULES = {
  relationship_closeness_decay: 2,
  relationship_days_increment: 30,
  financial_pressure_stress_delta: 20,
  burnout_health_delta: -5,
  burnout_monthly_stress: 80,
  career_crisis_job_satisfaction: 20,
  relationship_drift_closeness: 20,
  relationship_drift_days: 60,
  relationship_conflict_tension: 70,
};

export const ORCHESTRATOR_LIMITS = {
  min_life_days: 30,
  days_per_month: 30,
  max_actors: 100,
  default_max_active_actors_per_turn: 100,
  max_concurrent_agent_requests: 10,
  max_supporting_actors: 5,
  min_supporting_actors: 3,
  recent_event_count: 8,
  nearby_building_limit: 8,
  turning_point_limit: 5,
  action_variety_window: 3,
  background_update_interval_turns: 1,
  agent_turn_timeout_ms: 90000,
  agent_turn_retries: 1,
  memory_update_retries: 2,
  high_stress_action_threshold: 75,
  low_energy_action_threshold: 20,
  monthly_tick_hour: 23,
  default_seed: 0,
  default_period_days: 3,
  default_scenes_per_day: 4,
  initial_sequence: 0,
  initial_turn_index: 0,
  default_cost_usd: 0,
  decision_readout_event_limit: 3,
  id_pad_width: 3,
  hour_pad_width: 2,
  fnv_offset_basis: 2166136261,
  fnv_prime: 16777619,
  spontaneous_interaction_base_percent: 8,
  spontaneous_interaction_known_bonus_percent: 10,
  spontaneous_interaction_close_bonus_percent: 10,
  spontaneous_interaction_tension_bonus_percent: 6,
  spontaneous_interaction_max_percent: 35,
  spontaneous_interactions_per_turn: 12,
  schedule_updates_per_actor_per_turn: 2,
} as const;

export const ORCHESTRATOR_PROTOCOL = {
  memory_prefix: "sim-memory",
  relationship_memory_prefix: "sim-relationship-memory",
  memory_version_prefix: "memv",
  episodic_memory_path: "/memories/episodic",
  relationship_memory_path: "/relationships",
  monthly_summary_path: "/summaries",
  day_turn_prefix: "day",
  monthly_turn_suffix: "monthly",
} as const;
