import { z } from "zod";
import {
  ACTION_EFFECTS,
  ACTION_RULES,
  DISTRESS_PROFILE_PATTERN,
  DISTRESS_STATE_PATCH,
  ENGINE_DELTAS,
  EVENT_COPY,
  EVENT_THRESHOLDS,
  INITIAL_STATE_DEFAULTS,
  MONTHLY_RULES,
  ORCHESTRATOR_LIMITS,
  PROFILE_PRESETS,
  SIMULATION_BOUNDS,
} from "./simulator-config";

export const RelationshipState = z.object({
  actor_id: z.string(),
  closeness: z.number().min(SIMULATION_BOUNDS.min_meter).max(SIMULATION_BOUNDS.max_meter).default(INITIAL_STATE_DEFAULTS.relationship.closeness),
  trust: z.number().min(SIMULATION_BOUNDS.min_meter).max(SIMULATION_BOUNDS.max_meter).default(INITIAL_STATE_DEFAULTS.relationship.trust),
  tension: z.number().min(SIMULATION_BOUNDS.min_meter).max(SIMULATION_BOUNDS.max_meter).default(INITIAL_STATE_DEFAULTS.relationship.tension),
  last_interaction_day: z.number().default(INITIAL_STATE_DEFAULTS.relationship.last_interaction_day),
});
export type RelationshipState = z.infer<typeof RelationshipState>;

export const LifeState = z.object({
  money: z.number().default(INITIAL_STATE_DEFAULTS.money),
  monthly_income: z.number().default(INITIAL_STATE_DEFAULTS.monthly_income),
  monthly_expenses: z.number().default(INITIAL_STATE_DEFAULTS.monthly_expenses),
  energy: z.number().min(SIMULATION_BOUNDS.min_meter).max(SIMULATION_BOUNDS.max_meter).default(INITIAL_STATE_DEFAULTS.energy),
  health: z.number().min(SIMULATION_BOUNDS.min_meter).max(SIMULATION_BOUNDS.max_meter).default(INITIAL_STATE_DEFAULTS.health),
  stress: z.number().min(SIMULATION_BOUNDS.min_meter).max(SIMULATION_BOUNDS.max_meter).default(INITIAL_STATE_DEFAULTS.stress),
  mood: z.number().min(SIMULATION_BOUNDS.min_meter).max(SIMULATION_BOUNDS.max_meter).default(INITIAL_STATE_DEFAULTS.mood),
  job_satisfaction: z.number().min(SIMULATION_BOUNDS.min_meter).max(SIMULATION_BOUNDS.max_meter).default(INITIAL_STATE_DEFAULTS.job_satisfaction),
  relationships: z.array(RelationshipState).default([]),
  skills: z.record(z.string(), z.number()).default({}),
});
export type LifeState = z.infer<typeof LifeState>;

export type SimAction =
  | { type: "work" }
  | { type: "rest" }
  | { type: "exercise" }
  | { type: "eat_out" }
  | { type: "cook" }
  | { type: "study"; skill: string }
  | { type: "socialize"; actor_id: string }
  | { type: "commute" }
  | { type: "reach_out"; actor_id: string }
  | { type: "save_money" }
  | { type: "consider_decision" }
  | { type: "maintenance" }
  | { type: "sleep" };

export interface ActionEffect {
  money?: number;
  energy?: number;
  health?: number;
  stress?: number;
  mood?: number;
  job_satisfaction?: number;
  relationship_delta?: { actor_id: string; closeness?: number; trust?: number; tension?: number };
  skill_delta?: { skill: string; amount: number };
}

export interface AvailableAction {
  action: SimAction;
}

export interface SimEvent {
  type: string;
  severity: "low" | "medium" | "high";
  description: string;
}

