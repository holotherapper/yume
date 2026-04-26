import type {
  RunConfig, RunResponse, UIEvent, LifeState,
  BackendActor, BackendLocation, SceneData, SceneBuilding, ScenePath, SceneActor, SceneRelationship, RunSummary,
} from '../types';

const API_BASE = import.meta.env.VITE_YUME_API_BASE ?? 'http://localhost:3001';

function slotIndex(slot: string): number {
  return ({ morning: 0, noon: 1, evening: 2, night: 3 } as Record<string, number>)[slot] ?? 0;
}

export async function startRun(config: RunConfig): Promise<RunResponse> {
  const res = await fetch(`${API_BASE}/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model_id: config.model_id,
      model_speed: config.model_speed,
      actors: config.actors,
      scenario: config.scenario,
      world: config.world,
      mode: 'day',
      period_days: config.period_days,
      scenes_per_day: config.scenes_per_day,
      scheduler: config.scheduler,
      config: config.config,
    }),
  });
  if (!res.ok) throw new Error(`Start failed (${res.status}): ${await res.text()}`);
  return res.json();
}

export async function listRuns(): Promise<RunSummary[]> {
  const res = await fetch(`${API_BASE}/runs`);
  if (!res.ok) throw new Error(`List runs failed (${res.status}): ${await res.text()}`);
  const data = await res.json();
  return Array.isArray(data.runs) ? data.runs : [];
}

export async function getRun(runId: string): Promise<RunResponse> {
  const res = await fetch(`${API_BASE}/runs/${runId}`);
  if (!res.ok) throw new Error(`Get run failed (${res.status}): ${await res.text()}`);
  return res.json();
}

export async function cancelRun(runId: string): Promise<{ id: string; status: string; cancelled: boolean; changed: boolean }> {
  const res = await fetch(`${API_BASE}/runs/${runId}/cancel`, {
    method: 'POST',
  });
  if (!res.ok) throw new Error(`Cancel failed (${res.status}): ${await res.text()}`);
  return res.json();
}

export async function healthCheck(): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE}/health`);
    return res.ok;
  } catch {
    return false;
  }
}

export function subscribe(
  runId: string,
  onEvent: (mapped: UIEvent | null, raw: any) => void,
  onComplete?: (raw: any) => void,
  onError?: (e: Event) => void,
): EventSource {
  const es = new EventSource(`${API_BASE}/runs/${runId}/events`);
  es.onmessage = (msg) => {
    try {
      const raw = JSON.parse(msg.data);
      onEvent(mapEvent(raw), raw);
      if (raw.type === 'run.complete' || raw.type === 'run.failed' || raw.type === 'run.cancelled') {
        onComplete?.(raw);
        es.close();
      }
    } catch (e) {
      console.error('[YUME] parse error:', e);
    }
  };
  es.onerror = (e) => onError?.(e);
  return es;
}

export function mapEvent(raw: any): UIEvent | null {
  const base = {
    seq: raw.seq as number,
    day: raw.day as number,
    slot: raw.slot as string,
    sim_hour: raw.sim_hour as number,
    t: ((raw.day as number) - 1) * 4 + slotIndex(raw.slot),
  };
  switch (raw.type) {
    case 'utterance':
      return { ...base, kind: 'utterance', actor: raw.speaker_id, loc: '', text: raw.text };
    case 'internal_reaction':
      return { ...base, kind: 'internal', actor: raw.subject_id, loc: '', text: raw.text };
    case 'move':
      return { ...base, kind: 'move', actor: raw.actor_id ?? '', loc: raw.to_location_id,
        text: `${raw.from_location_id} → ${raw.to_location_id}${raw.note ? ': ' + raw.note : ''}` };
    case 'state.update':
      return { ...base, kind: 'delta', actor: raw.actor_id ?? '', loc: '',
        text: fmtState(raw.state_summary), state_summary: raw.state_summary };
    case 'sim.event':
      return { ...base, kind: 'event', actor: '*', loc: '',
        text: `${raw.sim_event_type}: ${raw.description}` };
    case 'reach_out':
      return { ...base, kind: 'reach_out', actor: `${raw.from_actor_id}→${raw.to_actor_id}`,
        loc: '', text: raw.summary };
    case 'decision':
      return null;
    case 'run.complete':
      return { ...base, kind: 'event', actor: '*', loc: '', text: raw.summary ?? 'Simulation complete' };
    case 'run.failed':
      return { ...base, kind: 'event', actor: '*', loc: '', text: `Error: ${raw.message}` };
    case 'run.cancelled':
      return { ...base, kind: 'event', actor: '*', loc: '', text: raw.message ?? 'Run cancelled' };
    default:
      return null;
  }
}

function fmtState(s: any): string {
  if (!s) return '';
  const parts: string[] = [];
  if (s.energy != null) parts.push(`energy:${s.energy}`);
  if (s.stress != null) parts.push(`stress:${s.stress}`);
  if (s.health != null) parts.push(`health:${s.health}`);
  if (s.mood != null) parts.push(`mood:${s.mood}`);
  if (s.money != null) parts.push(`¥${s.money.toLocaleString()}`);
  if (s.job_satisfaction != null) parts.push(`job:${s.job_satisfaction}`);
  return parts.join(' · ');
}

export function responseToSceneData(
  res: RunResponse,
): SceneData {
  const buildings: SceneBuilding[] = res.locations.map(l => ({
    id: l.id,
    name: l.display_name,
    kind: l.kind ?? 'block',
    role: l.description ?? '',
    position: l.position ? { x: l.position.x, z: l.position.z ?? l.position.y ?? 0 } : undefined,
  }));

  const paths: ScenePath[] = [];
  const worldPaths = res.world?.paths;
  if (worldPaths && Array.isArray(worldPaths)) {
    for (const p of worldPaths) {
      const dist = p.distance_meters ?? 200;
      const qual = dist < 80 ? 'adjacent' : dist < 250 ? 'near' : 'far';
      paths.push([p.from_id, p.to_id, qual]);
    }
  } else if (buildings.length > 1) {
    for (let i = 0; i < buildings.length; i++) {
      for (let j = i + 1; j < buildings.length; j++) {
        if (i === 0 || j === 0) paths.push([buildings[i].id, buildings[j].id, 'near']);
      }
    }
  }

  const focusId = res.state?.focus_actor_id ?? res.state?.protagonist_id;
  const actors: SceneActor[] = res.actors.map(a => ({
    id: a.id,
    name: a.display_name,
    role: a.role,
    mbti: a.mbti ?? 'INFP',
    age: a.age ?? 30,
    loc: res.state?.actor_locations?.[a.id] ?? res.locations.find(l => l.resident_actor_ids?.includes(a.id))?.id ?? buildings[0]?.id ?? '',
  }));

  const seen = new Set<string>();
  const relationships: SceneRelationship[] = [];
  if (res.relationships && Array.isArray(res.relationships)) {
    for (const r of res.relationships) {
      const pair = [r.from, r.to].sort().join(':');
      if (seen.has(pair)) continue;
      seen.add(pair);
      relationships.push({ from: r.from, to: r.to, closeness: r.closeness ?? 50, trust: r.trust ?? 50, tension: r.tension ?? 20 });
    }
  }

  return { buildings, paths, actors, relationships };
}
