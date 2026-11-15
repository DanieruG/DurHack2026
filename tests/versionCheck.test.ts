import { describe, expect, it } from "vitest";
import { createCase } from "@/pipeline";
import { compareIdentifications, modelFromPhotosOnly } from "@/pipeline/versionCheck";
import type { CheckResult, IdentifyResult, NextMove } from "@/schemas/domain";
import { checksFrom, fixtureReference, happyHandlers, json, makeDeps, PROFILE, type Handler } from "./helpers";

const id = (over: Partial<IdentifyResult>): IdentifyResult => ({ brand: "Nike", brandConfidence: 0.95, modelName: "Pegasus 40", catalogueModelId: "nike-pegasus-40", inCatalogue: true, confidence: 0.9, reasons: "Tongue label", evidence: [], ...over });
const facts = { platform: "vinted" as const, conditionClaims: [], photoCount: 3, evidence: [] };

describe("version check: helpers", () => {
  const cat = fixtureReference().catalogue;
  it("only when the listing's own words never name the model", () => {
    expect(modelFromPhotosOnly(id({}), { ...facts, title: "Nike running trainers" }, "Nike trainers UK 9, worn twice", cat)).toBe(true);
    expect(modelFromPhotosOnly(id({}), { ...facts, title: "Nike Pegasus 40" }, "", cat)).toBe(false);
    expect(modelFromPhotosOnly(id({}), facts, "Nike Air Zoom Pegasus 40, UK 9", cat)).toBe(false); // catalogue alias
    expect(modelFromPhotosOnly(id({}), facts, "Nike Pegasus, worn 40 times", cat)).toBe(true); // version must follow the name
    expect(modelFromPhotosOnly(id({ modelName: null, catalogueModelId: null }), facts, "", cat)).toBe(false);
  });
  it("compares subjects", () => {
    const s = (modelName: string | null, catId: string | null = null) => ({ tier: "model" as const, brand: "Nike", modelName, displayName: null, catalogue: catId ? cat.find((m) => m.id === catId)! : null });
    expect(compareIdentifications(s("Pegasus 40"), s("pegasus 40"))).toBe("agree");
    expect(compareIdentifications(s("Pegasus 40"), s("Pegasus 41"))).toBe("disagree");
    expect(compareIdentifications(s("Pegasus 40"), s(null))).toBe("declined");
  });
});