export function applyAction(
  state: LifeState,
  action: SimAction,
): { state: LifeState; effect: ActionEffect } {
  const effectFn = ACTION_EFFECTS[action.type];
  if (!effectFn) return { state, effect: {} };

  const effect = effectFn(state);
  const next = cloneState(state);

  if (effect.money) next.money = Math.max(SIMULATION_BOUNDS.zero, next.money + effect.money);
  if (effect.energy) next.energy = clampMeter(next.energy + effect.energy);
  if (effect.health) next.health = clampMeter(next.health + effect.health);
  if (effect.stress) next.stress = clampMeter(next.stress + effect.stress);
  if (effect.mood) next.mood = clampMeter(next.mood + effect.mood);
  if (effect.job_satisfaction) {
    next.job_satisfaction = clampMeter(next.job_satisfaction + effect.job_satisfaction);
  }

  if (action.type === "study") {
    const current = next.skills[action.skill] ?? SIMULATION_BOUNDS.zero;
    next.skills = {
      ...next.skills,
      [action.skill]: Math.min(
        current + ENGINE_DELTAS.skill_growth,
        SIMULATION_BOUNDS.max_meter,
      ),
    };
    effect.skill_delta = { skill: action.skill, amount: ENGINE_DELTAS.skill_growth };
  }

  return { state: next, effect };
}

export function monthlyUpdate(state: LifeState): { state: LifeState; events: SimEvent[] } {
  const next = cloneState(state);
  const events: SimEvent[] = [];

  next.money += next.monthly_income - next.monthly_expenses;
  next.relationships = next.relationships.map((relationship) => ({
    ...relationship,
    closeness: clampMeter(
      relationship.closeness - MONTHLY_RULES.relationship_closeness_decay,
    ),
    last_interaction_day: relationship.last_interaction_day + MONTHLY_RULES.relationship_days_increment,
  }));

  if (next.money < next.monthly_expenses) {
    events.push(event("financial_pressure", "high"));
    next.stress = clampMeter(next.stress + MONTHLY_RULES.financial_pressure_stress_delta);
  }
  if (next.stress > MONTHLY_RULES.burnout_monthly_stress) {
    events.push(event("burnout_warning", "high"));
    next.health = clampMeter(next.health + MONTHLY_RULES.burnout_health_delta);
  }
  if (next.health < EVENT_THRESHOLDS.health_crisis) {
    events.push(event("health_crisis", "high"));
  }
  if (next.job_satisfaction < MONTHLY_RULES.career_crisis_job_satisfaction) {
    events.push(event("career_crisis", "medium"));
  }

  for (const relationship of next.relationships) {
    if (
      relationship.closeness < MONTHLY_RULES.relationship_drift_closeness &&
      relationship.last_interaction_day > MONTHLY_RULES.relationship_drift_days
    ) {
      events.push(event("relationship_drift", "low", `${EVENT_COPY.relationship_drift}: ${relationship.actor_id}`));
    }
    if (relationship.tension > MONTHLY_RULES.relationship_conflict_tension) {
      events.push(event("conflict_risk", "medium", `${EVENT_COPY.conflict_risk}: ${relationship.actor_id}`));
    }
  }

  return { state: next, events };
}

