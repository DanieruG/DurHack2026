import { describe, expect, it } from "vitest";
import { createCase } from "@/pipeline";
import { caseDetail } from "@/pipeline/views";
import { startReopen } from "@/pipeline/reopen";
import { IDENTIFY_SYSTEM } from "@/pipeline/identify";
import { CaseDiffSchema, CheckResultSchema, SseEventSchemas, VerdictSchema } from "@/schemas";
import type { CheckResult, NextMove, Verdict } from "@/schemas/domain";
import { checksFrom, comfortSummary, eventNames, fixtureReference, happyHandlers, json, makeDeps, PAGE_TEXT, PNG, PROFILE, promptText, shoppingFixture, type Handler } from "./helpers";

const capture = {
  pageUrl: "https://www.vinted.co.uk/items/123-nike-pegasus?referrer=x",
  pageText: PAGE_TEXT,
  imageUrls: ["https://img.example.com/1.jpg", "https://img.example.com/2.jpg", "https://img.example.com/missing.jpg"],
};

async function investigate(deps: ReturnType<typeof makeDeps>, over: Partial<typeof capture> = {}) {
  const { caseId, done } = await createCase(deps, { capture: { ...capture, ...over }, profile: PROFILE, screenshots: [] });
  await done;
  return { caseId, events: deps.hub.events(caseId) };
}

const stageCalls = (deps: ReturnType<typeof makeDeps>, stage: string) => deps.calls.filter((c) => c.stage === stage).length;

