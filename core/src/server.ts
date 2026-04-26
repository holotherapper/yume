/**
 * Thin HTTP layer.
 *   GET  /runs               -> list in-process runs for browser refresh recovery
 *   POST /runs               -> start a run and return its ID
 *   GET  /runs/:id           -> return status, event count, and state
 *   POST /runs/:id/cancel    -> abort an in-flight run
 *   GET  /runs/:id/events    -> stream buffered and live events over SSE
 *   GET  /health             -> health check
 *
 * Internal modules:
 *   server/runs-store.ts    -> run registry and background orchestrator
 *   server/sse.ts           -> SSE stream factory
 *   server/http-utils.ts    -> CORS and request logging
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { RunInput as RunInputSchema } from "./schema";
import type { SimState } from "./schema";
import { corsHeaders, logReq } from "./server/http-utils";
import { assessRunRisk } from "./server/run-risk";
import { cancelRun, createAndStartRun, getPersistedRunResponse, getRun, listRuns } from "./server/runs-store";
import { sseResponse } from "./server/sse";

loadEnvFile(".env");
loadEnvFile(".env.local");

const host = process.env.HOST ?? "127.0.0.1";
const maxRequestBytes = Number(process.env.YUME_MAX_REQUEST_BYTES ?? 1_000_000);

const server = Bun.serve({
  hostname: host,
  port: Number(process.env.PORT ?? 3001),
  idleTimeout: 255,

  routes: {
    "/health": (req) => {
      logReq(req);
      return new Response("ok", { headers: corsHeaders(req) });
    },

    "/runs": {
      OPTIONS: (req) => {
        logReq(req, "CORS preflight");
        return new Response(null, { headers: corsHeaders(req) });
      },
      GET: (req) => {
        logReq(req, "list");
        return Response.json({ runs: listRuns() }, { headers: corsHeaders(req) });
      },
      POST: async (req) => {
        logReq(req);
        let body: unknown;
        try {
          body = await parseJsonBody(req);
        } catch (error) {
          const message = error instanceof Error ? error.message : "invalid JSON";
          const status = message === "request body too large" ? 413 : 400;
          return new Response(message, {
            status,
            headers: corsHeaders(req),
          });
        }
        const parsed = RunInputSchema.safeParse(body);
        if (!parsed.success) {
          return Response.json(
            { error: "invalid input", issues: parsed.error.issues },
            { status: 400, headers: corsHeaders(req) },
          );
        }
        const risk = assessRunRisk(parsed.data);
        if (risk.requiresAcknowledgement && !parsed.data.config?.cost_risk_acknowledged) {
          return Response.json(
            {
              error: "cost risk acknowledgement required",
              risk,
            },
            { status: 409, headers: corsHeaders(req) },
          );
        }
        const { handle, ready } = createAndStartRun(parsed.data);
        // Wait for setup (actors/locations resolved) so client gets rich info immediately
        await ready;
        if (handle.status === "failed") {
          return Response.json(
            { error: handle.error ?? "run setup failed" },
            { status: 500, headers: corsHeaders(req) },
          );
        }
        return Response.json(
          {
            id: handle.id,
            status: handle.status,
            events_count: handle.events.length,
            actors: handle.actors,
            locations: handle.locations,
            world: handle.input.world ?? { locations: handle.locations },
            relationships: extractRelationships(handle.state),
            state: handle.state,
          },
          { headers: corsHeaders(req) },
        );
      },
    },

    "/runs/:id": (req) => {
      logReq(req);
      const handle = getRun(req.params.id);
      if (!handle) {
        const persisted = getPersistedRunResponse(req.params.id);
        if (persisted) return Response.json(persisted, { headers: corsHeaders(req) });
        return new Response("not found", {
          status: 404,
          headers: corsHeaders(req),
        });
      }
      return Response.json(
        {
          id: handle.id,
          status: handle.status,
          events_count: handle.events.length,
          actors: handle.actors,
          locations: handle.locations,
          world: handle.input.world ?? { locations: handle.locations },
          relationships: extractRelationships(handle.state),
          state: handle.state ? { ...handle.state, events: handle.events } : handle.state,
          error: handle.error,
        },
        { headers: corsHeaders(req) },
      );
    },

    "/runs/:id/cancel": {
      OPTIONS: (req) => {
        logReq(req, "CORS preflight");
        return new Response(null, { headers: corsHeaders(req) });
      },
      POST: (req) => {
        logReq(req, "cancel");
        const { handle, changed } = cancelRun(req.params.id);
        if (!handle)
          return new Response("not found", {
            status: 404,
            headers: corsHeaders(req),
          });
        return Response.json(
          {
            id: handle.id,
            status: handle.status,
            cancelled: handle.status === "cancelled",
            changed,
            events_count: handle.events.length,
            error: handle.error,
          },
          { headers: corsHeaders(req) },
        );
      },
    },

    "/runs/:id/events": (req) => {
      logReq(req, "SSE subscribe");
      const handle = getRun(req.params.id);
      if (!handle)
        return new Response("not found", {
          status: 404,
          headers: corsHeaders(req),
        });
      return sseResponse(req, handle);
    },
  },

  fetch(req) {
    logReq(req, "unmatched route");
    return new Response("not found", { status: 404, headers: corsHeaders(req) });
  },
});

console.log(`YUME core server listening on http://${host}:${server.port}`);
console.log(`  GET    /runs`);
console.log(`  POST   /runs`);
console.log(`  GET    /runs/:id`);
console.log(`  POST   /runs/:id/cancel`);
console.log(`  GET    /runs/:id/events   (SSE)`);
console.log(`  GET    /health`);

async function parseJsonBody(req: Request): Promise<unknown> {
  const contentLength = Number(req.headers.get("Content-Length") ?? 0);
  if (contentLength > maxRequestBytes) throw new Error("request body too large");
  const text = await req.text();
  if (text.length > maxRequestBytes) throw new Error("request body too large");
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("invalid JSON");
  }
}

function loadEnvFile(fileName: string): void {
  const path = join(import.meta.dirname, "..", fileName);
  if (!existsSync(path)) return;
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index <= 0) continue;
    const key = trimmed.slice(0, index).trim();
    const raw = trimmed.slice(index + 1).trim();
    if (process.env[key] !== undefined) continue;
    process.env[key] = raw.replace(/^['"]|['"]$/g, "");
  }
}

function extractRelationships(state: SimState | null) {
  const actorStates = state?.actor_states;
  if (!actorStates) return [];
  return Object.entries(actorStates).flatMap(([from, lifeState]) =>
    lifeState.relationships.map((relationship) => ({
      from,
      to: relationship.actor_id,
      closeness: relationship.closeness,
      trust: relationship.trust,
      tension: relationship.tension,
      last_interaction_day: relationship.last_interaction_day,
    })),
  );
}
