import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PERSONALITY_TYPES, type PersonalityType } from "./personality-types";

export type MbtiBehaviorGuide = {
  summary: string;
  motivation: string;
  attention: string;
  decision_style: string;
  social_style: string;
  communication_style: string;
  relationship_style: string;
  conflict_style: string;
  stress_pattern: string;
  roleplay_cues: readonly string[];
  avoid_caricature: readonly string[];
};

const personalityTraitsConfig = loadPersonalityTraitsConfig();

export const MBTI_BEHAVIOR_SOURCE_URLS = personalityTraitsConfig.sourceUrls;
export const MBTI_BEHAVIOR_GUIDE = personalityTraitsConfig.traits;

function loadPersonalityTraitsConfig(): {
  sourceUrls: readonly string[];
  traits: Record<PersonalityType, MbtiBehaviorGuide>;
} {
  const path = join(import.meta.dirname, "..", "..", "config", "personality-traits.json");
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("personality-traits.json must contain an object");
  }
  const record = parsed as Record<string, unknown>;
  const sourceUrls = readStringArray(record.source_urls, "source_urls");
  const rawTraits = record.traits;
  if (!rawTraits || typeof rawTraits !== "object" || Array.isArray(rawTraits)) {
    throw new Error("personality-traits.json must contain traits object");
  }
  const rawTraitRecord = rawTraits as Record<string, unknown>;
  const extraTypes = Object.keys(rawTraitRecord).filter((key) => !PERSONALITY_TYPES.includes(key as PersonalityType));
  if (extraTypes.length > 0) {
    throw new Error(`personality-traits.json has unknown type keys: ${extraTypes.join(", ")}`);
  }
  const traits = Object.fromEntries(
    PERSONALITY_TYPES.map((type) => [type, readBehaviorGuide(rawTraitRecord[type], `traits.${type}`)]),
  ) as Record<PersonalityType, MbtiBehaviorGuide>;
  return { sourceUrls, traits };
}

function readBehaviorGuide(value: unknown, path: string): MbtiBehaviorGuide {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`personality-traits.json missing ${path}`);
  }
  const record = value as Record<string, unknown>;
  return {
    summary: readRequiredString(record.summary, `${path}.summary`),
    motivation: readRequiredString(record.motivation, `${path}.motivation`),
    attention: readRequiredString(record.attention, `${path}.attention`),
    decision_style: readRequiredString(record.decision_style, `${path}.decision_style`),
    social_style: readRequiredString(record.social_style, `${path}.social_style`),
    communication_style: readRequiredString(record.communication_style, `${path}.communication_style`),
    relationship_style: readRequiredString(record.relationship_style, `${path}.relationship_style`),
    conflict_style: readRequiredString(record.conflict_style, `${path}.conflict_style`),
    stress_pattern: readRequiredString(record.stress_pattern, `${path}.stress_pattern`),
    roleplay_cues: readStringArray(record.roleplay_cues, `${path}.roleplay_cues`),
    avoid_caricature: readStringArray(record.avoid_caricature, `${path}.avoid_caricature`),
  };
}

function readStringArray(value: unknown, path: string): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`personality-traits.json ${path} must be a non-empty string array`);
  }
  return value.map((item, index) => readRequiredString(item, `${path}.${index}`));
}

function readRequiredString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`personality-traits.json ${path} must be a non-empty string`);
  }
  return value;
}
