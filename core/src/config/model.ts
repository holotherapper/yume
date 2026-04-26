export const SUPPORTED_MODEL_IDS = [
  "claude-haiku-4-5",
  "claude-haiku-4-5-20251001",
  "claude-sonnet-4-6",
  "claude-opus-4-7",
] as const;

export type SupportedModelId = typeof SUPPORTED_MODEL_IDS[number];

export const SUPPORTED_MODEL_SPEEDS = ["standard", "fast"] as const;
export type SupportedModelSpeed = typeof SUPPORTED_MODEL_SPEEDS[number];

export const DEFAULT_MODEL_ID: SupportedModelId = "claude-opus-4-7";
export const DEFAULT_MODEL_SPEED: SupportedModelSpeed = "standard";

export const MODEL_IDS = {
  get focus_actor(): SupportedModelId {
    return resolveModelId("YUME_FOCUS_ACTOR_MODEL_ID", resolveDefaultModelId());
  },
  get default_actor(): SupportedModelId {
    return resolveModelId("YUME_DEFAULT_ACTOR_MODEL_ID", resolveDefaultModelId());
  },
  get protagonist(): SupportedModelId {
    return resolveModelId("YUME_PROTAGONIST_MODEL_ID", this.focus_actor);
  },
  get supporting(): SupportedModelId {
    return resolveModelId("YUME_SUPPORTING_MODEL_ID", this.default_actor);
  },
} as const;

export const MODEL_SPEEDS = {
  get focus_actor(): SupportedModelSpeed {
    return resolveModelSpeed("YUME_FOCUS_ACTOR_MODEL_SPEED", resolveDefaultModelSpeed());
  },
  get default_actor(): SupportedModelSpeed {
    return resolveModelSpeed("YUME_DEFAULT_ACTOR_MODEL_SPEED", resolveDefaultModelSpeed());
  },
} as const;

export function resolveRunModelId(configured?: string | null): SupportedModelId {
  return resolveModelIdValue(configured ?? undefined, "model_id", resolveDefaultModelId());
}

export function resolveRunModelSpeed(configured?: string | null): SupportedModelSpeed {
  return resolveModelSpeedValue(configured ?? undefined, "model_speed", resolveDefaultModelSpeed());
}

export function resolveDefaultModelId(): SupportedModelId {
  return resolveModelIdValue(
    process.env.YUME_DEFAULT_MODEL_ID ?? process.env.YUME_SIMULATOR_MODEL_ID,
    "YUME_DEFAULT_MODEL_ID",
    DEFAULT_MODEL_ID,
  );
}

export function resolveDefaultModelSpeed(): SupportedModelSpeed {
  return resolveModelSpeedValue(
    process.env.YUME_DEFAULT_MODEL_SPEED ?? process.env.YUME_SIMULATOR_MODEL_SPEED,
    "YUME_DEFAULT_MODEL_SPEED",
    DEFAULT_MODEL_SPEED,
  );
}

function resolveModelId(envName: string, fallback?: SupportedModelId): SupportedModelId {
  return resolveModelIdValue(process.env[envName], envName, fallback);
}

function resolveModelIdValue(
  configured: string | undefined,
  sourceName: string,
  fallback?: SupportedModelId,
): SupportedModelId {
  if (!configured) {
    if (fallback) return fallback;
    throw new Error(`${sourceName} is required and must be one of: ${SUPPORTED_MODEL_IDS.join(", ")}`);
  }
  if (SUPPORTED_MODEL_IDS.includes(configured as SupportedModelId)) {
    return configured as SupportedModelId;
  }
  throw new Error(`${sourceName} must be one of: ${SUPPORTED_MODEL_IDS.join(", ")}`);
}

function resolveModelSpeed(envName: string, fallback: SupportedModelSpeed = "standard"): SupportedModelSpeed {
  return resolveModelSpeedValue(process.env[envName], envName, fallback);
}

function resolveModelSpeedValue(
  configured: string | undefined,
  sourceName: string,
  fallback: SupportedModelSpeed = DEFAULT_MODEL_SPEED,
): SupportedModelSpeed {
  if (!configured) return fallback;
  if (SUPPORTED_MODEL_SPEEDS.includes(configured as SupportedModelSpeed)) {
    return configured as SupportedModelSpeed;
  }
  throw new Error(`${sourceName} must be one of: ${SUPPORTED_MODEL_SPEEDS.join(", ")}`);
}
