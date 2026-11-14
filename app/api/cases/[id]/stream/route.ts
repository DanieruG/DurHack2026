import { corsFor } from "@/lib/cors";
import { CASE_ID_RE, errorJson, options } from "@/lib/http";
import { getDeps } from "@/pipeline/deps";
import { isAfter, serializeSse, type SseEvent } from "@/pipeline/events";
import { synthesizeEvents } from "@/pipeline/views";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const OPTIONS = options;

export const KEEP_ALIVE_MS = 15_000;

/**
 * GET /api/cases/:id/stream (SSE). Late subscribers get the buffered events for the current revision;
 * the connection stays open so reopen progress arrives on the same stream. Supports Last-Event-ID.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const deps = await getDeps();
  const cors = corsFor(req.headers.get("origin"), deps.config.allowedOrigins);
  if (!cors.allowed) return errorJson(403, "Origin not allowed");
  const { id } = await params;
  if (!CASE_ID_RE.test(id)) return errorJson(404, "Case not found");
  const c = await deps.store.getCase(id);
  if (!c) return errorJson(404, "Case not found");

  const lastEventId = req.headers.get("last-event-id") ?? new URL(req.url).searchParams.get("lastEventId");
  const replay = deps.hub.has(id) ? null : await synthesizeEvents(deps, c);
  const encoder = new TextEncoder();
  let cleanup = () => {};

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const write = (s: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(s));
        } catch {
          closed = true;
        }
      };
      const send = (e: SseEvent) => {
        if (isAfter(e.id, lastEventId)) write(serializeSse(e));
      };
      write("retry: 3000\n\n");
      const sub = deps.hub.subscribe(id, send);
      for (const e of replay ?? sub.buffered) send(e);
      const timer = setInterval(() => write(": keep-alive\n\n"), KEEP_ALIVE_MS);
      cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(timer);
        sub.unsubscribe();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      req.signal.addEventListener("abort", () => cleanup());
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
      ...cors.headers,
    },
  });
}
