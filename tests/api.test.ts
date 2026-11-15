import { afterEach, describe, expect, it } from "vitest";
import * as casesRoute from "@/app/api/cases/route";
import * as caseRoute from "@/app/api/cases/[id]/route";
import * as streamRoute from "@/app/api/cases/[id]/stream/route";
import * as reopenRoute from "@/app/api/cases/[id]/reopen/route";
import * as shareRoute from "@/app/api/cases/[id]/share/route";
import * as imageRoute from "@/app/api/cases/[id]/images/[index]/route";
import * as summariesRoute from "@/app/api/cases/summaries/route";
import * as feedRoute from "@/app/api/feed/route";
import { setDeps } from "@/pipeline/deps";
import { CaseDetailSchema, CaseSummariesResponseSchema, FeedResponseSchema } from "@/schemas";
import { json, makeDeps, PAGE_TEXT, PNG, PROFILE } from "./helpers";

const ORIGIN = "chrome-extension://testextensionid";
const BASE = "http://localhost:3000";
const params = <T>(p: T) => ({ params: Promise.resolve(p) });

function caseForm(capture: object, extra: (f: FormData) => void = () => {}) {
  const f = new FormData();
  f.set("capture", JSON.stringify(capture));
  f.set("profile", JSON.stringify(PROFILE));
  extra(f);
  return f;
}

const post = (url: string, body: FormData | string, origin: string | null = ORIGIN) =>
  new Request(url, { method: "POST", body, headers: origin ? { origin } : {} });

async function createCase(deps: ReturnType<typeof makeDeps>, capture: object = { pageText: PAGE_TEXT, imageUrls: ["https://img.example.com/1.jpg"] }) {
  const res = await casesRoute.POST(post(`${BASE}/api/cases`, caseForm(capture)));
  expect(res.status).toBe(201);
  const { caseId } = await res.json();
  return caseId as string;
}

async function waitForStatus(deps: ReturnType<typeof makeDeps>, caseId: string, status = "closed") {
  for (let i = 0; i < 200; i++) {
    if ((await deps.store.getCase(caseId))?.status === status) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("timed out waiting for case");
}

type Ev = { event: string; data: unknown; id?: string };

/** Incremental SSE reader over one connection. */
function sseReader(res: Response) {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  return {
    /** Read events until `until` arrives (connection stays open unless close=true). */
    async until(until: string, onEvent: (event: string, data: unknown) => Promise<void> | void = () => {}, close = false): Promise<Ev[]> {
      const events: Ev[] = [];
      for (;;) {
        let idx;
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const ev = /^event: (.+)$/m.exec(block)?.[1];
          const data = /^data: (.+)$/m.exec(block)?.[1];
          if (!ev || !data) continue;
          const parsed = { event: ev, data: JSON.parse(data), id: /^id: (.+)$/m.exec(block)?.[1] };
          events.push(parsed);
          await onEvent(parsed.event, parsed.data);
          if (ev === until) {
            if (close) await reader.cancel();
            return events;
          }
        }
        const { value, done } = await reader.read();
        if (done) return events;
        buf += decoder.decode(value, { stream: true });
      }
    },
    close: () => reader.cancel(),
  };
}

const readSse = (res: Response, until: string, onEvent?: (event: string, data: unknown) => Promise<void> | void) => sseReader(res).until(until, onEvent, true);

afterEach(() => setDeps(null));

