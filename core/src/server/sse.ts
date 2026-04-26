import { corsHeaders } from "./http-utils";
import type { EventListener, RunHandle } from "./runs-store";

const KEEPALIVE_INTERVAL_MS = 15_000;

/**
 * Produces the SSE Response for `GET /runs/:id/events`.
 *
 * Design notes:
 *   - Honours `Last-Event-ID` for auto-reconnect. We replay only events
 *     strictly newer than the client already has, otherwise every idle
 *     reconnect would duplicate the entire buffer (seq=1 again, etc.).
 *   - Keepalive comments every 15 s prevent proxy drops during pacing
 *     sleeps (LLM calls can be silent for 10-30 s at a time).
 *   - Closes the stream after `run.complete`, which matches the client's
 *     own `EventSource.close()` on that event.
 */
export function sseResponse(req: Request, handle: RunHandle): Response {
  const encoder = new TextEncoder();
  let closed = false;
  let keepaliveTimer: ReturnType<typeof setInterval> | null = null;

  const lastIdHeader = req.headers.get("Last-Event-ID");
  const resumeFromSeq = lastIdHeader ? Number(lastIdHeader) : 0;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const push = (line: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(line));
        } catch {
          closed = true;
        }
      };

      // retry hint for EventSource
      push(`retry: 3000\n\n`);

      // replay buffered events only newer than what the client already has.
      for (const ev of handle.events) {
        if (ev.seq <= resumeFromSeq) continue;
        push(`id: ${ev.seq}\n`);
        push(`data: ${JSON.stringify(ev)}\n\n`);
      }

      // if terminal and no more events coming, close
      if (handle.status === "completed" || handle.status === "failed" || handle.status === "cancelled") {
        try {
          controller.close();
        } catch {
          /* ignore */
        }
        closed = true;
        return;
      }

      // subscribe to live events
      const listener: EventListener = (ev) => {
        push(`id: ${ev.seq}\n`);
        push(`data: ${JSON.stringify(ev)}\n\n`);
        if (ev.type === "run.complete" || ev.type === "run.failed" || ev.type === "run.cancelled") {
          try {
            controller.close();
          } catch {
            /* ignore */
          }
          closed = true;
          handle.listeners.delete(listener);
          if (keepaliveTimer) clearInterval(keepaliveTimer);
        }
      };
      handle.listeners.add(listener);

      keepaliveTimer = setInterval(() => {
        push(`: keepalive\n\n`);
      }, KEEPALIVE_INTERVAL_MS);
    },
    cancel() {
      closed = true;
      if (keepaliveTimer) clearInterval(keepaliveTimer);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      ...corsHeaders(req),
    },
  });
}
