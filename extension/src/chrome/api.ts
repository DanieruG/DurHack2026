import {
  CaseCreatedSchema,
  CaseDetailSchema,
  CaseSummariesResponseSchema,
  ErrorResponseSchema,
  ReopenAcceptedSchema,
  SseEventSchemas,
  type CaseDetail,
} from "@/schemas/api";
import type { Capture, CaseSummary, Profile } from "@/schemas/domain";
import { parseEvent, revisionOf, type IncomingEvent } from "../lib/progress";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const MAX_SCREENSHOTS = 6;

async function read<T>(res: Response, schema: { parse: (x: unknown) => T }): Promise<T> {
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const err = ErrorResponseSchema.safeParse(body);
    throw new ApiError(res.status, err.success ? err.data.error : `The server answered ${res.status}`);
  }
  return schema.parse(body);
}

async function send(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch {
    throw new ApiError(0, "Can't reach the Sleuth server. Is it running?");
  }
}

export function createApi(base: string) {
  const u = (path: string) => `${base.replace(/\/+$/, "")}${path}`;

  return {
    base,

    async createCase(args: { capture: Capture; profile: Profile; caseNote?: string; screenshots?: Blob[] }) {
      const form = new FormData();
      form.set("capture", JSON.stringify(args.capture));
      form.set("profile", JSON.stringify(args.profile));
      if (args.caseNote?.trim()) form.set("caseNote", args.caseNote.trim());
      for (const [i, s] of (args.screenshots ?? []).slice(0, MAX_SCREENSHOTS).entries()) form.append("screenshots", s, `screenshot-${i + 1}.${s.type.split("/")[1] ?? "png"}`);
      const res = await send(u("/api/cases"), { method: "POST", body: form });
      return read(res, CaseCreatedSchema);
    },

    async reopen(id: string, args: { capture?: Capture; sellerReply?: string; screenshots?: Blob[] }) {
      const form = new FormData();
      if (args.capture && Object.keys(args.capture).length) form.set("capture", JSON.stringify(args.capture));
      if (args.sellerReply?.trim()) form.set("sellerReply", args.sellerReply.trim());
      for (const [i, s] of (args.screenshots ?? []).slice(0, MAX_SCREENSHOTS).entries()) form.append("screenshots", s, s instanceof File ? s.name : `evidence-${i + 1}.png`);
      const res = await send(u(`/api/cases/${encodeURIComponent(id)}/reopen`), { method: "POST", body: form });
      return read(res, ReopenAcceptedSchema);
    },

    /** Summaries for up to 50 ids; ids the server can't find are simply absent from the result. */
    async getSummaries(ids: string[]): Promise<CaseSummary[]> {
      if (!ids.length) return [];
      const res = await send(u(`/api/cases/summaries?ids=${ids.slice(0, 50).map(encodeURIComponent).join(",")}`), { method: "GET" });
      return read(res, CaseSummariesResponseSchema);
    },

    async getCase(id: string): Promise<CaseDetail> {
      const res = await send(u(`/api/cases/${encodeURIComponent(id)}`), { method: "GET" });
      return read(res, CaseDetailSchema);
    },

    /**
     * Subscribe to the case's SSE stream. EventSource reconnects on its own and resends Last-Event-ID,
     * so the backend replays only what was missed. Returns an unsubscribe function.
     */
    stream(id: string, onEvent: (e: IncomingEvent) => void, onLost: () => void): () => void {
      const es = new EventSource(u(`/api/cases/${encodeURIComponent(id)}/stream`));
      for (const name of Object.keys(SseEventSchemas)) {
        es.addEventListener(name, (msg) => {
          const m = msg as MessageEvent<string>;
          const parsed = parseEvent(name, m.data);
          const revision = revisionOf(m.lastEventId);
          if (parsed && revision !== null) onEvent({ ...parsed, revision, at: Date.now() });
        });
      }
      es.onerror = () => {
        if (es.readyState === EventSource.CLOSED) onLost();
      };
      return () => es.close();
    },
  };
}

export type Api = ReturnType<typeof createApi>;
