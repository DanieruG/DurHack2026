import { describe, expect, it } from "vitest";
import { createCase } from "@/pipeline";
import { startReopen } from "@/pipeline/reopen";
import { IDENTIFY_SYSTEM } from "@/pipeline/identify";
import { CaseDiffSchema, CheckResultSchema, SseEventSchemas, VerdictSchema } from "@/schemas";
import type { CheckResult, NextMove, Verdict } from "@/schemas/domain";
import { checksFrom, eventNames, grounded, happyHandlers, json, makeDeps, PAGE_TEXT, PNG, PROFILE, promptText, type Handler } from "./helpers";

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
    expect(verdict).toMatchObject({ label: "hidden_gem", ruleId: "R6" });
    const done = events.at(-1)!.data as { geminiCalls: number; revision: number };
    expect(done.revision).toBe(1);
    expect(done.geminiCalls).toBe(deps.calls.length);
    expect(stageCalls(deps, "price")).toBe(0); // Source B not needed at this price
    expect(stageCalls(deps, "leads")).toBe(0); // nothing looked off

    const stored = (await deps.store.getCase(caseId))!;
    expect(stored).toMatchObject({ status: "closed", platform: "vinted", pageUrl: "https://www.vinted.co.uk/items/123-nike-pegasus", revision: 1 });
    expect(stored.history).toEqual([{ revision: 1, verdictLabel: "hidden_gem", at: "2026-11-14T12:00:00.000Z" }]);
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
    expect((events.find((e) => e.event === "verdict")!.data as Verdict)).toMatchObject({ label: "proceed_with_caution", ruleId: "R5" });
    const moves = (await deps.store.getCase(caseId))!.nextMoves!;
    expect(moves.some((m) => m.relatesTo.includes("identify"))).toBe(true);
  });

  it("model named but not in the catalogue: comfort + new-price search use the name; no sampled comparison; plain note; lower confidence", async () => {
    const deps = makeDeps({
      handlers: {
        identify: () => json({ brand: "Nike", brandConfidence: 0.95, modelName: "Nike Pegasus 39", catalogueModelId: null, confidence: 0.9, reasons: "Tongue label reads Pegasus 39", evidence: [] }),
        price: () => grounded([["PRICE | Nike | £100", ["nike.com"]], ["PRICE | JD Sports | £105", ["jdsports.co.uk"]]]),
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
    const prompts = deps.calls.filter((c) => c.stage === "price" || c.stage === "comfort").map(promptText);
    expect(prompts).toHaveLength(2);
    for (const p of prompts) expect(p).toContain("Nike Pegasus 39");
    expect((events.find((e) => e.event === "verdict")!.data as Verdict).label).not.toBe("not_enough_evidence");
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
    expect((events.find((e) => e.event === "verdict")!.data as Verdict).ruleId).toBe("R5");
  });

  it("a stage timeout becomes unknown", async () => {
    const deps = makeDeps({ config: { stageTimeoutMs: 150 }, handlers: { comfort: () => new Promise((r) => setTimeout(() => r(json({})), 400)) } });
    const { events } = await investigate(deps);
    expect(checksFrom(events).comfort).toMatchObject({ status: "unknown", summary: expect.stringMatching(/ran out of time/) });
  });

  it("a slow search hits SEARCH_TIMEOUT_MS and falls back to saved reviews, well inside the stage timeout", async () => {
    const hang: Handler = () => new Promise(() => undefined);
    const deps = makeDeps({ config: { stageTimeoutMs: 2000, searchTimeoutMs: 100 }, handlers: { comfort: hang } });
    const started = Date.now();
    const { events } = await investigate(deps);
    expect(Date.now() - started).toBeLessThan(1500);
    expect(checksFrom(events).comfort).toMatchObject({ details: { fallback: true } });
    expect(checksFrom(events).comfort.summary).not.toMatch(/ran out of time/);
  });

  it("follows at most MAX_LEADS leads; executors update checks; flag_for_seller adds a question", async () => {
    const deps = makeDeps({
      handlers: {
        comfort: () => grounded([["PRIORITY | all-day comfort | mixed | Some find it firm.", ["runrepeat.com"]]]),
        leads: () =>
          json({
            leads: [
              { type: "flag_for_seller", reason: "Comfort evidence is thin.", relatesTo: "comfort" },
              { type: "deeper_price_comparison", reason: "Check against like-new listings." },
              { type: "recheck_identification", reason: "Pegasus 40 vs 41.", photoIndex: 0 },
              { type: "recheck_condition_photo", reason: "Creasing?", photoIndex: 0, defectLabels: ["upper_creasing"] },
            ],
          }),
        price: () => grounded([["PRICE | SportsShoes | £119.99", ["sportsshoes.com"]], ["PRICE | Nike | £119.95", ["nike.com"]]]),
      },
    });
    const { caseId, events } = await investigate(deps);
    const started = events.filter((e) => e.event === "lead_started");
    const done = events.filter((e) => e.event === "lead_done").map((e) => e.data as { type: string; status: string });
    expect(started).toHaveLength(2);
    expect(done.map((d) => [d.type, d.status])).toEqual([["flag_for_seller", "done"], ["deeper_price_comparison", "done"]]);
    // deeper price comparison forced Source B and the updated price check was re-emitted
    const priceEvents = events.filter((e) => e.event === "check_done" && (e.data as CheckResult).check === "price");
    expect(priceEvents).toHaveLength(2);
    expect((priceEvents[1].data as CheckResult).details).toMatchObject({ sourceBRun: true, newPrice: { gbp: 119.97, sources: 2 } });
    expect((priceEvents[1].data as CheckResult).geminiFeatures).toContain("search_grounding");
    expect(stageCalls(deps, "identify")).toBe(1); // third lead not executed
    expect((await deps.store.getLeads(caseId, 1))).toHaveLength(2);
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
      const priceLines = grounded([["PRICE | SportsShoes | £119.99", ["sportsshoes.com"]], ["PRICE | Nike | £119.95", ["nike.com"]]]);
      const withTool = (final: Handler, fn: string, args: Record<string, unknown>): Handler => (req) => {
        const hasFns = req.config?.tools?.some((t) => "functionDeclarations" in t);
        if (hasFns && req.contents.length === 1) return { text: "", functionCalls: [{ id: "f1", name: fn, args }] };
        return final(req);
      };
      const base = happyHandlers();
      const deps = makeDeps({
        config: { combinedTools: combined },
        handlers: {
          extract: async (req) => json({ ...JSON.parse((await base.extract(req)).text), price: 55 }),
          price: withTool(() => priceLines, "sampleStats", { modelId: "nike-pegasus-40" }),
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
    expect(separate.checks.price.details).toMatchObject({ newPrice: { gbp: 119.97 } });
    expect(combined.checks.price.geminiFeatures).toEqual(["search_grounding", "function_calling"]);
    expect(separate.checks.price.geminiFeatures).toEqual(["search_grounding"]);
    expect(combined.deps.calls.find((c) => c.stage === "price")?.config?.toolConfig).toMatchObject({ includeServerSideToolInvocations: true });
  });
});