export function getAvailableActions(
  state: LifeState,
  timeSlot: "morning" | "noon" | "evening" | "night",
  localActorIds: string[],
  reachableActorIds: string[] = state.relationships.map((relationship) => relationship.actor_id),
): AvailableAction[] {
  const actions: AvailableAction[] = [];

  if (timeSlot === "night") {
    actions.push({ action: { type: "sleep" } });
  }

  if (state.energy > ACTION_RULES.work_energy_min && (timeSlot === "morning" || timeSlot === "noon")) {
    actions.push({ action: { type: "work" } });
  }

  actions.push({ action: { type: "rest" } });

  if (state.energy > ACTION_RULES.exercise_energy_min) {
    actions.push({ action: { type: "exercise" } });
  }

  if (state.money > ACTION_RULES.eat_out_min_money && (timeSlot === "noon" || timeSlot === "evening")) {
    actions.push({ action: { type: "eat_out" } });
  }

  actions.push({ action: { type: "cook" } });

  if (state.energy > ACTION_RULES.study_energy_min) {
    actions.push({ action: { type: "study", skill: "primary" } });
  }

  actions.push({ action: { type: "save_money" } });
  actions.push({ action: { type: "consider_decision" } });
  actions.push({ action: { type: "maintenance" } });

  const relationshipByActor = new Map(state.relationships.map((relationship) => [relationship.actor_id, relationship]));
  const uniqueLocalActorIds = [...new Set(localActorIds)];
  const uniqueReachableActorIds = [...new Set(reachableActorIds)];

  for (const actorId of uniqueLocalActorIds) {
    if (state.energy > ACTION_RULES.social_energy_min) {
      actions.push({ action: { type: "socialize", actor_id: actorId } });
    }
  }

  for (const actorId of uniqueReachableActorIds) {
    const relationship = relationshipByActor.get(actorId);
    if (!relationship) continue;
    if (state.energy <= ACTION_RULES.social_energy_min) continue;
    actions.push({ action: { type: "reach_out", actor_id: actorId } });
  }

  return actions.sort((left, right) => stableActionSortKey(left.action).localeCompare(stableActionSortKey(right.action)));
}

function stableActionSortKey(action: SimAction): string {
  return JSON.stringify(Object.keys(action)
    .sort()
    .reduce<Record<string, unknown>>((result, key) => {
      result[key] = (action as unknown as Record<string, unknown>)[key];
      return result;
    }, {}));
}

export function checkEventTriggers(
  state: LifeState,
  decisionQuestion?: string,
): SimEvent[] {
  const events: SimEvent[] = [];

  if (state.money < state.monthly_expenses) events.push(event("financial_pressure", "high"));
  if (state.stress >= EVENT_THRESHOLDS.burnout_stress) events.push(event("burnout_warning", "high"));
  if (state.health < EVENT_THRESHOLDS.health_crisis) events.push(event("health_crisis", "high"));
  if (
    state.stress > EVENT_THRESHOLDS.decision_pressure_stress &&
    state.job_satisfaction < EVENT_THRESHOLDS.decision_pressure_job_satisfaction &&
    decisionQuestion
  ) {
    events.push(event("decision_pressure", "high"));
  }
  if (state.mood < EVENT_THRESHOLDS.low_mood) events.push(event("low_mood", "medium"));

  for (const relationship of state.relationships) {
    if (relationship.tension >= EVENT_THRESHOLDS.conflict_tension) {
      events.push(event("conflict_risk", "medium", `${EVENT_COPY.conflict_risk}: ${relationship.actor_id}`));
    }
    if (
      relationship.closeness <= EVENT_THRESHOLDS.drift_closeness &&
      relationship.last_interaction_day > EVENT_THRESHOLDS.drift_days
    ) {
      events.push(event("relationship_drift", "low", `${EVENT_COPY.relationship_drift}: ${relationship.actor_id}`));
    }
  }

  if (state.money > state.monthly_expenses * EVENT_THRESHOLDS.financial_security_months) {
    events.push(event("financial_security", "low"));
  }
  if (weightedEvent(state, "stress_slip") && state.stress > EVENT_THRESHOLDS.decision_pressure_stress && state.mood < 45) {
    events.push(event("stress_slip", "medium"));
  }
  if (weightedEvent(state, "social_invitation") && state.relationships.some((relationship) => relationship.closeness > 75 && relationship.tension < 50)) {
    events.push(event("social_invitation", "low"));
  }

  return events;
}