describe("CORS", () => {
  it("answers preflight for allowed origins only", async () => {
    setDeps(makeDeps());
    const ok = await casesRoute.OPTIONS(new Request(`${BASE}/api/cases`, { method: "OPTIONS", headers: { origin: ORIGIN, "access-control-request-method": "POST" } }));
    expect(ok.status).toBe(204);
    expect(ok.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(ok.headers.get("access-control-allow-methods")).toMatch(/GET, POST/);
    const bad = await casesRoute.OPTIONS(new Request(`${BASE}/api/cases`, { method: "OPTIONS", headers: { origin: "https://evil.example" } }));
    expect(bad.status).toBe(403);
    expect(bad.headers.get("access-control-allow-origin")).toBeNull();
  });
  it("rejects requests from other origins and adds headers for allowed ones", async () => {
    setDeps(makeDeps());
    const res = await casesRoute.POST(post(`${BASE}/api/cases`, caseForm({ pageText: "x" }), "https://evil.example"));
    expect(res.status).toBe(403);
    const feed = await feedRoute.GET(new Request(`${BASE}/api/feed`, { headers: { origin: ORIGIN } }));
    expect(feed.headers.get("access-control-allow-origin")).toBe(ORIGIN);
  });
});

describe("POST /api/cases", () => {
  it("rejects a request with no capture content", async () => {
    setDeps(makeDeps());
    const res = await casesRoute.POST(post(`${BASE}/api/cases`, caseForm({ pageText: "   ", imageUrls: [] })));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Capture is empty/);
  });
  it("rejects invalid JSON fields, non-image screenshots and non-multipart bodies", async () => {
    setDeps(makeDeps());
    const badProfile = caseForm({ pageText: "x" });
    badProfile.set("profile", JSON.stringify({ sizes: [{ brand: "Nike", size: -1 }] }));
    expect((await casesRoute.POST(post(`${BASE}/api/cases`, badProfile))).status).toBe(400);
    const badShot = caseForm({}, (f) => f.append("screenshots[]", new Blob(["hello"], { type: "image/png" }), "x.png"));
    expect((await casesRoute.POST(post(`${BASE}/api/cases`, badShot))).status).toBe(415);
    expect((await casesRoute.POST(new Request(`${BASE}/api/cases`, { method: "POST", body: "{}", headers: { origin: ORIGIN, "content-type": "application/json" } }))).status).toBe(415);
  });
  it("accepts screenshots only (fallback upload page)", async () => {
    const deps = makeDeps();
    setDeps(deps);
    const res = await casesRoute.POST(post(`${BASE}/api/cases`, caseForm({}, (f) => f.append("screenshots[]", new Blob([PNG], { type: "image/png" }), "s.png"))));
    expect(res.status).toBe(201);
    const { caseId } = await res.json();
    await waitForStatus(deps, caseId);
    expect((await deps.store.getInputs(caseId, { kinds: ["image"] })).length).toBe(1);
  });
  it("rate limits case creation per IP", async () => {
    const deps = makeDeps();
    deps.limiter.create = new (deps.limiter.create.constructor as new (l: number, w: number) => typeof deps.limiter.create)(1, 60_000);
    setDeps(deps);
    const mk = () => new Request(`${BASE}/api/cases`, { method: "POST", body: caseForm({ pageText: PAGE_TEXT }), headers: { origin: ORIGIN, "x-forwarded-for": "1.2.3.4" } });
    expect((await casesRoute.POST(mk())).status).toBe(201);
    const limited = await casesRoute.POST(mk());
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBeTruthy();
  });
});

