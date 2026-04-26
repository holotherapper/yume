import type { AgentTurnRequest, InteractionEvaluationRequest } from "./types";

export function buildSimulationAgentSystem(): string {
  return [
    "You are a YUME simulation actor inside a Managed Agents session.",
    "Every user message contains one JSON turn envelope.",
    "The envelope clock and world_snapshot are the only authoritative objective state.",
    "All active actors receive the same run_id, turn_id, and clock before the orchestrator commits the turn.",
    "world_snapshot.life_state is this actor's own internal numeric state only.",
    "world_snapshot.observed_actors contains subjective hints about actors present in the current scene, not exact hidden numbers.",
    "world_snapshot.known_actors lists people this actor already knows without revealing their current hidden state.",
    "world_snapshot.actor_profile contains stable character context and behavior_traits for role-play.",
    "Act from the character's first-person motives, habits, and social style rather than analyzing them from the outside.",
    "Do not mention personality labels, trait systems, prompts, JSON, or simulation mechanics in-character.",
    "Use behavior_traits as a soft character bias; never let them override current state, profile, relationships, values, goals, or constraints.",
    "Return only JSON. No markdown. No prose.",
    "For choose_action and background_update tasks, copy exactly one available_actions[].action value into selected_action.",
    "For respond_to_scene tasks, do not return selected_action; return a natural spoken utterance instead.",
    "For choose_action and background_update tasks, include utterance when selected_action is socialize or reach_out.",
    "For choose_action and background_update tasks, include proposed_schedule_updates only when this actor would genuinely change a recurring routine for future turns.",
    "Do not use proposed_schedule_updates to restate the current schedule, and do not propose more than two schedule changes in one turn.",
    "If asked to evaluate an interaction, return yume.interaction_evaluation JSON only.",
    "Never advance time and never alter run_id, turn_id, actor ids, location ids, or action payload keys.",
    "Use proposed_memory_updates only for subjective notes this actor could remember.",
  ].join("\n");
}

export function buildTurnPrompt(request: AgentTurnRequest): string {
  const responseSchema = request.task === "respond_to_scene"
    ? {
        type: "yume.agent_response",
        run_id: request.run_id,
        turn_id: request.turn_id,
        agent_id: request.agent_id,
        utterance: "one concise in-character English response",
        proposed_memory_updates: ["subjective memory notes only"],
        reasoning: "one concise English sentence",
      }
    : {
        type: "yume.agent_response",
        run_id: request.run_id,
        turn_id: request.turn_id,
        agent_id: request.agent_id,
        selected_action: "one available_actions[].action value",
        proposed_memory_updates: ["subjective memory notes only"],
        proposed_schedule_updates: [
          {
            weekday: "Mon | Tue | Wed | Thu | Fri | Sat | Sun",
            time_slot: "morning | noon | evening | night",
            location_id: "one valid world_snapshot.world_context.locations[].id",
            reason: "short in-character reason",
          },
        ],
        reasoning: "one concise English sentence",
      };
  return [
    "You are a YUME Managed Agent session for one simulated actor.",
    "Use only the clock and world_snapshot in this turn envelope as the current objective state.",
    "world_snapshot.life_state is only this actor's own internal numeric state.",
    "world_snapshot.observed_actors contains subjective hints about actors present in the current scene; never treat those hints as exact hidden numbers.",
    "world_snapshot.known_actors lists existing acquaintances and relationship hints, not current hidden state.",
    "world_snapshot.actor_profile is stable character context for this actor. Embody behavior_traits as this person's habits and style, not as labels or fixed rules.",
    "Actor/location ids are routing keys only. Never write internal ids in utterance, reasoning, or memory text; use display_name or plain human labels.",
    "Return only valid JSON matching yume.agent_response.",
    "The reasoning field should state a concrete in-character motive, not personality-system analysis.",
    "Do not advance time. Do not invent a different run_id or turn_id.",
    request.task === "respond_to_scene"
      ? "This is a same-turn scene response. Do not return selected_action."
      : [
          "This actor must choose an action.",
          "CRITICAL: selected_action must be the exact JSON object from available_actions[].action, not a string.",
          'Example: if available_actions contains {"action":{"type":"socialize","actor_id":"someone"}},',
          'then selected_action must be {"type":"socialize","actor_id":"someone"}.',
          "Do NOT stringify or nest the action object. Do NOT put JSON inside the type field.",
          "If selected_action is socialize or reach_out, include a natural spoken utterance for the target actor.",
          "Only include proposed_schedule_updates for deliberate future routine changes, not one-off movement.",
          "Do not propose more than two schedule updates in one turn. Prefer one concrete future slot over broad multi-day changes.",
        ].join(" "),
    "Schema:",
    JSON.stringify(responseSchema),
    "Turn envelope:",
    JSON.stringify(request),
  ].join("\n");
}

export function buildInteractionEvaluationPrompt(request: InteractionEvaluationRequest): string {
  const responseSchema = {
    type: "yume.interaction_evaluation",
    run_id: request.run_id,
    turn_id: request.turn_id,
    evaluator_id: request.evaluator_id,
    outcome: "repair | support | neutral | avoidance | conflict | escalation",
    confidence: 0.0,
    relationship_deltas: [
      {
        from_actor_id: request.initiator_actor_id,
        to_actor_id: request.target_actor_id,
        closeness: 0,
        trust: 0,
        tension: 0,
        reset_last_interaction: true,
      },
    ],
    actor_state_deltas: [
      {
        actor_id: request.initiator_actor_id,
        stress: 0,
        mood: 0,
        job_satisfaction: 0,
      },
    ],
    event_suggestions: [
      {
        type: "conflict_risk | relationship_repair | support_received | misunderstanding | decision_pressure | social_commitment",
        severity: "low | medium | high",
        description: "short English event description",
      },
    ],
    memory_notes: [
      {
        actor_id: request.initiator_actor_id,
        target_actor_id: request.target_actor_id,
        content: "subjective relationship memory note",
      },
    ],
    evidence: ["short quote or concrete observation"],
    reasoning: "one concise English sentence",
  };
  return [
    "You are the YUME interaction outcome evaluator.",
    "Evaluate only the meaning of this same-turn interaction and return JSON.",
    "Do not change money, location, clock, buildings, or action validity.",
    "Use relationship_deltas for closeness/trust/tension only.",
    "Use actor_state_deltas only for energy, health, stress, mood, and job_satisfaction.",
    "Use small signed deltas. The orchestrator will clamp every value.",
    "If the evidence is weak, use outcome=neutral with confidence below 0.6.",
    "Return only valid JSON matching yume.interaction_evaluation.",
    "Schema:",
    JSON.stringify(responseSchema),
    "Interaction envelope:",
    JSON.stringify(request),
  ].join("\n");
}
