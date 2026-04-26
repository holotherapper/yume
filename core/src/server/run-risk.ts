import type { RunInput } from "../schema";
import { ORCHESTRATOR_LIMITS, resolveRunModelId } from "../simulator-config";

export type RunRiskAssessment = {
  requiresAcknowledgement: boolean;
  model_id: string;
  actors_count: number;
  period_days: number;
  scenes_per_day: number;
  actors_per_turn: number;
  estimated_actor_turns: number;
  risk_level: "normal" | "elevated" | "high";
  reasons: string[];
};

const ELEVATED_ACTOR_TURNS = 80;
const HIGH_ACTOR_TURNS = 300;
const LARGE_ACTOR_COUNT = 50;
const LONG_PERIOD_DAYS = 7;

export function assessRunRisk(input: RunInput): RunRiskAssessment {
  const actorsCount = input.actors?.length ?? 0;
  const periodDays = input.period_days ?? ORCHESTRATOR_LIMITS.default_period_days;
  const scenesPerDay = input.scenes_per_day ?? ORCHESTRATOR_LIMITS.default_scenes_per_day;
  const actorsPerTurn = Math.max(1, actorsCount);
  const estimatedActorTurns = periodDays * scenesPerDay * actorsPerTurn;
  const modelId = resolveRunModelId(input.model_id);
  const isOpus = modelId.includes("opus");
  const reasons: string[] = [];

  if (isOpus && estimatedActorTurns >= ELEVATED_ACTOR_TURNS) {
    reasons.push("Opus is selected for a multi-turn run.");
  }
  if (estimatedActorTurns >= HIGH_ACTOR_TURNS) {
    reasons.push(`Estimated actor-turns are high (${estimatedActorTurns}).`);
  } else if (estimatedActorTurns >= ELEVATED_ACTOR_TURNS) {
    reasons.push(`Estimated actor-turns are elevated (${estimatedActorTurns}).`);
  }
  if (actorsCount >= LARGE_ACTOR_COUNT) {
    reasons.push(`Actor count is large (${actorsCount}).`);
  }
  if (periodDays >= LONG_PERIOD_DAYS) {
    reasons.push(`Period is long (${periodDays} days).`);
  }
  const riskLevel: RunRiskAssessment["risk_level"] =
    isOpus && (estimatedActorTurns >= ELEVATED_ACTOR_TURNS || actorsCount >= LARGE_ACTOR_COUNT || periodDays >= LONG_PERIOD_DAYS)
      ? "high"
      : estimatedActorTurns >= HIGH_ACTOR_TURNS || actorsCount >= LARGE_ACTOR_COUNT || periodDays >= LONG_PERIOD_DAYS
        ? "elevated"
        : "normal";

  return {
    requiresAcknowledgement: riskLevel !== "normal",
    model_id: modelId,
    actors_count: actorsCount,
    period_days: periodDays,
    scenes_per_day: scenesPerDay,
    actors_per_turn: actorsPerTurn,
    estimated_actor_turns: estimatedActorTurns,
    risk_level: riskLevel,
    reasons,
  };
}