describe("SSE stream", () => {
  it("delivers events incrementally while the investigation runs, then replays to late subscribers", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const base = makeDeps();
    const deps = makeDeps({
      handlers: {
        condition: async (req) => {
          await gate; // hold the investigation until the client has seen early events
          return (await import("./helpers")).happyHandlers().condition(req);
        },
      },
    });
    void base;
    setDeps(deps);
    const caseId = await createCase(deps);
    const res = await streamRoute.GET(new Request(`${BASE}/api/cases/${caseId}/stream`, { headers: { origin: ORIGIN } }), params({ id: caseId }));
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
    expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);

    const statusAtEvent: Record<string, string> = {};
    const events = await readSse(res, "investigation_done", async (event, data) => {
      const key = event === "check_done" ? `check_done:${(data as { check: string }).check}` : event;
      statusAtEvent[key] ??= (await deps.store.getCase(caseId))!.status;
      if (key === "check_done:identify") release();
    });
    expect(statusAtEvent["investigation_started"]).toBe("investigating");
    expect(statusAtEvent["check_done:identify"]).toBe("investigating");
    expect(events.map((e) => e.event)).toContain("verdict");
    expect(events[0].id).toBe("1:1");

    // A late subscriber gets the whole buffered revision; Last-Event-ID skips what it already has.
    const late = await streamRoute.GET(new Request(`${BASE}/api/cases/${caseId}/stream`), params({ id: caseId }));
    const replay = await readSse(late, "investigation_done");
    expect(replay.map((e) => e.event)).toEqual(events.map((e) => e.event));
    const resumed = await streamRoute.GET(new Request(`${BASE}/api/cases/${caseId}/stream`, { headers: { "last-event-id": replay.at(-2)!.id! } }), params({ id: caseId }));
    expect((await readSse(resumed, "investigation_done")).map((e) => e.event)).toEqual(["investigation_done"]);
  });

  it("rebuilds events from the database when the in-memory buffer is gone", async () => {
    const deps = makeDeps();
    setDeps(deps);
    const caseId = await createCase(deps);
    await waitForStatus(deps, caseId);
    setDeps({ ...deps, hub: new (deps.hub.constructor as new () => typeof deps.hub)() });
    const res = await streamRoute.GET(new Request(`${BASE}/api/cases/${caseId}/stream`), params({ id: caseId }));
    const events = await readSse(res, "investigation_done");
    expect(events.map((e) => e.event)).toEqual(["investigation_started", "observed_alternatives", ...Array(5).fill("check_done"), "warning_signals", "verdict", "next_moves", "investigation_done"]);
  });

  it("404s unknown cases", async () => {
    setDeps(makeDeps());
    expect((await streamRoute.GET(new Request(`${BASE}/api/cases/nope/stream`), params({ id: "nope" }))).status).toBe(404);
    expect((await streamRoute.GET(new Request(`${BASE}/api/cases/cabcdefgh12345678/stream`), params({ id: "cabcdefgh12345678" }))).status).toBe(404);
  });
});

describe("case endpoints", () => {
  it("GET case, image, summaries", async () => {
    const deps = makeDeps();
    setDeps(deps);
    const caseId = await createCase(deps);
    await waitForStatus(deps, caseId);

    const res = await caseRoute.GET(new Request(`${BASE}/api/cases/${caseId}`, { headers: { origin: ORIGIN } }), params({ id: caseId }));
    const detail = CaseDetailSchema.parse(await res.json());
    expect(detail.verdict?.label).toBe("hidden_gem");
    expect(detail.checks).toHaveLength(5);
    expect(detail.imageUrls).toEqual([`${BASE}/api/cases/${caseId}/images/0`]);
    for (const id of detail.verdict!.citedEvidenceIds) expect(detail.evidenceIndex[id]).toBeDefined();
    expect(detail.history).toHaveLength(1);

    const img = await imageRoute.GET(new Request(detail.imageUrls[0]), params({ id: caseId, index: "0" }));
    expect(img.status).toBe(200);
    expect(img.headers.get("content-type")).toBe("image/png");
    expect((await imageRoute.GET(new Request(detail.imageUrls[0]), params({ id: caseId, index: "5" }))).status).toBe(404);

    const sum = await summariesRoute.GET(new Request(`${BASE}/api/cases/summaries?ids=${caseId},cmissingcase000000000`));
    const list = CaseSummariesResponseSchema.parse(await sum.json());
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: caseId, verdictLabel: "hidden_gem", priceGBP: 38, platform: "other", thumbnailUrl: detail.imageUrls[0], status: "closed", revision: 1 });
    expect(list[0].createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(list[0]).toHaveProperty("pageUrl"); // "View listing"
    const tooMany = Array.from({ length: 51 }, (_, i) => `c${String(i).padStart(10, "0")}`).join(",");
    expect((await summariesRoute.GET(new Request(`${BASE}/api/cases/summaries?ids=${tooMany}`))).status).toBe(400);
  });

  it("reopen: 202, then 409 while investigating, progress on the same stream", async () => {
    const deps = makeDeps({ handlers: { reopen: () => json({ conditionStatements: ["No marks on the soles"], answers: ["condition"] }) } });
    setDeps(deps);
    const caseId = await createCase(deps);
    await waitForStatus(deps, caseId);
    const stream = sseReader(await streamRoute.GET(new Request(`${BASE}/api/cases/${caseId}/stream`), params({ id: caseId })));
    await stream.until("investigation_done");

    const f = new FormData();
    f.set("sellerReply", "No marks on the soles at all.");
    const res = await reopenRoute.POST(post(`${BASE}/api/cases/${caseId}/reopen`, f), params({ id: caseId }));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ caseId, revision: 2 });
    const again = new FormData();
    again.set("sellerReply", "x");
    expect((await reopenRoute.POST(post(`${BASE}/api/cases/${caseId}/reopen`, again), params({ id: caseId }))).status).toBe(409);

    const events = await stream.until("investigation_done");
    await stream.close();
    const names = events.map((e) => e.event);
    expect(names[0]).toBe("case_reopened");
    expect(names).toContain("diff");
    expect(events[0].id).toBe("2:1");
    await waitForStatus(deps, caseId);
    const empty = new FormData();
    expect((await reopenRoute.POST(post(`${BASE}/api/cases/${caseId}/reopen`, empty), params({ id: caseId }))).status).toBe(400);
  });
});