describe("investigation pipeline (mocked Gemini)", () => {
  it("runs end to end: events in order, every payload matches its contract, hidden_gem verdict", async () => {
    const deps = makeDeps();
    const { caseId, events } = await investigate(deps);
    const names = eventNames(events);
    expect(names[0]).toBe("investigation_started");
    expect(names.at(-1)).toBe("investigation_done");
    expect(names.indexOf("verdict")).toBeLessThan(names.indexOf("next_moves"));
    for (const e of events) expect(SseEventSchemas[e.event].safeParse(e.data).success, e.event).toBe(true);

    expect(events.find((e) => e.event === "capture_warning")?.data).toEqual({ message: "Only 2 of 3 photos could be loaded" });
    const checks = checksFrom(events);
    expect(Object.keys(checks).sort()).toEqual(["comfort", "condition", "fit", "identify", "price"]);
    expect(names.indexOf("check_done")).toBe(names.findIndex((n, i) => n === "check_done" && (events[i].data as CheckResult).check === "identify"));
    expect(Object.values(checks).map((c) => c.status)).toEqual(["pass", "pass", "pass", "pass", "pass"]);
    expect(checks.price.details).toMatchObject({ position: "below", sourceBRun: false });
    expect(checks.price.evidence.find((e) => e.sourceType === "price_sample")).toMatchObject({ label: "Compared with 12 listings sampled on 3–10 Nov", observedOn: "2026-11-10" });
    expect(checks.condition.geminiFeatures).toEqual(["vision", "object_detection", "structured_output"]);
    expect(checks.fit.details?.reviewSizingNote).toBe("Most reviewers say it fits true to size.");

    const verdict = events.find((e) => e.event === "verdict")!.data as Verdict;
    expect(verdict).toMatchObject({ label: "hidden_gem", ruleId: "R7" });
    const done = events.at(-1)!.data as { geminiCalls: number; revision: number };
    expect(done.revision).toBe(1);
    expect(done.geminiCalls).toBe(deps.calls.length);
    expect(stageCalls(deps, "price")).toBe(0); // Source B not needed at this price
    expect(stageCalls(deps, "leads")).toBe(0); // nothing looked off

    const stored = (await deps.store.getCase(caseId))!;
    expect(stored).toMatchObject({ status: "closed", platform: "vinted", pageUrl: "https://www.vinted.co.uk/items/123-nike-pegasus", revision: 1 });
    expect(stored.history).toEqual([
      { revision: 1, verdictLabel: "hidden_gem", at: "2026-11-14T12:00:00.000Z", leads: { considered: false }, warningSignals: [], run: { durationMs: expect.any(Number), geminiCalls: expect.any(Number), cachedCalls: 0 } },
    ]);
    const doneEv = events.find((e) => e.event === "investigation_done")!.data as { geminiCalls: number };
    expect(stored.history[0].run?.geminiCalls).toBe(doneEv.geminiCalls);
    expect((await deps.store.getInputs(caseId, { kinds: ["image"] })).length).toBe(2);
  });

  it("redacts seller identity before storage and before any Gemini call", async () => {
    const deps = makeDeps();
    const { caseId } = await investigate(deps);
    const [text] = await deps.store.getInputs(caseId, { kinds: ["page_text"] });
    for (const s of [text.text!, ...deps.calls.map(promptText)]) {
      expect(s).not.toMatch(/jane_doe_99|Member since|120 reviews/);
    }
  });

  it("emits, persists and returns warning signals from redacted listing text", async () => {
    const deps = makeDeps();
    const { caseId, events } = await investigate(deps, { pageText: `${PAGE_TEXT}\nPay by bank transfer or WhatsApp me.` });
    const warning = events.find((e) => e.event === "warning_signals");
    expect(warning?.data).toMatchObject([{ id: "off_platform", strength: "strong" }]);
    expect(events.findIndex((e) => e.event === "warning_signals")).toBeLessThan(events.findIndex((e) => e.event === "verdict"));
    const detail = await caseDetail(deps, (await deps.store.getCase(caseId))!, "http://x.test");
    expect(detail.warningSignals.map((s) => s.id)).toContain("off_platform");
    expect((await deps.store.getCase(caseId))!.history[0].warningSignals?.map((s) => s.id)).toContain("off_platform");
  });

  it("no brand: R1, but condition still runs on the photos; fit/price/comfort are unknown without any calls", async () => {
    const deps = makeDeps({ handlers: { identify: () => json({ brand: null, modelName: null, catalogueModelId: null, confidence: 0.3, reasons: "Can't tell", evidence: [] }) } });
    const { caseId, events } = await investigate(deps);
    const checks = checksFrom(events);
    expect(checks.identify).toMatchObject({ status: "unknown", details: { tier: "none", inCatalogue: false } });
    expect(checks.fit).toMatchObject({ status: "unknown", summary: expect.stringMatching(/brand/) });
    for (const c of ["price", "comfort"]) expect(checks[c]).toMatchObject({ status: "unknown", summary: expect.stringMatching(/exact model/) });
    expect(checks.condition.status).not.toBe("unknown");
    expect(stageCalls(deps, "condition")).toBe(1);
    expect(stageCalls(deps, "comfort") + stageCalls(deps, "price") + stageCalls(deps, "leads")).toBe(0);
    expect((events.find((e) => e.event === "verdict")!.data as Verdict)).toMatchObject({ label: "not_enough_evidence", ruleId: "R1" });
    const moves = (await deps.store.getCase(caseId))!.nextMoves!;
    expect(moves[0]).toMatchObject({ kind: "ask_seller", relatesTo: ["identify"] });
  });

  it("a low-confidence catalogue guess with no confident brand is still R1", async () => {
    const deps = makeDeps({ handlers: { identify: () => json({ catalogueModelId: "nike-pegasus-40", confidence: 0.6, reasons: "maybe", evidence: [] }) } });
    const { events } = await investigate(deps);
    expect((events.find((e) => e.event === "verdict")!.data as Verdict).label).toBe("not_enough_evidence");
  });

  it("brand only: fit runs on the brand's size chart; price and comfort are unknown; not R1", async () => {
    const deps = makeDeps({ handlers: { identify: () => json({ brand: "nike", brandConfidence: 0.95, modelName: null, catalogueModelId: null, confidence: 0, reasons: "Swoosh visible", evidence: [] }) } });
    const { caseId, events } = await investigate(deps);
    const checks = checksFrom(events);
    expect(checks.identify).toMatchObject({ status: "warn", details: { tier: "brand", brand: "Nike", modelName: "Nike" } });
    expect(checks.fit).toMatchObject({ status: "pass", details: { match: "exact" } });
    expect(checks.price.status).toBe("unknown");
    expect(checks.comfort.status).toBe("unknown");
    expect(stageCalls(deps, "comfort") + stageCalls(deps, "price")).toBe(0);
    expect((events.find((e) => e.event === "verdict")!.data as Verdict)).toMatchObject({ label: "proceed_with_caution", ruleId: "R6" });
    const moves = (await deps.store.getCase(caseId))!.nextMoves!;
    expect(moves.some((m) => m.relatesTo.includes("identify"))).toBe(true);
  });

  it("model named but not in the catalogue: comfort + new-price search use the name; no sampled comparison; plain note; lower confidence", async () => {
    const deps = makeDeps({
      handlers: {
        identify: () => json({ brand: "Nike", brandConfidence: 0.95, modelName: "Nike Pegasus 39", catalogueModelId: null, confidence: 0.9, reasons: "Tongue label reads Pegasus 39", evidence: [] }),
      },
      shopping: {
        "Nike Pegasus 39": [
          { title: "Nike Air Zoom Pegasus 39 Men's", source: "Nike", price: "£100.00", extracted_price: 100, product_link: "https://example.test/1" },
          { title: "Nike Pegasus 39 Running Shoes", source: "JD Sports", price: "£105.00", extracted_price: 105, product_link: "https://example.test/2" },
          { title: "Nike Pegasus 39 Men's Road Running", source: "SportsShoes.com", price: "£95.00", extracted_price: 95, product_link: "https://example.test/3" },
        ],
      },
    });
    const { events } = await investigate(deps);
    const checks = checksFrom(events);
    expect(checks.identify).toMatchObject({ status: "pass", details: { tier: "model", modelName: "Nike Pegasus 39", catalogueModelId: null, inCatalogue: false } });
    expect(checks.fit.status).toBe("pass"); // Nike chart, by brand
    expect(checks.price.summary.startsWith("This model isn't in our price sample, so price is compared with the current new price only.")).toBe(true);
    expect(checks.price).toMatchObject({ status: "pass", confidence: 0.45, details: { inCatalogue: false, position: "below", sourceBRun: true } });
    expect(checks.price.details).not.toHaveProperty("sample");
    expect(checks.comfort.status).not.toBe("unknown");
    expect(checks.price.details).toMatchObject({ newPrice: { gbp: 100, sources: 3 } });
    expect(deps.shoppingRequests).toEqual(["Nike Pegasus 39"]); // Shopping query "{brand} {modelName}"
    expect(stageCalls(deps, "price")).toBe(0); // no Gemini call for price any more
    expect(deps.webSearchRequests).toEqual(["Nike Pegasus 39 review comfort"]); // SerpApi query "{brand} {model} review comfort"
    expect(deps.calls.filter((c) => c.stage === "comfort").map(promptText).join("\n")).toContain("Nike Pegasus 39");
    expect((events.find((e) => e.event === "verdict")!.data as Verdict).label).not.toBe("not_enough_evidence");
  });

  it("latency: extract + identify is one Flash call at low thinking; verdict and next moves overlap", async () => {
    let verdictDone = 0;
    let movesStarted = 0;
    const base = happyHandlers();
    const deps = makeDeps({
      handlers: {
        verdict: async (req) => {
          await new Promise((r) => setTimeout(r, 40));
          verdictDone = Date.now();
          return base.verdict(req);
        },
        next_moves: (req) => {
          movesStarted ||= Date.now();
          return base.next_moves(req);
        },
      },
    });
    const { events } = await investigate(deps);
    const extract = deps.calls.filter((c) => c.stage === "extract");
    expect(extract).toHaveLength(1);
    expect(extract[0]).toMatchObject({ tier: "fast", config: { thinkingConfig: { thinkingLevel: "LOW" } } });
    expect(stageCalls(deps, "identify")).toBe(0);
    expect(checksFrom(events).identify).toMatchObject({ status: "pass", details: { catalogueModelId: "nike-pegasus-40" } });
    for (const stage of ["condition", "verdict", "next_moves"]) {
      expect(deps.calls.find((c) => c.stage === stage)?.config?.thinkingConfig).toEqual({ thinkingLevel: "LOW" });
    }
    expect(movesStarted).toBeGreaterThan(0);
    expect(movesStarted).toBeLessThan(verdictDone); // next moves started before the verdict wording finished
  });

  it("if the merged call fails, identify runs on its own (Flash) so the case still has a chance", async () => {
    const deps = makeDeps({ handlers: { extract: () => ({ text: "not json", functionCalls: [] }) } });
    const { events } = await investigate(deps);
    expect(deps.calls.filter((c) => c.stage === "identify").map((c) => c.tier)).toEqual(["fast"]);
    expect(checksFrom(events).identify.status).toBe("pass");
  });

  it("the recheck_identification lead is the only Pro call", async () => {
    const deps = makeDeps({
      handlers: {
        comfort: comfortSummary([{ topic: "all-day comfort", assessment: "mixed", summary: "Some find it firm.", cite: ["runrepeat.com"] }]),
        leads: () => json({ leads: [{ type: "recheck_identification", reason: "Pegasus 40 vs 41.", photoIndex: 0 }] }),
      },
    });
    await investigate(deps);
    expect(deps.calls.filter((c) => c.tier === "strong").map((c) => c.stage)).toEqual(["identify"]);
  });

  it("skips leads when the only open checks are unknown because a search failed", async () => {
    const ref = fixtureReference();
    const deps = makeDeps({
      reference: { ...ref, reviews: [] }, // no saved reviews to fall back on
      webSearch: { fetch: async () => ({ ok: false, status: 500, json: async () => ({}) }) }, // SerpApi is down
    });
    const { caseId, events } = await investigate(deps);
    const checks = checksFrom(events);
    expect(checks.comfort).toMatchObject({ status: "unknown", details: { searchFailed: true } });
    expect(stageCalls(deps, "leads")).toBe(0);
    // ...and says why, in the stream and in the case file.
    expect(events.find((e) => e.event === "leads_skipped")?.data).toEqual({ reason: "Skipped: the review search was unavailable." });
    const detail = await caseDetail(deps, (await deps.store.getCase(caseId))!, "http://x.test");
    expect(detail.leadsReport).toEqual({ considered: true, skipped: "Skipped: the review search was unavailable." });
  });

  it("leads: hidden when everything is clear; a missing brand is a stated skip", async () => {
    const clear = makeDeps();
    const a = await investigate(clear);
    expect(a.events.some((e) => e.event === "leads_skipped")).toBe(false);
    expect((await caseDetail(clear, (await clear.store.getCase(a.caseId))!, "http://x.test")).leadsReport).toEqual({ considered: false });

    const noBrand = makeDeps({ handlers: { identify: () => json({ brand: null, brandConfidence: 0, modelName: null, catalogueModelId: null, confidence: 0.1, reasons: "Unclear", evidence: [] }) } });
    const b = await investigate(noBrand);
    expect(b.events.find((e) => e.event === "leads_skipped")?.data).toEqual({ reason: expect.stringMatching(/^Skipped: the brand couldn't be identified/) });
  });

  it("identify is told to use only this listing, never other listings on the page", () => {
    expect(IDENTIFY_SYSTEM).toMatch(/ONLY this listing's own title, item details, description and photos/);
    expect(IDENTIFY_SYSTEM).toMatch(/similar items/);
  });

  it("a rejected check becomes unknown with a plain explanation, and the case still reaches a verdict", async () => {
    const deps = makeDeps({ handlers: { condition: () => { throw new Error("boom: internal stack"); } } });
    const { events } = await investigate(deps);
    const checks = checksFrom(events);
    expect(checks.condition.status).toBe("unknown");
    expect(checks.condition.summary).not.toMatch(/boom|stack/);
    expect(events.some((e) => e.event === "error" && (e.data as { stage?: string }).stage === "condition")).toBe(true);
    expect((events.find((e) => e.event === "verdict")!.data as Verdict).ruleId).toBe("R6");
  });

  it("a stage timeout becomes unknown", async () => {
    const deps = makeDeps({ config: { stageTimeoutMs: 150 }, handlers: { comfort: () => new Promise((r) => setTimeout(() => r(json({})), 400)) } });
    const { events } = await investigate(deps);
    expect(checksFrom(events).comfort).toMatchObject({ status: "unknown", summary: expect.stringMatching(/ran out of time/) });
  });

  it("a slow search hits SEARCH_TIMEOUT_MS and falls back to saved reviews, well inside the stage timeout", async () => {
    const hang: Handler = () => new Promise(() => undefined);
    const deps = makeDeps({ config: { stageTimeoutMs: 2000, searchTimeoutMs: 100 }, webSearch: { fetch: () => new Promise(() => undefined) }, handlers: { comfort: hang } });
    const started = Date.now();
    const { events } = await investigate(deps);
    expect(Date.now() - started).toBeLessThan(1500);
    expect(checksFrom(events).comfort).toMatchObject({ details: { fallback: true } });
    expect(checksFrom(events).comfort.summary).not.toMatch(/ran out of time/);
  });

  it("follows at most MAX_LEADS leads; executors update checks; flag_for_seller adds a question", async () => {
    const deps = makeDeps({
      handlers: {
        comfort: comfortSummary([{ topic: "all-day comfort", assessment: "mixed", summary: "Some find it firm.", cite: ["runrepeat.com"] }]),
        leads: (req) =>
          req.contents.length === 1
            ? { text: "", functionCalls: [{ id: "f1", name: "getNewPrices", args: { brand: "Nike", modelName: "Pegasus 40" } }] }
            : json({
            leads: [
              { type: "flag_for_seller", reason: "Comfort evidence is thin.", relatesTo: "comfort" },
              { type: "deeper_price_comparison", reason: "Check against like-new listings." },
              { type: "recheck_identification", reason: "Pegasus 40 vs 41.", photoIndex: 0 },
              { type: "recheck_condition_photo", reason: "Creasing?", photoIndex: 0, defectLabels: ["upper_creasing"] },
            ],
          }),
      },
      shopping: { "Nike Pegasus 40": shoppingFixture("nike-pegasus-40") },
    });
    const { caseId, events } = await investigate(deps);
    const started = events.filter((e) => e.event === "lead_started");
    const done = events.filter((e) => e.event === "lead_done").map((e) => e.data as { type: string; status: string });
    expect(started).toHaveLength(2);
    expect(done.map((d) => [d.type, d.status])).toEqual([["flag_for_seller", "done"], ["deeper_price_comparison", "done"]]);
    // deeper price comparison forced Source B and the updated price check was re-emitted
    const priceEvents = events.filter((e) => e.event === "check_done" && (e.data as CheckResult).check === "price");
    expect(priceEvents).toHaveLength(2);
    expect((priceEvents[1].data as CheckResult).details).toMatchObject({ sourceBRun: true, newPrice: { gbp: 89.99, sources: 3 } });
    // Gemini called getNewPrices while proposing leads -> function_calling; the tool and the check shared one request
    expect((priceEvents[0].data as CheckResult).geminiFeatures).toEqual([]);
    expect((priceEvents[1].data as CheckResult).geminiFeatures).toEqual(["function_calling"]);
    expect(deps.shoppingRequests).toEqual(["Nike Pegasus 40"]);
    expect(stageCalls(deps, "identify")).toBe(0); // identified inside the merged extract call; the recheck lead (3rd) wasn't executed
    expect((await deps.store.getLeads(caseId, 1))).toHaveLength(2);
    // Persisted and returned by GET /api/cases/:id, with the per-revision report.
    const detail = await caseDetail(deps, (await deps.store.getCase(caseId))!, "http://x.test");
    expect(detail.leads.map((l) => [l.type, l.status, typeof l.outcome])).toEqual([["flag_for_seller", "done", "string"], ["deeper_price_comparison", "done", "string"]]);
    expect(detail.leadsReport).toEqual({ considered: true });
    expect(started.map((e) => (e.data as { id: string }).id)).toEqual(["lead_1", "lead_2"]);
    const moves = (await deps.store.getCase(caseId))!.nextMoves as NextMove[];
    expect(moves.some((m) => m.kind === "ask_seller" && m.relatesTo.includes("comfort"))).toBe(true);
    expect(moves.filter((m) => m.kind === "ask_seller").length).toBeLessThanOrEqual(3);
  });

  it("reopen with a seller reply reruns only the affected checks and reports a diff", async () => {
    const base = happyHandlers();
    const deps = makeDeps({
      handlers: {
        extract: async (req) => {
          const r = JSON.parse((await base.extract(req)).text);
          return json({ ...r, sizeText: null, sizeSystem: null, evidence: r.evidence.filter((e: { field: string }) => e.field !== "size") });
        },
        reopen: () => json({ sizeText: "UK 9", sizeSystem: "UK", conditionStatements: [], answers: ["fit"] }),
      },
    });
    const { caseId, events: first } = await investigate(deps, { pageText: PAGE_TEXT.replace("Size: UK 9\n", "") });
    expect(checksFrom(first).fit.status).toBe("unknown");
    expect((first.find((e) => e.event === "verdict")!.data as Verdict).label).toBe("proceed_with_caution");

    const before = { comfort: stageCalls(deps, "comfort"), condition: stageCalls(deps, "condition"), identify: stageCalls(deps, "identify") };
    const started = await startReopen(deps, caseId, { sellerReply: "Hi! They're UK 9. Seller: jane_doe_99", screenshots: [] });
    expect(started?.revision).toBe(2);
    await started!.done;

    const events = deps.hub.events(caseId);
    const names = eventNames(events);
    expect(names[0]).toBe("case_reopened");
    expect(names.slice(-2)).toEqual(["diff", "investigation_done"]);
    expect(stageCalls(deps, "comfort")).toBe(before.comfort);
    expect(stageCalls(deps, "condition")).toBe(before.condition);
    expect(stageCalls(deps, "identify")).toBe(before.identify);
    const rerun = events.filter((e) => e.event === "check_done").map((e) => (e.data as CheckResult).check);
    expect(rerun).toEqual(["fit"]);

    const diff = CaseDiffSchema.parse(events.find((e) => e.event === "diff")!.data);
    expect(diff).toMatchObject({ fromRevision: 1, toRevision: 2, verdict: { before: "proceed_with_caution", after: "hidden_gem" } });
    expect(diff.checks).toEqual([{ check: "fit", before: "unknown", after: "pass", reason: "Seller's reply gave the size: UK 9" }]);

    const c = (await deps.store.getCase(caseId))!;
    expect(c.revision).toBe(2);
    expect(c.history.map((h) => h.verdictLabel)).toEqual(["proceed_with_caution", "hidden_gem"]);
    expect((await deps.store.getChecks(caseId, 2)).length).toBe(5);
    expect((c.nextMoves ?? []).some((m) => m.relatesTo.includes("fit"))).toBe(false); // answered question dropped
    const [reply] = await deps.store.getInputs(caseId, { kinds: ["seller_reply"] });
    expect(reply.text).not.toMatch(/jane_doe_99/);
  });

  it("reopen with a new photo reruns condition only", async () => {
    const deps = makeDeps();
    const { caseId } = await investigate(deps);
    const before = { comfort: stageCalls(deps, "comfort"), price: stageCalls(deps, "price") };
    const r = await startReopen(deps, caseId, { screenshots: [{ bytes: PNG, mimeType: "image/png" }] });
    await r!.done;
    const rerun = deps.hub.events(caseId).filter((e) => e.event === "check_done").map((e) => (e.data as CheckResult).check);
    expect(rerun).toEqual(["condition"]);
    expect(stageCalls(deps, "comfort")).toBe(before.comfort);
    expect((await deps.store.getInputs(caseId, { kinds: ["image"] })).length).toBe(3);
  });

  it("combined-tools flag produces identical output shapes", async () => {
    const shapes = async (combined: boolean) => {
      const withTool = (final: Handler, fn: string, args: Record<string, unknown>): Handler => (req) => {
        const hasFns = req.config?.tools?.some((t) => "functionDeclarations" in t);
        if (hasFns && req.contents.length === 1) return { text: "", functionCalls: [{ id: "f1", name: fn, args }] };
        return final(req);
      };
      const base = happyHandlers();
      const deps = makeDeps({
        config: { combinedTools: combined },
        shopping: { "Nike Pegasus 40": shoppingFixture("nike-pegasus-40") },
        handlers: {
          extract: async (req) => json({ ...JSON.parse((await base.extract(req)).text), price: 55 }),
          comfort: withTool(base.comfort, "convertSize", { brand: "Nike", size: 9, system: "UK" }),
        },
      });
      const { events } = await investigate(deps, { pageText: PAGE_TEXT.replace("£38.00", "£55.00") });
      const checks = checksFrom(events);
      for (const c of Object.values(checks)) CheckResultSchema.parse(c);
      VerdictSchema.parse(events.find((e) => e.event === "verdict")!.data);
      return { checks, deps };
    };
    const separate = await shapes(false);
    const combined = await shapes(true);
    for (const name of ["identify", "fit", "price", "comfort", "condition"]) {
      const a = separate.checks[name];
      const b = combined.checks[name];
      expect(Object.keys(b).sort()).toEqual(Object.keys(a).sort());
      expect(Object.keys(b.details ?? {}).sort()).toEqual(Object.keys(a.details ?? {}).sort());
      expect(b.status).toBe(a.status);
      expect(b.evidence.map((e) => Object.keys(e).sort())).toEqual(a.evidence.map((e) => Object.keys(e).sort()));
    }
    expect(separate.checks.price.details).toMatchObject({ newPrice: { gbp: 89.99 } });
    expect(combined.checks.comfort.geminiFeatures).toEqual(["structured_output", "function_calling"]);
    expect(separate.checks.comfort.geminiFeatures).toEqual(["structured_output"]);
    // Comfort never offers Gemini's built-in search tool: the results come from SerpApi.
    for (const run of [separate, combined]) {
      for (const c of run.deps.calls.filter((x) => x.stage === "comfort")) expect(JSON.stringify(c.config?.tools ?? [])).not.toMatch(/googleSearch/);
    }
  });
});
