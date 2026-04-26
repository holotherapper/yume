import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { YumeScene } from './scene/YumeScene';
import * as api from './api/client';
import type { RunConfig, RunResponse, UIEvent, LifeState, BackendActor, SceneData, RunSummary, ModelId, ModelSpeed } from './types';

type Phase = 'setup' | 'connecting' | 'running' | 'completed' | 'failed' | 'cancelled';

const DISPLAY_KINDS = new Set(['utterance', 'internal', 'move', 'delta', 'event', 'reach_out']);

const MODEL_OPTIONS: Array<{ value: ModelId; label: string }> = [
  { value: 'claude-opus-4-7', label: 'Opus 4.7' },
  { value: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
  { value: 'claude-haiku-4-5', label: 'Haiku 4.5' },
  { value: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5 20251001' },
];
const SPEED_OPTIONS: Array<{ value: ModelSpeed; label: string }> = [
  { value: 'standard', label: 'Standard' },
  { value: 'fast', label: 'Fast' },
];
const SCENES_PER_DAY = 4;
const ELEVATED_ACTOR_TURNS = 80;
const HIGH_ACTOR_TURNS = 300;

function slotLabel(s: string) { return ({ morning: 'MORNING', noon: 'NOON', evening: 'EVENING', night: 'NIGHT' } as Record<string, string>)[s] || s.toUpperCase(); }
function slotHour(s: string) { return ({ morning: '08:00', noon: '12:00', evening: '19:00', night: '23:00' } as Record<string, string>)[s] || ''; }
function slotIdx(s: string) { return ({ morning: 0, noon: 1, evening: 2, night: 3 } as Record<string, number>)[s] ?? 0; }
function weekdayOf(d: number) { return ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'][(d - 1) % 7]; }
function formatMoney(n: number) { return '¥' + n.toLocaleString(); }
function rawTick(raw: any): number { return ((raw.day ?? 1) - 1) * 4 + slotIdx(raw.slot ?? 'morning'); }
function formatRunTime(value: string): string {
  return new Date(value).toLocaleString(undefined, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}
function phaseFromStatus(status: string): Phase {
  if (status === 'completed' || status === 'failed' || status === 'cancelled') return status;
  return 'running';
}
function parsePositiveInt(value: string): number | null {
  if (!value.trim()) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}
function modelLabel(modelId: ModelId): string {
  return MODEL_OPTIONS.find(option => option.value === modelId)?.label ?? modelId;
}
function buildRiskConfirmation(args: {
  modelId: ModelId;
  actorsCount: number;
  days: number;
  scenesPerDay: number;
}): string | null {
  const actorTurns = args.days * args.scenesPerDay * args.actorsCount;
  const reasons: string[] = [];
  if (args.modelId.includes('opus') && actorTurns >= ELEVATED_ACTOR_TURNS) reasons.push('Opus is selected for a multi-turn run.');
  if (actorTurns >= HIGH_ACTOR_TURNS) reasons.push(`Estimated actor-turns are high (${actorTurns}).`);
  else if (actorTurns >= ELEVATED_ACTOR_TURNS) reasons.push(`Estimated actor-turns are elevated (${actorTurns}).`);
  if (args.actorsCount >= 50) reasons.push(`Actor count is large (${args.actorsCount}).`);
  if (args.days >= 7) reasons.push(`Period is long (${args.days} days).`);
  if (reasons.length === 0) return null;
  return [
    'This run can incur noticeable API cost.',
    '',
    `Model: ${modelLabel(args.modelId)}`,
    `Actors: ${args.actorsCount}`,
    `Period: ${args.days} days x ${args.scenesPerDay} turns/day`,
    `Estimated actor-turns: ${actorTurns}`,
    '',
    ...reasons.map(reason => `- ${reason}`),
    '',
    'Start this run?',
  ].join('\n');
}

// ── Start Form ────────────────────────────────────────────────────────────

const DEFAULT_ACTORS = '';

const DEFAULT_LOCATIONS = '';

function StartForm({ onStart, onResume }: { onStart: (config: RunConfig) => void; onResume: (runId: string) => Promise<void> }) {
  const [worldContext, setWorldContext] = useState('');
  const [daysText, setDaysText] = useState('3');
  const [modelId, setModelId] = useState<ModelId>('claude-opus-4-7');
  const [modelSpeed, setModelSpeed] = useState<ModelSpeed>('standard');
  const [actorsJson, setActorsJson] = useState(DEFAULT_ACTORS);
  const [locationsJson, setLocationsJson] = useState(DEFAULT_LOCATIONS);
  const [error, setError] = useState('');
  const [healthy, setHealthy] = useState<boolean | null>(null);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [resumingId, setResumingId] = useState('');
  const actorsFileRef = useRef<HTMLInputElement>(null);
  const locsFileRef = useRef<HTMLInputElement>(null);
  const refreshRuns = useCallback(async () => {
    try {
      setRuns(await api.listRuns());
    } catch {
      setRuns([]);
    }
  }, []);
  useEffect(() => {
    let active = true;
    void (async () => {
      const ok = await api.healthCheck();
      if (!active) return;
      setHealthy(ok);
      if (ok) await refreshRuns();
    })();
    return () => { active = false; };
  }, [refreshRuns]);

  const handleFileUpload = (setter: (v: string) => void) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try { setter(JSON.stringify(JSON.parse(reader.result as string), null, 2)); }
      catch { setter(reader.result as string); }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const handleStart = () => {
    setError('');
    const days = parsePositiveInt(daysText);
    if (!days) { setError('Period days must be at least 1.'); return; }
    let actors, locations;
    try {
      actors = JSON.parse(actorsJson.trim() || '[]');
      if (!Array.isArray(actors) || actors.length === 0) throw new Error('actors must be a non-empty array');
    } catch (e: any) { setError('Actors JSON: ' + e.message); return; }
    try {
      locations = JSON.parse(locationsJson.trim() || '[]');
      if (!Array.isArray(locations) || locations.length === 0) throw new Error('locations must be a non-empty array');
    } catch (e: any) { setError('Locations JSON: ' + e.message); return; }
    const riskConfirmation = buildRiskConfirmation({
      modelId,
      actorsCount: actors.length,
      days,
      scenesPerDay: SCENES_PER_DAY,
    });
    if (riskConfirmation && !window.confirm(riskConfirmation)) return;
    onStart({
      model_id: modelId,
      model_speed: modelSpeed,
      actors,
      scenario: { title: 'Simulation', description: worldContext },
      world: { locations, paths: [] },
      period_days: days,
      scenes_per_day: SCENES_PER_DAY,
      scheduler: { background_update_interval_turns: 1 },
      config: { cost_risk_acknowledged: Boolean(riskConfirmation) },
    });
  };

  const handleResume = async (runId: string) => {
    setError('');
    setResumingId(runId);
    try {
      await onResume(runId);
    } catch (e: any) {
      setError('Resume run: ' + (e?.message ?? String(e)));
      setResumingId('');
      await refreshRuns();
    }
  };

  return (
    <div className="setup-screen"><div className="setup-card">
      <div className="setup-header">
        <h1>YUME</h1><p className="sub">Simulator</p>
      </div>
      <div className="setup-top">
        <label className="setup-ctx">World context<textarea value={worldContext} onChange={e => setWorldContext(e.target.value)} rows={3} placeholder="Describe the world situation: economic conditions, social tensions, recent events, political climate, etc." /></label>
        <div className="setup-days">
          <span className="setup-days-label">Period (days)</span>
          <div className="stepper">
            <button type="button" onClick={() => setDaysText(String(Math.max(1, (parsePositiveInt(daysText) ?? 1) - 1)))}>−</button>
            <input className="stepper-val" inputMode="numeric" value={daysText} onChange={e => setDaysText(e.target.value.replace(/\D/g, ''))} onBlur={() => { if (!parsePositiveInt(daysText)) setDaysText('1'); }} />
            <button type="button" onClick={() => setDaysText(String((parsePositiveInt(daysText) ?? 0) + 1))}>+</button>
          </div>
        </div>
        <div className="setup-model">
          <span className="setup-days-label">Agent model</span>
          <select value={modelId} onChange={e => setModelId(e.target.value as ModelId)}>
            {MODEL_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
          <select value={modelSpeed} onChange={e => setModelSpeed(e.target.value as ModelSpeed)}>
            {SPEED_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </div>
      </div>
      <input type="file" ref={actorsFileRef} accept=".json" hidden onChange={handleFileUpload(setActorsJson)} />
      <input type="file" ref={locsFileRef} accept=".json" hidden onChange={handleFileUpload(setLocationsJson)} />
      <div className="setup-grid">
        <div>
          <span className="label-row"><span className="field-label">Actors (JSON)</span> <button type="button" className="upload-btn" onClick={() => actorsFileRef.current?.click()}>Upload</button></span>
          <textarea value={actorsJson} onChange={e => setActorsJson(e.target.value)} rows={14}
            placeholder={`[\n  { "display_name": "Ren Takahashi", "role": "office_worker",\n    "is_focus": true, "age": 32, "gender": "male",\n    "mbti": "ENFP",\n    "profile": "UX designer at a startup in Shibuya.",\n    "initial_location_id": "apt_a" }\n]`} />
        </div>
        <div>
          <span className="label-row"><span className="field-label">Locations (JSON)</span> <button type="button" className="upload-btn" onClick={() => locsFileRef.current?.click()}>Upload</button></span>
          <textarea value={locationsJson} onChange={e => setLocationsJson(e.target.value)} rows={14}
            placeholder={`[\n  { "id": "shibuya_station",\n    "display_name": "Shibuya Station",\n    "description": "Major transit hub.",\n    "kind": "flat", "position": { "x": 0, "z": 0 },\n    "resident_actor_ids": [] },\n  { "id": "apt_a",\n    "display_name": "Apartment A",\n    "description": "Residential.",\n    "kind": "block",\n    "resident_actor_ids": ["ren_takahashi"] }\n]`} />
        </div>
      </div>
      {error && <div className="err">{error}</div>}
      <button onClick={handleStart} disabled={healthy !== true || !worldContext.trim() || !actorsJson.trim() || !locationsJson.trim() || !parsePositiveInt(daysText)}>
        {healthy === null ? 'Connecting...' : healthy ? 'Start Simulation' : 'Backend Offline'}
      </button>
      {runs.length > 0 && (
        <div className="run-history">
          <div className="run-history-head">
            <span>Recent runs</span>
            <button type="button" className="run-refresh" onClick={refreshRuns}>Refresh</button>
          </div>
          <div className="run-history-list">
            {runs.slice(0, 8).map(run => (
              <button
                key={run.id}
                type="button"
                className="run-item"
                disabled={!!resumingId}
                onClick={() => void handleResume(run.id)}
              >
                <span className="run-main">
                  <span className="run-time">{formatRunTime(run.created_at)}</span>
                  <span className={`run-status run-status-${run.status}`}>{run.status.toUpperCase()}</span>
                </span>
                <span className="run-meta">
                  {run.period_days ?? '?'}d · {run.actors_count ?? '?'} actors · {run.events_count} events
                  {run.focus_actor_name ? ` · ${run.focus_actor_name}` : ''}
                </span>
                <span className="run-id">{resumingId === run.id ? 'OPENING...' : run.id.slice(0, 8)}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div></div>
  );
}

// ── UI Components ─────────────────────────────────────────────────────────

function MeterRow({ label, value, kind }: { label: string; value: number; kind: string }) {
  const v = Math.max(0, Math.min(100, Math.round(value)));
  return (<div className={'meter m-' + kind}><div className="lbl">{label}</div><div className="bar"><div className="fill" style={{ width: v + '%' }} /></div><div className="val">{v}</div></div>);
}

function FocusCard({ actor, state, locationName }: { actor: BackendActor; state: LifeState; locationName: string }) {
  return (
    <div className="card focus-card">
      <h3>FOCUS ACTOR <span className="rule" /></h3>
      <div className="focus-name"><span className="n">{actor.display_name}</span><span className="r">{actor.role}</span></div>
      <div className="focus-meta">{actor.mbti}<span className="sep">·</span>{actor.age}<span className="sep">·</span>{locationName}</div>
      <div className="meters">
        <MeterRow label="Energy" value={state.energy} kind="energy" />
        <MeterRow label="Stress" value={state.stress} kind="stress" />
        <MeterRow label="Health" value={state.health} kind="health" />
        <MeterRow label="Mood" value={state.mood} kind="mood" />
        <MeterRow label="Job Sat" value={state.job_satisfaction} kind="jobsat" />
      </div>
      <div className="money-row"><span className="lbl">Money</span><span className="v">{formatMoney(state.money)}</span></div>
    </div>
  );
}

type RelData = { actor_id: string; closeness: number; trust: number; tension: number };

function RelMeter({ label, value, kind }: { label: string; value: number; kind: string }) {
  const v = Math.max(0, Math.min(100, Math.round(value)));
  return (<div className={'meter m-' + kind}><div className="lbl">{label}</div><div className="bar"><div className="fill" style={{ width: v + '%' }} /></div><div className="val">{v}</div></div>);
}

function Relationships({ focusId, focusName, actors, relationships }: { focusId: string; focusName: string; actors: BackendActor[]; relationships: RelData[] }) {
  if (!relationships.length) return null;
  return (
    <div className="card rel-card">
      <h3>RELATIONSHIPS <span className="rule" /></h3>
      <div className="rel-legend">
        <span className="rel-leg-item"><i className="rel-dot close" />CLOSE</span>
        <span className="rel-leg-item"><i className="rel-dot trust" />TRUST</span>
        <span className="rel-leg-item"><i className="rel-dot tension" />TENSION</span>
      </div>
      <div className="rel-pairs">
        {relationships.map((r, i) => {
          const other = actors.find(a => a.id === r.actor_id);
          if (!other) return null;
          return (
            <div key={i} className="rel-pair">
              <div className="rel-pair-label">{focusName} → {other.display_name}</div>
              <div className="meters">
                <RelMeter label="CLOSE" value={r.closeness} kind="close" />
                <RelMeter label="TRUST" value={r.trust} kind="trust" />
                <RelMeter label="TENSION" value={r.tension} kind="tension" />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ActorList({ actors, focusId, onPick, states }: {
  actors: BackendActor[]; focusId: string; onPick: (id: string) => void; states: Record<string, LifeState>;
}) {
  return (
    <div className="card">
      <h3>ACTORS <span className="rule" /><span style={{ color: 'var(--ink-dim)', fontWeight: 400, letterSpacing: 0, textTransform: 'none' as const }}>{actors.length}</span></h3>
      <div className="actor-list">
        {actors.map(a => {
          const s = states[a.id];
          return (
            <div key={a.id} className={'actor-row' + (a.id === focusId ? ' focused' : '')} onClick={() => onPick(a.id)}>
              <div><div className="n">{a.display_name}</div><div className="r">{a.role} · {a.mbti}</div></div>
              <div className="s">S{Math.round(s?.stress ?? 0)} · E{Math.round(s?.energy ?? 0)}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function EventLog({ events, tick, actors }: { events: UIEvent[]; tick: number; actors: BackendActor[] }) {
  const [filterActor, setFilterActor] = useState('');
  const [filterKind, setFilterKind] = useState('');
  const bodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const cur = bodyRef.current?.querySelector('.ev.current');
    if (cur) cur.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [tick]);
  const filtered = events.filter(e => {
    if (filterActor && e.actor !== filterActor) return false;
    if (filterKind && e.kind !== filterKind) return false;
    return true;
  });
  return (
    <div className="card events">
      <h3>EVENT STREAM <span className="rule" /><span style={{ color: 'var(--ink-dim)', fontWeight: 400, textTransform: 'none' as const, letterSpacing: 0 }}>{filtered.length}/{events.length}</span></h3>
      <div className="ev-filters">
        <select value={filterActor} onChange={e => setFilterActor(e.target.value)}>
          <option value="">All actors</option>
          {actors.map(a => <option key={a.id} value={a.id}>{a.display_name}</option>)}
        </select>
        <select value={filterKind} onChange={e => setFilterKind(e.target.value)}>
          <option value="">All types</option>
          <option value="utterance">Utterance</option>
          <option value="internal">Internal</option>
          <option value="move">Move</option>
          <option value="delta">Delta</option>
          <option value="event">Event</option>
        </select>
      </div>
      <div className="events-body" ref={bodyRef}>
        {filtered.map(e => {
          const cls = e.t < tick ? '' : e.t === tick ? 'current' : 'future';
          let who = e.actor;
          if (e.kind === 'move') who = 'MOVE';
          else if (e.kind === 'delta') who = 'DELTA';
          else if (e.kind === 'event') who = 'SIM EVENT';
          else if (e.kind === 'reach_out') who = 'REACH OUT';
          return (
            <div key={e.seq} className={`ev kind-${e.kind} ${cls}`}>
              <div className="ts">D{e.day} · {slotHour(e.slot)}</div>
              <div className="body">
                <div className="who">{who}</div>
                <div className="text">{e.kind === 'utterance' ? `"${e.text}"` : e.text}</div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function SettingsPanel({ open, onClose, runRes }: { open: boolean; onClose: () => void; runRes: RunResponse | null }) {
  if (!open || !runRes) return null;
  const input = runRes.state?.input;
  const scenario = input?.scenario;
  const actors = runRes.actors ?? [];
  const locations = runRes.locations ?? [];
  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-panel" onClick={e => e.stopPropagation()}>
        <div className="settings-header">
          <h2>Run Settings</h2>
          <button className="settings-close" onClick={onClose}>✕</button>
        </div>
        <div className="settings-body">
          <div className="settings-section">
            <h3>Run</h3>
            <div className="settings-field"><span className="sf-label">ID</span><span className="sf-value">{runRes.id}</span></div>
            <div className="settings-field"><span className="sf-label">Model</span><span className="sf-value">{input?.model_id ?? '?'}</span></div>
            <div className="settings-field"><span className="sf-label">Speed</span><span className="sf-value">{input?.model_speed ?? '?'}</span></div>
            <div className="settings-field"><span className="sf-label">Period</span><span className="sf-value">{input?.period_days ?? '?'} days</span></div>
            <div className="settings-field"><span className="sf-label">Scenes/day</span><span className="sf-value">{input?.scenes_per_day ?? '?'}</span></div>
          </div>
          {scenario?.description && (
            <div className="settings-section">
              <h3>World Context</h3>
              <p className="settings-text">{scenario.description}</p>
            </div>
          )}
          <div className="settings-section">
            <h3>Actors ({actors.length})</h3>
            {actors.map(a => (
              <div key={a.id} className="settings-actor">
                <div className="sa-name">{a.display_name} <span className="sa-role">{a.role}</span></div>
                <div className="sa-detail">{a.mbti} · {a.age} · {a.gender}</div>
                <div className="sa-profile">{a.profile}</div>
              </div>
            ))}
          </div>
          <div className="settings-section">
            <h3>Locations ({locations.length})</h3>
            {locations.map(l => (
              <div key={l.id} className="settings-loc">
                <span className="sl-name">{l.display_name}</span>
                <span className="sl-kind">{l.kind}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function Timeline({ tick, setTick, totalTicks, events, maxReachedTick }: {
  tick: number; setTick: (t: number) => void; totalTicks: number; events: UIEvent[];
  maxReachedTick: number;
}) {
  const total = totalTicks;
  const reachable = Math.min(total - 1, maxReachedTick);
  const maxDays = Math.ceil(total / 4);
  const isInitial = tick < 0;
  const displayTick = Math.max(0, tick);
  const day = Math.floor(displayTick / 4) + 1;
  const slot = (['morning', 'noon', 'evening', 'night'] as const)[displayTick % 4];
  const clamp = (t: number) => Math.max(-1, Math.min(reachable, t));

  const VISIBLE_DAYS = Math.min(maxDays, 7);
  const visibleTicks = VISIBLE_DAYS * 4;
  const windowStart = Math.max(0, Math.min(displayTick - Math.floor(visibleTicks / 2), total - visibleTicks));
  const windowEnd = Math.min(total, windowStart + visibleTicks);
  const localPct = isInitial ? 0 : (displayTick - windowStart + 0.5) / (windowEnd - windowStart) * 100;

  const dayMarks: { d: number; pct: number }[] = [];
  for (let d = Math.floor(windowStart / 4); d <= Math.ceil(windowEnd / 4); d++) {
    const t = d * 4;
    if (t < windowStart || t > windowEnd) continue;
    dayMarks.push({ d, pct: (t - windowStart) / (windowEnd - windowStart) * 100 });
  }

  const evMarks = events
    .filter(e => e.t >= windowStart && e.t < windowEnd)
    .map(e => ({
      t: e.t, pct: (e.t - windowStart + 0.5) / (windowEnd - windowStart) * 100,
      color: e.kind === 'event' ? 'var(--c-event)' : e.kind === 'delta' ? 'var(--c-delta)' : e.kind === 'utterance' ? 'var(--c-utterance)' : e.kind === 'internal' ? 'var(--c-internal)' : 'var(--c-move)',
    }));

  return (
    <div className="timeline">
      <div className="tl-top">
        <h3>TIMELINE</h3>
        <div className="tl-clock">
          <div className="day">{isInitial ? 'INITIAL' : `DAY ${day}`}<span>/ {isInitial ? 'before sim' : weekdayOf(day)} · {maxDays}d total</span></div>
          <div className="slot">{isInitial ? '' : slotLabel(slot)}</div><div className="hour">{isInitial ? '' : slotHour(slot)}</div>
        </div>
        <div className="tl-progress">{day}/{maxDays}</div>
        <div className="tl-ctrl">
          <button className="tl-btn" onClick={() => setTick(clamp(tick - 4))} title="Previous day">⏮</button>
          <button className="tl-btn" onClick={() => setTick(clamp(tick - 1))} title="Previous slot">◀</button>
          <button className="tl-btn" onClick={() => setTick(clamp(tick + 1))} title="Next slot">▶</button>
          <button className="tl-btn" onClick={() => setTick(clamp(tick + 4))} title="Next day">⏭</button>
        </div>
      </div>
      <div className="scrub">
        {dayMarks.map(m => (<span key={'d' + m.d}><div className="day-mark" style={{ left: m.pct + '%' }} /><div className="day-label" style={{ left: m.pct + '%' }}>D{m.d + 1}</div></span>))}
        <div className="lane"><div className="filled" style={{ width: Math.max(0, localPct) + '%' }} /></div>
        {evMarks.map((m, i) => <div key={'e' + i} className="ev-mark" style={{ left: m.pct + '%', background: m.color }} />)}
        <div className="playhead" style={{ left: localPct + '%' }} />
        <input type="range" min={-1} max={reachable} step={1} value={tick} onChange={e => setTick(Number(e.target.value))} />
      </div>
    </div>
  );
}

// ── Replay Engine ─────────────────────────────────────────────────────────

function extractRelationships(res: RunResponse | null, focusId: string): RelData[] {
  if (!res?.relationships) return [];
  return res.relationships
    .filter((r: any) => r.from === focusId || r.to === focusId)
    .map((r: any) => ({
      actor_id: r.from === focusId ? r.to : r.from,
      closeness: r.closeness ?? 50,
      trust: r.trust ?? 50,
      tension: r.tension ?? 20,
    }));
}

function replayToTick(
  tick: number,
  allRaw: any[],
  actors: BackendActor[],
  locations: any[],
  focusId: string,
  runRes: RunResponse | null,
): { locs: Record<string, string>; states: Record<string, LifeState>; rels: RelData[] } {
  const initialState = runRes?.state;
  const locs: Record<string, string> = {};
  const states: Record<string, LifeState> = {};

  actors.forEach(a => {
    const loc = locations.find((l: any) => l.resident_actor_ids?.includes(a.id));
    locs[a.id] = initialState?.actor_locations?.[a.id] ?? loc?.id ?? locations[0]?.id ?? '';

    const fromState = initialState?.actor_states?.[a.id];
    states[a.id] = {
      money: fromState?.money ?? a.initial_state?.money ?? 0,
      energy: fromState?.energy ?? a.initial_state?.energy ?? 50,
      stress: fromState?.stress ?? a.initial_state?.stress ?? 50,
      health: fromState?.health ?? a.initial_state?.health ?? 50,
      mood: fromState?.mood ?? a.initial_state?.mood ?? 50,
      job_satisfaction: fromState?.job_satisfaction ?? a.initial_state?.job_satisfaction ?? 50,
    };
  });

  const relAccum = new Map<string, RelData>();
  const initRels = extractRelationships(runRes, focusId);
  initRels.forEach(r => relAccum.set(r.actor_id, { ...r }));

  for (const raw of allRaw) {
    if (rawTick(raw) > tick) break;
    if (raw.type === 'move') locs[raw.actor_id ?? focusId] = raw.to_location_id;
    if (raw.type === 'scene.start' && raw.actor_ids)
      raw.actor_ids.forEach((id: string) => { locs[id] = raw.location_id; });
    if (raw.type === 'state.update' && raw.state_summary) {
      const actorId = raw.actor_id ?? focusId;
      states[actorId] = { ...states[actorId], ...raw.state_summary };
    }
    if (raw.type === 'state.update' && raw.effect?.interaction_evaluations) {
      for (const ev of raw.effect.interaction_evaluations) {
        if (!ev.relationship_deltas) continue;
        for (const d of ev.relationship_deltas) {
          const otherId = d.from_actor_id === focusId ? d.to_actor_id : d.from_actor_id;
          if (otherId === focusId) continue;
          const cur = relAccum.get(otherId) ?? { actor_id: otherId, closeness: 50, trust: 50, tension: 20 };
          cur.closeness = Math.max(0, Math.min(100, cur.closeness + (d.closeness ?? 0)));
          cur.trust = Math.max(0, Math.min(100, cur.trust + (d.trust ?? 0)));
          cur.tension = Math.max(0, Math.min(100, cur.tension + (d.tension ?? 0)));
          relAccum.set(otherId, cur);
        }
      }
    }
  }

  return { locs, states, rels: Array.from(relAccum.values()) };
}

// ── Main App ──────────────────────────────────────────────────────────────

export default function App() {
  const [phase, setPhase] = useState<Phase>('setup');
  const [runRes, setRunRes] = useState<RunResponse | null>(null);
  const [events, setEvents] = useState<UIEvent[]>([]);
  const [allRaw, setAllRaw] = useState<any[]>([]);
  const [tick, setTick] = useState(-1);
  const [simFocusId, setSimFocusId] = useState('');
  const [viewFocusId, setViewFocusId] = useState('');
  const [sceneData, setSceneData] = useState<SceneData | null>(null);
  const [error, setError] = useState('');
  const [autoFollow, setAutoFollow] = useState(true);
  const [thinking, setThinking] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [canceling, setCanceling] = useState(false);
  const thinkTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const sceneRef = useRef<YumeScene | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const mountRef = useRef<HTMLDivElement>(null);

  const markEventReceived = useCallback(() => {
    setThinking(false);
    if (thinkTimerRef.current) clearTimeout(thinkTimerRef.current);
    thinkTimerRef.current = setTimeout(() => setThinking(true), 3000);
  }, []);

  const actors = runRes?.actors ?? [];
  const locations = runRes?.locations ?? [];

  const replay = useMemo(
    () => replayToTick(tick, allRaw, actors, locations, simFocusId, runRes),
    [tick, allRaw, actors, locations, simFocusId, runRes],
  );

  const openRun = useCallback((res: RunResponse) => {
    esRef.current?.close();
    setRunRes(res);
    const fid = res.state?.focus_actor_id ?? res.state?.protagonist_id ?? res.actors[0]?.id ?? '';
    setSimFocusId(fid);
    setViewFocusId(fid);
    setSceneData(api.responseToSceneData(res));
    const initialRaw = (Array.isArray(res.state?.events) ? res.state.events : []) as any[];
    const initialEvents = initialRaw
      .map(raw => api.mapEvent(raw))
      .filter((mapped): mapped is UIEvent => !!mapped && DISPLAY_KINDS.has(mapped.kind));
    setEvents(initialEvents);
    setAllRaw(initialRaw);
    setTick(initialEvents.length ? initialEvents[initialEvents.length - 1]!.t : -1);
    setAutoFollow(true);
    setCanceling(false);
    setThinking(res.status === 'running' || res.status === 'pending');
    setPhase(phaseFromStatus(res.status));
    try { localStorage.setItem('yume:lastRunId', res.id); } catch { /* ignore unavailable storage */ }

    if (res.status !== 'running' && res.status !== 'pending') return;

    const es = api.subscribe(res.id, (mapped, raw) => {
      markEventReceived();
      setAllRaw(prev => prev.some(ev => ev.seq === raw.seq) ? prev : [...prev, raw]);
      if (mapped && DISPLAY_KINDS.has(mapped.kind)) {
        setEvents(prev => prev.some(ev => ev.seq === mapped.seq) ? prev : [...prev, mapped]);
        setAutoFollow(af => { if (af) setTick(mapped!.t); return af; });
      }
      if (raw.type === 'run.complete') {
        setPhase('completed');
        setThinking(false);
        if (thinkTimerRef.current) clearTimeout(thinkTimerRef.current);
      }
      if (raw.type === 'run.failed') {
        setPhase('failed');
        setError(raw.message);
        setThinking(false);
        if (thinkTimerRef.current) clearTimeout(thinkTimerRef.current);
      }
      if (raw.type === 'run.cancelled') {
        setPhase('cancelled');
        setCanceling(false);
        setThinking(false);
        if (thinkTimerRef.current) clearTimeout(thinkTimerRef.current);
      }
    }, undefined, () => {});
    esRef.current = es;
  }, [markEventReceived]);

  const handleStart = useCallback(async (config: RunConfig) => {
    setPhase('connecting');
    setError('');
    setCanceling(false);
    try {
      const res = await api.startRun(config);
      openRun(res);
    } catch (e: any) { setError(e.message); setPhase('failed'); }
  }, [openRun]);

  const handleResume = useCallback(async (runId: string) => {
    setError('');
    const res = await api.getRun(runId);
    openRun(res);
  }, [openRun]);

  useEffect(() => {
    if (!mountRef.current || !sceneData || phase === 'setup' || phase === 'connecting') return;
    const scene = new YumeScene();
    scene.init(mountRef.current, sceneData, { mode: 'research', camera: 'isometric', actorStyle: 'pillar', onActorClick: handleActorPick });
    sceneRef.current = scene;
    return () => { scene.dispose(); sceneRef.current = null; };
  }, [sceneData, phase]);

  const lastLocRef = useRef<Record<string, string>>({});
  useEffect(() => {
    if (!sceneRef.current) return;
    for (const id in replay.locs) {
      if (lastLocRef.current[id] !== replay.locs[id]) {
        sceneRef.current.setActorLocation(id, replay.locs[id]);
        lastLocRef.current[id] = replay.locs[id];
      }
    }
  }, [replay.locs]);

  const userClickedRef = useRef(false);
  const handleActorPick = useCallback((id: string) => { userClickedRef.current = true; setViewFocusId(id); }, []);
  useEffect(() => {
    if (!sceneRef.current || !viewFocusId || !userClickedRef.current) return;
    sceneRef.current.focusOn(viewFocusId);
    userClickedRef.current = false;
  }, [viewFocusId]);
  useEffect(() => () => { esRef.current?.close(); }, []);

  const handleScrub = useCallback((t: number) => { setAutoFollow(false); setTick(t); }, []);
  const handleFollow = useCallback(() => {
    setAutoFollow(true);
    if (events.length > 0) setTick(events[events.length - 1].t);
  }, [events]);
  const handleCancel = useCallback(async () => {
    if (!runRes?.id || phase !== 'running' || canceling) return;
    setCanceling(true);
    setThinking(false);
    if (thinkTimerRef.current) clearTimeout(thinkTimerRef.current);
    try {
      const res = await api.cancelRun(runRes.id);
      if (res.cancelled) {
        setPhase('cancelled');
        setCanceling(false);
        setThinking(false);
      }
    } catch (e: any) {
      setCanceling(false);
      setError(e.message);
    }
  }, [runRes?.id, phase, canceling]);
  const handleViewPreset = useCallback((preset: 'isometric' | 'topdown' | 'cinematic') => {
    sceneRef.current?.setCameraPreset(preset);
  }, []);
  const handleFrameAll = useCallback(() => {
    sceneRef.current?.frameAll('isometric');
  }, []);
  const handleBackToRuns = () => {
    esRef.current?.close();
    setPhase('setup'); setRunRes(null); setSceneData(null);
    setEvents([]); setAllRaw([]);
    setCanceling(false);
  };

  if (phase === 'setup') return <StartForm onStart={handleStart} onResume={handleResume} />;
  if (phase === 'connecting') return <div className="setup-screen"><div className="setup-card"><h1>YUME</h1><p className="sub">Starting simulation...</p></div></div>;

  const focusActor = actors.find(a => a.id === viewFocusId);
  const focusState = replay.states[viewFocusId] ?? { money: 0, energy: 50, stress: 50, health: 50, mood: 50, job_satisfaction: 50 };
  const focusLocName = locations.find(l => l.id === replay.locs[viewFocusId])?.display_name ?? replay.locs[viewFocusId] ?? '';
  const totalTicks = (runRes?.state?.input?.period_days ?? 3) * 4;
  const displayTick = Math.max(0, tick);
  const isInitial = tick < 0;
  const day = Math.floor(displayTick / 4) + 1;
  const slot = (['morning', 'noon', 'evening', 'night'] as const)[displayTick % 4] ?? 'morning';
  const statusLabel = phase === 'running' ? 'RUNNING' : phase === 'completed' ? 'COMPLETED' : phase === 'cancelled' ? 'CANCELLED' : 'FAILED';

  return (
    <>
      <div id="stage"><div id="mount" ref={mountRef} /></div>
      <div className="topbar">
        <div className="chip"><span className="k">run</span><span className="v">{runRes?.id}</span></div>
        <div className="chip"><span className="k">clock</span><span className="v">{isInitial ? 'INITIAL' : `D${day} / ${slotLabel(slot)} · ${slotHour(slot)}`}</span></div>
        {thinking && phase === 'running' && <div className="chip thinking-chip"><span className="thinking-dot" />AI processing</div>}
        <div className="spacer" />
        <div className="chip view-chip">
          <span className="k">View</span>
          <button type="button" className="view-btn" title="Zoom out" onClick={() => sceneRef.current?.zoomBy(1.25)}>−</button>
          <button type="button" className="view-btn" title="Zoom in" onClick={() => sceneRef.current?.zoomBy(0.8)}>+</button>
          <button type="button" className="view-btn text" title="Isometric view" onClick={() => handleViewPreset('isometric')}>ISO</button>
          <button type="button" className="view-btn text" title="Top-down view" onClick={() => handleViewPreset('topdown')}>TOP</button>
          <button type="button" className="view-btn text" title="Low angle view" onClick={() => handleViewPreset('cinematic')}>LOW</button>
          <button type="button" className="view-btn text" title="Frame all buildings" onClick={handleFrameAll}>ALL</button>
        </div>
        {!autoFollow && phase === 'running' && (
          <div className="chip" style={{ cursor: 'pointer' }} onClick={handleFollow}>
            <span className="k">▶</span><span className="v">FOLLOW</span>
          </div>
        )}
        {phase === 'running' && (
          <div className="chip danger-chip" style={{ cursor: canceling ? 'not-allowed' : 'pointer', opacity: canceling ? 0.62 : 1 }} onClick={handleCancel}>
            <span className="k">■</span><span className="v">{canceling ? 'STOPPING' : 'STOP API'}</span>
          </div>
        )}
        <div className="chip" style={{ cursor: 'pointer' }} onClick={() => setSettingsOpen(true)}>
          <span className="k">⚙</span><span className="v">Settings</span>
        </div>
        <div className="chip">
          <span className="k">Status</span>
          <span className="v">{statusLabel}</span>
        </div>
        <div className="chip" style={{ cursor: 'pointer' }} onClick={handleBackToRuns}>
          <span className="k">↩</span><span className="v">Runs</span>
        </div>
      </div>
      <SettingsPanel open={settingsOpen} onClose={() => setSettingsOpen(false)} runRes={runRes} />

      <div className="rail">
        {focusActor && <FocusCard actor={focusActor} state={focusState} locationName={focusLocName} />}
        <Relationships focusId={viewFocusId} focusName={focusActor?.display_name ?? ''} actors={actors} relationships={replay.rels} />
      </div>

      <div className="rail-r">
        <ActorList actors={actors} focusId={viewFocusId} onPick={handleActorPick} states={replay.states} />
        <EventLog events={events} tick={tick} actors={actors} />
      </div>

      <Timeline tick={tick} setTick={handleScrub} totalTicks={totalTicks} events={events}
                maxReachedTick={events.length > 0 ? events[events.length - 1].t : 0} />
      {error && <div className="corner-mark" style={{ color: 'oklch(0.66 0.16 25)' }}>{error}</div>}
    </>
  );
}
