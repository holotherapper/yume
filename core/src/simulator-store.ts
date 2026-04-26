import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import type { Event, RunInput } from "./schema";
import type { LifeState } from "./simulation-engine";

export type TurnPhase = "collect" | "committed" | "failed";

export type BeginTurnArgs = {
  runId: string;
  turnId: string;
  turnIndex: number;
  day: number;
  slot: string;
  simHour: number;
  worldSnapshot: unknown;
};

export type CommitTurnArgs = BeginTurnArgs & {
  stateBefore: LifeState;
  stateAfter: LifeState;
  actorStatesAfter?: Record<string, LifeState>;
  worldSnapshotAfter?: unknown;
  summary: string;
};

export type PersistedRunRow = {
  id: string;
  status: string;
  input_json: string;
  final_state_json: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  events_count: number;
};

export class SimulatorStore {
  readonly db: Database;

  constructor(path = defaultDbPath()) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA foreign_keys = ON");
    this.init();
  }

  close(): void {
    this.db.close();
  }

  createRun(runId: string, input: RunInput): void {
    this.db
      .query(
        `insert into runs (id, status, input_json, created_at, updated_at)
         values (?, 'running', ?, datetime('now'), datetime('now'))
         on conflict(id) do update set
           status = excluded.status,
           input_json = excluded.input_json,
           updated_at = datetime('now')`,
      )
      .run(runId, JSON.stringify(input));
    if (input.decision_context) {
      this.recordDecisionContext({
        runId,
        context: input.decision_context,
        pressure: 0,
        updatedTurnId: null,
      });
    }
  }

  recordDecisionContext(args: {
    runId: string;
    context: unknown;
    pressure: number;
    updatedTurnId: string | null;
  }): void {
    this.db
      .query(
        `insert into decision_contexts
          (run_id, context_json, pressure, updated_turn_id, updated_at)
         values (?, ?, ?, ?, datetime('now'))
         on conflict(run_id) do update set
           context_json = excluded.context_json,
           pressure = excluded.pressure,
           updated_turn_id = excluded.updated_turn_id,
           updated_at = datetime('now')`,
      )
      .run(args.runId, JSON.stringify(args.context), args.pressure, args.updatedTurnId);
  }

  completeRun(runId: string, finalState: LifeState): void {
    this.db
      .query(
        `update runs
         set status = 'completed', final_state_json = ?, updated_at = datetime('now')
         where id = ?`,
      )
      .run(JSON.stringify(finalState), runId);
  }

  failRun(runId: string, message: string): void {
    this.db
      .query(
        `update runs
         set status = 'failed', error = ?, updated_at = datetime('now')
         where id = ?`,
      )
      .run(message, runId);
  }

  cancelRun(runId: string, message = "Run cancelled by user", event?: Event): void {
    this.db.transaction(() => {
      this.db
        .query(
          `update runs
           set status = 'cancelled', error = ?, updated_at = datetime('now')
           where id = ?`,
        )
        .run(message, runId);
      if (event) this.insertEventIfMissing(runId, event);
    })();
  }

  recordAgentSession(args: {
    runId: string;
    actorId: string;
    agentId: string;
    sessionId: string;
    memoryStoreId?: string;
    worldMemoryStoreId?: string;
    runContextMemoryStoreId?: string;
    relationshipMemoryStoreId?: string;
  }): void {
    this.db
      .query(
        `insert into agent_sessions
          (run_id, actor_id, agent_id, session_id, memory_store_id, world_memory_store_id, run_context_memory_store_id, relationship_memory_store_id, created_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
         on conflict(run_id, actor_id) do update set
           agent_id = excluded.agent_id,
           session_id = excluded.session_id,
           memory_store_id = excluded.memory_store_id,
           world_memory_store_id = excluded.world_memory_store_id,
           run_context_memory_store_id = excluded.run_context_memory_store_id,
           relationship_memory_store_id = excluded.relationship_memory_store_id`,
      )
      .run(
        args.runId,
        args.actorId,
        args.agentId,
        args.sessionId,
        args.memoryStoreId ?? null,
        args.worldMemoryStoreId ?? null,
        args.runContextMemoryStoreId ?? null,
        args.relationshipMemoryStoreId ?? null,
      );
  }

  beginTurn(args: BeginTurnArgs): void {
    this.db.transaction(() => {
      this.db
        .query(
          `insert into turns
            (run_id, turn_id, turn_index, day, slot, sim_hour, phase, world_snapshot_json, created_at, updated_at)
           values (?, ?, ?, ?, ?, ?, 'collect', ?, datetime('now'), datetime('now'))`,
        )
        .run(
          args.runId,
          args.turnId,
          args.turnIndex,
          args.day,
          args.slot,
          args.simHour,
          JSON.stringify(args.worldSnapshot),
        );
      this.insertSnapshot(args.runId, args.turnId, "before", args.worldSnapshot);
    })();
  }

  recordPendingChange(args: {
    runId: string;
    turnId: string;
    source: string;
    kind: string;
    payload: unknown;
  }): void {
    this.db
      .query(
        `insert into pending_changes
          (run_id, turn_id, source, kind, payload_json, status, created_at)
         values (?, ?, ?, ?, ?, 'pending', datetime('now'))`,
      )
      .run(args.runId, args.turnId, args.source, args.kind, JSON.stringify(args.payload));
  }

  recordActionLog(args: {
    runId: string;
    turnId: string;
    candidates: unknown;
    selected?: unknown;
    invalidReason?: string;
  }): void {
    this.db
      .query(
        `insert into action_logs
          (run_id, turn_id, candidates_json, selected_json, invalid_reason, created_at)
         values (?, ?, ?, ?, ?, datetime('now'))`,
      )
      .run(
        args.runId,
        args.turnId,
        JSON.stringify(args.candidates),
        args.selected === undefined ? null : JSON.stringify(args.selected),
        args.invalidReason ?? null,
      );
  }

  commitTurn(args: CommitTurnArgs): void {
    this.db.transaction(() => {
      this.db
        .query(
          `update turns
           set phase = 'committed',
               state_before_json = ?,
               state_after_json = ?,
               summary = ?,
               updated_at = datetime('now')
           where run_id = ? and turn_id = ? and phase = 'collect'`,
        )
        .run(
          JSON.stringify(args.stateBefore),
          JSON.stringify(args.stateAfter),
          args.summary,
          args.runId,
          args.turnId,
        );
      this.db
        .query(
          `update pending_changes
           set status = 'committed'
           where run_id = ? and turn_id = ? and status = 'pending'`,
        )
        .run(args.runId, args.turnId);
      this.insertSnapshot(args.runId, args.turnId, "after", args.worldSnapshotAfter ?? args.stateAfter);
      this.upsertRelationships(args.runId, args.turnId, args.actorStatesAfter ?? { focus_actor: args.stateAfter });
    })();
  }

  failTurn(runId: string, turnId: string, message: string): void {
    this.db.transaction(() => {
      this.db
        .query(
          `update turns
           set phase = 'failed', summary = ?, updated_at = datetime('now')
           where run_id = ? and turn_id = ?`,
        )
        .run(message, runId, turnId);
      this.db
        .query(
          `update pending_changes
           set status = 'discarded'
           where run_id = ? and turn_id = ? and status = 'pending'`,
        )
        .run(runId, turnId);
    })();
  }

  insertEvent(runId: string, event: Event): void {
    this.db
      .query(
        `insert into events
          (run_id, seq, day, slot, sim_hour, type, payload_json, created_at)
         values (?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
      )
      .run(
        runId,
        event.seq,
        event.day,
        event.slot,
        event.sim_hour,
        event.type,
        JSON.stringify(event),
      );
  }

  recordMemoryVersion(args: {
    runId: string;
    turnId: string;
    agentId: string;
    memoryStoreId: string;
    memoryPath: string;
    memoryVersionId: string;
    writeMode: "agent_written" | "orchestrator_reviewed";
    status: "committed" | "discarded";
  }): void {
    this.db
      .query(
        `insert into memory_versions
          (run_id, turn_id, agent_id, memory_store_id, memory_path, memory_version_id, write_mode, status, created_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
      )
      .run(
        args.runId,
        args.turnId,
        args.agentId,
        args.memoryStoreId,
        args.memoryPath,
        args.memoryVersionId,
        args.writeMode,
        args.status,
      );
  }

  getTurnCount(runId: string): number {
    const row = this.db
      .query(`select count(*) as n from turns where run_id = ?`)
      .get(runId) as { n: number } | null;
    return row?.n ?? 0;
  }

  getEvents(runId: string): Event[] {
    const rows = this.db
      .query(`select payload_json from events where run_id = ? order by seq asc`)
      .all(runId) as Array<{ payload_json: string }>;
    return rows.map((r) => JSON.parse(r.payload_json) as Event);
  }

  listRuns(): PersistedRunRow[] {
    return this.db
      .query(
        `select
           r.id,
           r.status,
           r.input_json,
           r.final_state_json,
           r.error,
           r.created_at,
           r.updated_at,
           count(e.id) as events_count
         from runs r
         left join events e on e.run_id = r.id
         group by r.id
         order by
           case when r.status = 'running' then 0 else 1 end,
           r.created_at desc`,
      )
      .all() as PersistedRunRow[];
  }

  getRun(runId: string): PersistedRunRow | null {
    return this.db
      .query(
        `select
           r.id,
           r.status,
           r.input_json,
           r.final_state_json,
           r.error,
           r.created_at,
           r.updated_at,
           count(e.id) as events_count
         from runs r
         left join events e on e.run_id = r.id
         where r.id = ?
         group by r.id`,
      )
      .get(runId) as PersistedRunRow | null;
  }

  private insertEventIfMissing(runId: string, event: Event): void {
    this.db
      .query(
        `insert or ignore into events
          (run_id, seq, day, slot, sim_hour, type, payload_json, created_at)
         values (?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
      )
      .run(
        runId,
        event.seq,
        event.day,
        event.slot,
        event.sim_hour,
        event.type,
        JSON.stringify(event),
      );
  }

  private insertSnapshot(
    runId: string,
    turnId: string,
    phase: "before" | "after",
    snapshot: unknown,
  ): void {
    this.db
      .query(
        `insert into world_state_snapshots
          (run_id, turn_id, phase, snapshot_json, created_at)
         values (?, ?, ?, ?, datetime('now'))`,
      )
      .run(runId, turnId, phase, JSON.stringify(snapshot));
  }

  private upsertRelationships(runId: string, turnId: string, actorStates: Record<string, LifeState>): void {
    for (const [ownerActorId, state] of Object.entries(actorStates)) {
      for (const rel of state.relationships) {
        this.db
          .query(
            `insert into relationships
              (run_id, owner_actor_id, target_actor_id, closeness, trust, tension, dependency, last_contact_days, updated_turn_id, updated_at)
             values (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
             on conflict(run_id, owner_actor_id, target_actor_id) do update set
               closeness = excluded.closeness,
               trust = excluded.trust,
               tension = excluded.tension,
               dependency = excluded.dependency,
               last_contact_days = excluded.last_contact_days,
               updated_turn_id = excluded.updated_turn_id,
               updated_at = datetime('now')`,
          )
          .run(
            runId,
            ownerActorId,
            rel.actor_id,
            rel.closeness,
            rel.trust,
            rel.tension,
            0,
            rel.last_interaction_day,
            turnId,
          );
      }
    }
  }

  private init(): void {
    this.ensureRunsTable();
    this.db.run(`
      create table if not exists turns (
        run_id text not null,
        turn_id text not null,
        turn_index integer not null,
        day integer not null,
        slot text not null,
        sim_hour real not null,
        phase text not null check (phase in ('collect', 'committed', 'failed')),
        world_snapshot_json text not null,
        state_before_json text,
        state_after_json text,
        summary text,
        created_at text not null,
        updated_at text not null,
        primary key (run_id, turn_id),
        unique (run_id, turn_index),
        foreign key (run_id) references runs(id) on delete cascade
      )
    `);
    this.db.run(`
      create table if not exists world_state_snapshots (
        id integer primary key autoincrement,
        run_id text not null,
        turn_id text not null,
        phase text not null check (phase in ('before', 'after')),
        snapshot_json text not null,
        created_at text not null,
        unique (run_id, turn_id, phase),
        foreign key (run_id, turn_id) references turns(run_id, turn_id) on delete cascade
      )
    `);
    this.db.run(`
      create table if not exists events (
        id integer primary key autoincrement,
        run_id text not null,
        seq integer not null,
        day integer not null,
        slot text not null,
        sim_hour real not null,
        type text not null,
        payload_json text not null,
        created_at text not null,
        unique (run_id, seq),
        foreign key (run_id) references runs(id) on delete cascade
      )
    `);
    this.db.run(`
      create table if not exists relationships (
        run_id text not null,
        owner_actor_id text not null,
        target_actor_id text not null,
        closeness real not null,
        trust real not null,
        tension real not null,
        dependency real not null default 0,
        last_contact_days integer not null,
        updated_turn_id text not null,
        updated_at text not null,
        primary key (run_id, owner_actor_id, target_actor_id),
        foreign key (run_id) references runs(id) on delete cascade
      )
    `);
    this.db.run(`
      create table if not exists pending_changes (
        id integer primary key autoincrement,
        run_id text not null,
        turn_id text not null,
        source text not null,
        kind text not null,
        payload_json text not null,
        status text not null check (status in ('pending', 'committed', 'discarded')),
        created_at text not null,
        foreign key (run_id, turn_id) references turns(run_id, turn_id) on delete cascade
      )
    `);
    this.db.run(`
      create table if not exists agent_sessions (
        run_id text not null,
        actor_id text not null,
        agent_id text not null,
        session_id text not null,
        memory_store_id text,
        world_memory_store_id text,
        run_context_memory_store_id text,
        relationship_memory_store_id text,
        created_at text not null,
        primary key (run_id, actor_id),
        foreign key (run_id) references runs(id) on delete cascade
      )
    `);
    this.db.run(`
      create table if not exists memory_versions (
        id integer primary key autoincrement,
        run_id text not null,
        turn_id text not null,
        agent_id text not null,
        memory_store_id text not null,
        memory_path text not null,
        memory_version_id text not null,
        write_mode text not null,
        status text not null,
        created_at text not null,
        foreign key (run_id, turn_id) references turns(run_id, turn_id) on delete cascade
      )
    `);
    this.db.run(`
      create table if not exists action_logs (
        id integer primary key autoincrement,
        run_id text not null,
        turn_id text not null,
        candidates_json text not null,
        selected_json text,
        invalid_reason text,
        created_at text not null,
        foreign key (run_id, turn_id) references turns(run_id, turn_id) on delete cascade
      )
    `);
    this.db.run(`
      create table if not exists decision_contexts (
        run_id text primary key,
        context_json text not null,
        pressure real not null default 0,
        updated_turn_id text,
        updated_at text not null,
        foreign key (run_id) references runs(id) on delete cascade
      )
    `);
  }

  private ensureRunsTable(): void {
    this.db.run(`
      create table if not exists runs (
        id text primary key,
        status text not null check (status in ('running', 'completed', 'failed', 'cancelled')),
        input_json text not null,
        final_state_json text,
        error text,
        created_at text not null,
        updated_at text not null
      )
    `);
    const row = this.db
      .query(`select sql from sqlite_master where type = 'table' and name = 'runs'`)
      .get() as { sql?: string } | null;
    if (!row?.sql || row.sql.includes("'cancelled'")) return;
    this.db.run("PRAGMA foreign_keys = OFF");
    try {
      this.db.transaction(() => {
        this.db.run(`
          create table runs_new (
            id text primary key,
            status text not null check (status in ('running', 'completed', 'failed', 'cancelled')),
            input_json text not null,
            final_state_json text,
            error text,
            created_at text not null,
            updated_at text not null
          )
        `);
        this.db.run(`
          insert into runs_new (id, status, input_json, final_state_json, error, created_at, updated_at)
          select id, status, input_json, final_state_json, error, created_at, updated_at
          from runs
        `);
        this.db.run(`drop table runs`);
        this.db.run(`alter table runs_new rename to runs`);
      })();
    } finally {
      this.db.run("PRAGMA foreign_keys = ON");
    }
    this.db.run(`
      update runs
      set status = 'cancelled'
      where status = 'failed'
        and error is not null
        and (
          lower(error) like '%cancel%'
          or lower(error) like '%abort%'
        )
    `);
  }
}

function defaultDbPath(): string {
  return process.env.YUME_SQLITE_PATH ?? join(import.meta.dirname, "..", "data", "yume.sqlite");
}
