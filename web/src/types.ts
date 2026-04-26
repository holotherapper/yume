export type TimeSlot = 'morning' | 'noon' | 'evening' | 'night';
export type ModelId = 'claude-haiku-4-5' | 'claude-haiku-4-5-20251001' | 'claude-sonnet-4-6' | 'claude-opus-4-7';
export type ModelSpeed = 'standard' | 'fast';

export type ActorInput = {
  id?: string;
  display_name: string;
  role: string;
  is_focus?: boolean;
  age: number;
  gender?: string;
  mbti?: string;
  profile: string;
  initial_state?: Partial<LifeState>;
  initial_location_id?: string;
};

export type RelationshipState = {
  actor_id: string;
  closeness: number;
  trust: number;
  tension: number;
  last_interaction_day: number;
};

export type LifeState = {
  money: number;
  monthly_income?: number;
  monthly_expenses?: number;
  energy: number;
  stress: number;
  health: number;
  mood: number;
  job_satisfaction: number;
  relationships?: RelationshipState[];
  skills?: Record<string, number>;
};

export type WorldPosition = {
  x: number;
  y?: number;
  z?: number;
};

export type LocationInput = {
  id: string;
  display_name: string;
  description: string;
  resident_actor_ids: string[];
  kind?: string;
  position?: WorldPosition;
};

export type PathInput = {
  from_id: string;
  to_id: string;
  distance_meters?: number;
  bidirectional?: boolean;
};

export type RunConfig = {
  model_id: ModelId;
  model_speed: ModelSpeed;
  actors: ActorInput[];
  scenario: { title: string; description: string };
  world?: { locations: LocationInput[]; paths: PathInput[] };
  period_days: number;
  scenes_per_day: number;
  scheduler?: { max_active_actors_per_turn?: number; background_update_interval_turns?: number };
  config?: { cost_risk_acknowledged?: boolean };
};

export type BackendActor = {
  id: string;
  display_name: string;
  role: string;
  is_focus: boolean;
  age: number;
  gender: string;
  mbti: string;
  profile: string;
  initial_state?: Partial<LifeState>;
  initial_location_id?: string;
};

export type BackendLocation = {
  id: string;
  display_name: string;
  description: string;
  resident_actor_ids: string[];
  kind?: string;
  position?: WorldPosition;
};

export type BackendRelationship = {
  from: string;
  to: string;
  closeness: number;
  trust: number;
  tension: number;
  last_interaction_day: number;
};

export type RunResponse = {
  id: string;
  status: string;
  actors: BackendActor[];
  locations: BackendLocation[];
  world: { locations: BackendLocation[]; paths?: PathInput[] };
  relationships: BackendRelationship[];
  state: {
    focus_actor_id?: string;
    protagonist_id: string;
    input?: {
      period_days?: number;
      scenes_per_day?: number;
      model_id?: ModelId;
      model_speed?: ModelSpeed;
      scenario?: {
        title?: string;
        description?: string;
      };
    };
    actor_states?: Record<string, LifeState>;
    actor_locations?: Record<string, string>;
    events?: unknown[];
  } | null;
};

export type RunSummary = {
  id: string;
  status: string;
  created_at: string;
  updated_at: string;
  events_count: number;
  title?: string;
  description?: string;
  period_days?: number;
  scenes_per_day?: number;
  actors_count?: number;
  locations_count?: number;
  focus_actor_name?: string;
  error?: string;
};

export type UIEvent = {
  seq: number;
  day: number;
  slot: string;
  sim_hour: number;
  t: number;
  kind: string;
  actor: string;
  loc: string;
  text: string;
  state_summary?: LifeState;
};

export type SceneBuilding = {
  id: string;
  name: string;
  kind: string;
  role: string;
  position?: { x: number; z: number };
};

export type ScenePath = [string, string, string];

export type SceneActor = {
  id: string;
  name: string;
  role: string;
  mbti: string;
  age: number;
  loc: string;
};

export type SceneRelationship = {
  from: string;
  to: string;
  closeness: number;
  trust: number;
  tension: number;
};

export type SceneData = {
  buildings: SceneBuilding[];
  paths: ScenePath[];
  actors: SceneActor[];
  relationships: SceneRelationship[];
};