describe("share + feed", () => {
  it("refuses share for a non-hidden_gem verdict", async () => {
    const deps = makeDeps({ handlers: { identify: () => json({ catalogueModelId: null, confidence: 0.2, reasons: "unsure", evidence: [] }) } });
    setDeps(deps);
    const caseId = await createCase(deps);
    await waitForStatus(deps, caseId);
    const res = await shareRoute.POST(post(`${BASE}/api/cases/${caseId}/share`, JSON.stringify({ optIn: true })), params({ id: caseId }));
    expect(res.status).toBe(409);
    expect((await deps.store.getCase(caseId))!.shareOptIn).toBe(false);
    // opting out is always allowed
    expect((await shareRoute.POST(post(`${BASE}/api/cases/${caseId}/share`, JSON.stringify({ optIn: false })), params({ id: caseId }))).status).toBe(200);
  });

  it("shares a hidden_gem, which then appears in the feed with no identities; size filter applies", async () => {
    const deps = makeDeps();
    setDeps(deps);
    const caseId = await createCase(deps);
    await waitForStatus(deps, caseId);
    const res = await shareRoute.POST(post(`${BASE}/api/cases/${caseId}/share`, JSON.stringify({ optIn: true })), params({ id: caseId }));
    expect(await res.json()).toEqual({ shareOptIn: true });

    const all = FeedResponseSchema.parse(await (await feedRoute.GET(new Request(`${BASE}/api/feed`))).json());
    expect(all.length).toBeGreaterThanOrEqual(7);
    expect(all.every((i) => i.verdictLabel === "hidden_gem")).toBe(true);
    expect(JSON.stringify(all)).not.toMatch(/jane|seller|username/i);
    const mine = all.find((i) => i.caseId === caseId)!;
    expect(mine).toMatchObject({ modelName: "Nike Pegasus 40", priceGBP: 38, priceSource: "Compared with 12 listings sampled on 3–10 Nov" });

    const nike9 = FeedResponseSchema.parse(await (await feedRoute.GET(new Request(`${BASE}/api/feed?brand=Nike&size=9&system=UK`))).json());
    expect(nike9.map((i) => i.caseId).sort()).toEqual([caseId, "demo-feed-001"].sort());
    const us10 = FeedResponseSchema.parse(await (await feedRoute.GET(new Request(`${BASE}/api/feed?size=10&system=US`))).json());
    expect(us10.map((i) => i.caseId)).toContain("demo-feed-001");
    expect((await feedRoute.GET(new Request(`${BASE}/api/feed?system=XX`))).status).toBe(400);
  });
});