describe("version check: pipeline", () => {
  // The listing text never names the model; Flash reads "Pegasus 40" off the tongue label.
  const PAGE = "Nike running trainers\nSize: UK 9\n£38.00\nCondition: Very good\nWorn twice, no box.";
  const flash = { brand: "Nike", brandConfidence: 0.95, modelName: "Pegasus 40", catalogueModelId: "nike-pegasus-40", confidence: 0.9, reasons: "Tongue label reads Pegasus 40", evidence: [] };
  const base = happyHandlers();
  const handlers = (pro: Handler): Record<string, Handler> => ({
    extract: async (req) => json({ ...JSON.parse((await base.extract(req)).text), title: "Nike running trainers", modelText: null, evidence: [{ field: "price", kind: "quote", quote: "£38.00" }] }),
    identify: (req) => (req.tier === "strong" ? pro(req) : json(flash)),
  });
  const run = async (pro: Handler, config = {}) => {
    const deps = makeDeps({ handlers: handlers(pro), config, webSearch: {} });
    const { caseId, done } = await createCase(deps, { capture: { pageText: PAGE, imageUrls: ["https://img.example.com/1.jpg", "https://img.example.com/2.jpg"] }, profile: PROFILE, screenshots: [] }, { pause: false });
    await done;
    const events = deps.hub.events(caseId);
    const c = (await deps.store.getCase(caseId))!;
    return { deps, events, checks: checksFrom(events), c };
  };

  it("Pro disagrees: possible; the more confident answer (Pro on a tie) is the best guess, the other an alternative; both answers as evidence", async () => {
    const { deps, events, checks, c } = await run(() => json({ ...flash, modelName: "Pegasus 41", catalogueModelId: "nike-pegasus-41", reasons: "Sole pattern is the 41" }));
    expect(deps.calls.filter((x) => x.tier === "strong").map((x) => x.stage)).toEqual(["identify"]); // one Pro call, no recheck lead
    expect(events.some((e) => e.event === "stage_started" && (e.data as { stage: string }).stage === "version_check")).toBe(true);
    expect(checks.identify).toMatchObject({ status: "warn", details: { tier: "catalogue", level: "possible", modelName: "Nike Pegasus 41", proRecheck: { outcome: "disagree" } } });
    expect(checks.identify.summary).toMatch(/Possibly Nike Pegasus 41 or Nike Pegasus 40/);
    expect(checks.identify.evidence.filter((e) => e.kind === "data_point").map((e) => [e.label, e.value])).toEqual([
      ["Gemini Flash, from the photos", "Nike Pegasus 40"],
      ["Gemini Pro recheck", "Nike Pegasus 41"],
    ]);
    expect(c.identify).toMatchObject({ confidenceLevel: "possible", catalogueModelId: "nike-pegasus-41", bestGuess: { model: "Pegasus 41" }, alternatives: [{ model: "Pegasus 40" }] });
    // Nothing is withheld: fit and condition ran, and price and comfort ran on the best guess.
    expect(checks.fit.status).toBe("pass");
    expect(checks.condition.status).not.toBe("unknown");
    expect(deps.webSearchRequests).toContain("Nike Pegasus 41 review comfort");
    expect((c.nextMoves as NextMove[]).find((m) => m.kind === "ask_seller")).toMatchObject({ relatesTo: ["identify"] });
  });

  it("Flash is more confident than Pro: Flash stays the best guess", async () => {
    const { c } = await run(() => json({ ...flash, modelName: "Pegasus 41", catalogueModelId: "nike-pegasus-41", confidence: 0.6 }));
    expect(c.identify).toMatchObject({ confidenceLevel: "possible", bestGuess: { model: "Pegasus 40" }, alternatives: [{ model: "Pegasus 41" }] });
  });

  it("Pro agrees: the case continues on the model, with both answers recorded", async () => {
    const { checks } = await run(() => json(flash));
    expect(checks.identify).toMatchObject({ status: "pass", details: { tier: "catalogue", level: "likely", proRecheck: { outcome: "agree" } } });
    expect(checks.identify.evidence.find((e) => e.label === "Gemini Pro recheck (agrees)")?.value).toBe("Nike Pegasus 40");
    expect(checks.price.status).not.toBe("unknown");
  });

  it("Pro times out or declines: Flash's answer stands, level possible", async () => {
    const slow = await run(() => new Promise(() => undefined), { proRecheckTimeoutMs: 100, stageTimeoutMs: 3000 });
    expect(slow.checks.identify.details).toMatchObject({ tier: "catalogue", level: "possible", proRecheck: { outcome: "timeout" } });
    expect(slow.checks.identify.evidence.find((e) => e.label === "Gemini Pro recheck")?.value).toMatch(/no answer within/);
    const declined = await run(() => json({ ...flash, modelName: null, catalogueModelId: null, confidence: 0 }));
    expect((declined.checks.identify.details as { proRecheck: { outcome: string } }).proRecheck.outcome).toBe("declined");
    expect(declined.c.identify).toMatchObject({ confidenceLevel: "possible", bestGuess: { model: "Pegasus 40" }, alternatives: [] });
  });

  it("does not run when the listing names the model", async () => {
    const deps = makeDeps();
    const { done } = await createCase(deps, { capture: { pageText: "Nike Air Zoom Pegasus 40 trainers\nSize: UK 9\n£38.00", imageUrls: ["https://img.example.com/1.jpg"] }, profile: PROFILE, screenshots: [] });
    await done;
    expect(deps.calls.filter((x) => x.tier === "strong")).toHaveLength(0);
  });
});
