import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { buildReplayState, runDesignSimulation, type DesignOrchestratorOptions } from "./design-orchestrator";
import type { RunInput, SimState } from "./schema";

export type OrchestratorOptions = DesignOrchestratorOptions;
export { buildReplayState };

export async function runSimulation(
  input: RunInput,
  opts: OrchestratorOptions = {},
): Promise<SimState> {
  return runDesignSimulation(input, opts);
}

export async function saveRun(state: SimState): Promise<string> {
  const dir = join(import.meta.dirname, "..", "runs");
  await mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = join(dir, `run-${stamp}.json`);
  await Bun.write(path, JSON.stringify(state, null, 2));
  return path;
}
