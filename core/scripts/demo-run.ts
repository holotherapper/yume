/**
 * CLI entrypoint for a deterministic simulator run.
 *
 * Usage:
 *   bun run demo
 *   PERIOD_DAYS=1 bun run demo
 */

import { runSimulation, saveRun } from "../src/orchestrator";
import type { Event, RunInput } from "../src/schema";

const periodDays = Number.parseInt(process.env.PERIOD_DAYS ?? "3", 10);

const weekdaySchedule = {
  Mon: { morning: "home", noon: "school", evening: "workplace", night: "home" },
  Tue: { morning: "home", noon: "school", evening: "home", night: "home" },
  Wed: { morning: "home", noon: "school", evening: "workplace", night: "home" },
  Thu: { morning: "home", noon: "school", evening: "workplace", night: "home" },
  Fri: { morning: "home", noon: "school", evening: "workplace", night: "home" },
  Sat: { morning: "home", noon: "home", evening: "workplace", night: "home" },
  Sun: { morning: "home", noon: "home", evening: "home", night: "home" },
};

const demoInput: RunInput = {
  mode: "day",
  period_days: periodDays,
  scenes_per_day: 4,
  seed: 7,
  protagonist: {
    name: "Ayaka",
    age: 21,
    gender: "female",
    mbti: "INFJ",
    profile:
      "Third-year literature student. Lives with her mother, works evening cafe shifts, and feels pressure about money and future work.",
    values: "autonomy over status, craft over money, quiet life over nightlife",
    interests: "literature, slow coffee, long walks",
    fears: "disappearing into a life she did not choose",
    language: "English",
    schedule: weekdaySchedule,
  },
  supporting: [
    {
      role: "family",
      display_name: "Mother",
      age: 49,
      gender: "female",
      mbti: "ISFJ",
      memo: "Kind and protective. Notices small changes in Ayaka's mood.",
    },
    {
      role: "close_friend",
      display_name: "Yui",
      age: 21,
      gender: "female",
      mbti: "ENFP",
      memo: "Same faculty. Warm, direct, and willing to challenge avoidance.",
    },
    {
      role: "part_time_peer",
      display_name: "Sakurai",
      age: 26,
      gender: "male",
      mbti: "ISTP",
      memo: "Senior cafe staff. Quiet, reliable, and observant.",
    },
  ],
  decision_context: {
    question: "Should Ayaka reduce shifts and prioritize study?",
    options: ["keep current shifts", "reduce shifts", "ask for advice"],
  },
};

const onEvent = (event: Event) => {
  if (
    event.type === "day.start" ||
    event.type === "slot.start" ||
    event.type === "decision" ||
    event.type === "state.update" ||
    event.type === "sim.event" ||
    event.type === "run.complete"
  ) {
    console.log(JSON.stringify(event));
  }
};

const startedAt = performance.now();
const state = await runSimulation(demoInput, { onEvent });
const elapsedMs = performance.now() - startedAt;
const savedPath = await saveRun(state);

console.log(
  JSON.stringify({
    type: "cli.summary",
    elapsed_seconds: Number((elapsedMs / 1000).toFixed(2)),
    events: state.events.length,
    final_state: state.life_state,
    saved_path: savedPath,
  }),
);