export function formatStateForLLM(state: LifeState): string {
  const lines = [
    `Money: ${state.money} (income: ${state.monthly_income}/mo, expenses: ${state.monthly_expenses}/mo)`,
    `Energy: ${state.energy}/${SIMULATION_BOUNDS.max_meter}`,
    `Health: ${state.health}/${SIMULATION_BOUNDS.max_meter}`,
    `Stress: ${state.stress}/${SIMULATION_BOUNDS.max_meter}`,
    `Mood: ${state.mood}/${SIMULATION_BOUNDS.max_meter}`,
    `Job satisfaction: ${state.job_satisfaction}/${SIMULATION_BOUNDS.max_meter}`,
  ];

  if (state.relationships.length > 0) {
    lines.push("Relationships:");
    for (const relationship of state.relationships) {
      lines.push(
        `  ${relationship.actor_id}: closeness=${relationship.closeness}, trust=${relationship.trust}, tension=${relationship.tension}`,
      );
    }
  }

  const skills = Object.entries(state.skills);
  if (skills.length > 0) lines.push(`Skills: ${skills.map(([key, value]) => `${key}=${value}`).join(", ")}`);
  return lines.join("\n");
}

export function createInitialState(
  profile: { age: number; profile: string },
  supportingActorIds: string[],
): LifeState {
  const profileText = profile.profile.toLowerCase();
  const base = { ...INITIAL_STATE_DEFAULTS };

  for (const preset of PROFILE_PRESETS) {
    if (preset.pattern.test(profileText)) Object.assign(base, preset.state);
  }

  if (DISTRESS_PROFILE_PATTERN.test(profileText)) {
    base.money = Math.min(base.money, DISTRESS_STATE_PATCH.max_money);
    base.monthly_income = Math.min(base.monthly_income, DISTRESS_STATE_PATCH.max_income);
    base.monthly_expenses = Math.max(base.monthly_expenses, DISTRESS_STATE_PATCH.min_expenses);
    base.job_satisfaction = Math.min(base.job_satisfaction, DISTRESS_STATE_PATCH.max_job_satisfaction);
    base.stress = DISTRESS_STATE_PATCH.stress;
    base.energy = DISTRESS_STATE_PATCH.energy;
  }

  return {
    money: base.money,
    monthly_income: base.monthly_income,
    monthly_expenses: base.monthly_expenses,
    energy: base.energy,
    health: base.health,
    stress: base.stress,
    mood: base.mood,
    job_satisfaction: base.job_satisfaction,
    relationships: supportingActorIds.map((actorId) => ({
      actor_id: actorId,
      closeness: INITIAL_STATE_DEFAULTS.relationship.closeness,
      trust: INITIAL_STATE_DEFAULTS.relationship.trust,
      tension: INITIAL_STATE_DEFAULTS.relationship.tension,
      last_interaction_day: INITIAL_STATE_DEFAULTS.relationship.last_interaction_day,
    })),
    skills: {},
  };
}

function event(
  type: keyof typeof EVENT_COPY,
  severity: SimEvent["severity"],
  description: string = EVENT_COPY[type],
): SimEvent {
  return { type, severity, description };
}

function weightedEvent(state: LifeState, salt: string): boolean {
  const basis = [
    salt,
    Math.round(state.money / 1000),
    state.energy,
    state.health,
    state.stress,
    state.mood,
    state.job_satisfaction,
    state.relationships.map((relationship) => `${relationship.actor_id}:${relationship.closeness}:${relationship.tension}`).join("|"),
  ].join(":");
  let hashValue: number = ORCHESTRATOR_LIMITS.fnv_offset_basis;
  for (let index = 0; index < basis.length; index++) {
    hashValue ^= basis.charCodeAt(index);
    hashValue = Math.imul(hashValue, ORCHESTRATOR_LIMITS.fnv_prime);
  }
  return (hashValue >>> 0) % 100 < EVENT_THRESHOLDS.probabilistic_event_percent;
}

function cloneState(state: LifeState): LifeState {
  return {
    ...state,
    relationships: state.relationships.map((relationship) => ({ ...relationship })),
    skills: { ...state.skills },
  };
}

function clampMeter(value: number): number {
  return clamp(value, SIMULATION_BOUNDS.min_meter, SIMULATION_BOUNDS.max_meter);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
