import { afterEach, describe, expect, it } from "vitest";
import * as confirmRoute from "@/app/api/cases/[id]/confirm-identity/route";
import { createCase } from "@/pipeline";
import { runLens } from "@/pipeline/lens";
import { buildCtx, runCheck } from "@/pipeline/runChecks";
import { ConfirmConflictError, startConfirm } from "@/pipeline/confirm";
import { applyIdentityChoice, identityNeeded } from "@/pipeline/identityCheck";
import { EventHub } from "@/pipeline/events";
import { RequestError } from "@/pipeline/intake";
import { setDeps } from "@/pipeline/deps";
import { synthesizeEvents, caseDetail } from "@/pipeline/views";
import type { RawShoppingResult } from "@/lib/newPrices";
import type { CheckResult, IdentifyResult, Verdict } from "@/schemas/domain";
import { checksFrom, eventNames, fixtureReference, json, makeDeps, PAGE_TEXT, PROFILE, type Handler } from "./helpers";

afterEach(() => setDeps(null));

const offers = (name: string, gbp: number): RawShoppingResult[] =>
  ["Retailer A", "Retailer B", "Retailer C"].map((source, i) => ({ title: `Nike ${name}`, source, price: `£${gbp + i}.00`, extracted_price: gbp + i, product_link: `https://shop.example.com/${source.replace(/\s/g, "")}/${name.replace(/\s/g, "-")}` }));
const SHOPPING = { "Nike Pegasus 40": offers("Pegasus 40", 100), "Nike Pegasus 41": offers("Pegasus 41", 140) };

const identifyAt = (confidence: number, extra: Record<string, unknown> = {}): Handler => () =>
  json({
    catalogueModelId: "nike-pegasus-40",
    confidence,
    reasons: "Looks like the 40",
    evidence: [{ kind: "quote", label: "Title", quote: "Nike Air Zoom Pegasus 40" }],
    alternatives: [{ modelName: "Pegasus 41", confidence: 0.4, reason: "Similar sole" }],
    ...extra,
  });

async function start(identify: Handler = identifyAt(0.6), over: Parameters<typeof makeDeps>[0] = {}) {
  const deps = makeDeps({ handlers: { identify }, shopping: SHOPPING, webSearch: {}, ...over });
  const { caseId, done } = await createCase(deps, { capture: { pageText: PAGE_TEXT, imageUrls: ["https://img.example.com/1.jpg", "https://img.example.com/2.jpg"] }, profile: PROFILE, screenshots: [] });
  await done;
  return { deps, caseId };
}
const stageCalls = (deps: ReturnType<typeof makeDeps>, stage: string) => deps.calls.filter((c) => c.stage === stage).length;
const searches = (deps: ReturnType<typeof makeDeps>) => [...deps.shoppingRequests, ...deps.webSearchRequests];

describe("the pause", () => {
  it("only possible and best_guess pause; likely and confirmed carry on", async () => {
    for (const [conf, status] of [[0.3, "awaiting_confirmation"], [0.6, "awaiting_confirmation"], [0.8, "closed"], [0.95, "closed"]] as const) {
      const { deps, caseId } = await start(identifyAt(conf));
      expect((await deps.store.getCase(caseId))!.status, `confidence ${conf}`).toBe(status);
    }
  });

  it("no brand at all is R1, not a question", async () => {
    const { deps, caseId } = await start(() => json({ brand: null, modelName: null, catalogueModelId: null, confidence: 0.2, reasons: "?", evidence: [] }));
    expect((await deps.store.getCase(caseId))!.status).toBe("closed");
  });

  it("streams the question with the best guess, alternatives, evidence and the waiting checks, and never says it's done", async () => {
    const { deps, caseId } = await start();
    const events = deps.hub.events(caseId);
    const needed = events.find((e) => e.event === "identity_check_needed")!.data as ReturnType<typeof identityNeeded>;
    expect(needed).toMatchObject({
      level: "possible",
      headline: "Possibly Nike Pegasus 40 or Nike Pegasus 41",
      bestGuess: { label: "Nike Pegasus 40", confidence: 0.6, evidence: ['Title: "Nike Air Zoom Pegasus 40"'] },
      alternatives: [{ label: "Nike Pegasus 41", confidence: 0.4, evidence: ["Similar sole"] }],
      waiting: ["price", "comfort"],
    });
    expect(eventNames(events)).not.toContain("investigation_done");
    expect(eventNames(events)).not.toContain("verdict");
  });

  it("condition and fit complete during the pause; nothing model-dependent runs", async () => {
    const { deps, caseId } = await start();
    const checks = checksFrom(deps.hub.events(caseId));
    expect(checks.fit.status).toBe("pass");
    expect(checks.condition.status).not.toBe("unknown");
    expect(checks.price).toBeUndefined();
    expect(checks.comfort).toBeUndefined();
    expect(stageCalls(deps, "comfort") + stageCalls(deps, "leads") + stageCalls(deps, "verdict")).toBe(0);
    const c = (await deps.store.getCase(caseId))!;
    expect(c.verdict).toBeNull();
    expect(c.identify).toMatchObject({ confidenceLevel: "possible" });
  });

  it("makes no Shopping or web search while paused (Lens, part of identification, runs before the pause: the main photo only)", async () => {
    const { deps } = await start();
    expect(deps.shoppingRequests).toEqual([]);
    expect(deps.webSearchRequests).toEqual([]);
    expect(deps.lensRequests).toEqual(["https://img.example.com/1.jpg"]);
  });

  it("a search attempted on a paused context is refused outright (the guard behind the guarantee)", async () => {
    const { deps, caseId } = await start();
    const c = (await deps.store.getCase(caseId))!;
    const ref = await deps.store.getReference();
    const ctx = buildCtx({ deps, caseId, revision: 1, emit: () => undefined, ref, images: [], pageText: "", facts: c.listingFacts!, needs: c.needs, identify: c.identify, survey: null });
    ctx.paused = true;
    await expect(ctx.newPrices("Pegasus 40", "Nike")).rejects.toThrow(/waiting for the buyer/);
    await runCheck(ctx, "comfort"); // falls back to saved review snippets: no web search is made
    const price = await runCheck(ctx, "price");
    expect(price.status).toBe("unknown");
    expect(searches(deps)).toEqual([]);
    expect(await runLens(ctx, c.identify!)).toBe(c.identify);
    expect(deps.lensRequests).toEqual(["https://img.example.com/1.jpg"]); // only the pre-pause one
  });

  it("Lens (before the pause) still runs for a vague listing; nothing searches after it", async () => {
    const lens = { "https://img.example.com/1.jpg": [{ title: "Nike Pegasus 41 Men's", source: "Shop A", link: "https://a.example.com/1" }] };
    const deps = makeDeps({
      handlers: { identify: identifyAt(0.6), extract: async () => json({ title: "Nike running trainers", brandText: "Nike", modelText: null, sizeText: "UK 9", sizeSystem: "UK", price: 38, currency: "GBP", conditionClaims: [], evidence: [{ field: "price", kind: "quote", quote: "£38.00" }] }) },
      shopping: SHOPPING,
      lens,
    });
    const { caseId, done } = await createCase(deps, { capture: { pageText: "Nike running trainers\nSize: UK 9\n£38.00", imageUrls: ["https://img.example.com/1.jpg"] }, profile: PROFILE, screenshots: [] });
    await done;
    expect((await deps.store.getCase(caseId))!.status).toBe("awaiting_confirmation");
    expect(deps.lensRequests).toEqual(["https://img.example.com/1.jpg"]);
    expect(searches(deps)).toEqual([]);
    const needed = deps.hub.events(caseId).find((e) => e.event === "identity_check_needed")!.data as ReturnType<typeof identityNeeded>;
    expect(needed.lensMatches).toEqual([{ title: "Nike Pegasus 41 Men's", source: "Shop A", url: "https://a.example.com/1" }]);
  });

  it("is persisted: a restart (new process, same database) still has the question, and History's detail shows it", async () => {
    const { deps, caseId } = await start();
    const restarted = { ...deps, hub: new EventHub() };
    const c = (await restarted.store.getCase(caseId))!;
    expect(c.status).toBe("awaiting_confirmation");
    const names = (await synthesizeEvents(restarted, c)).map((e) => e.event);
    expect(names).toEqual(["investigation_started", "check_done", "check_done", "check_done", "identity_check_needed"]);
    const detail = await caseDetail(restarted, c, "http://x.test");
    expect(detail.status).toBe("awaiting_confirmation");
    expect(detail.identify).toMatchObject({ confidenceLevel: "possible", alternatives: [{ model: "Pegasus 41" }] });
  });
});

describe("confirming", () => {
  it("best_guess: user_confirmed, 'Confirmed by you', the waiting checks run on that model, same revision", async () => {
    const { deps, caseId } = await start();
    const started = await startConfirm(deps, caseId, { choice: "best_guess" });
    expect(started!.revision).toBe(1);
    await started!.done;
    const c = (await deps.store.getCase(caseId))!;
    expect(c).toMatchObject({ status: "closed", revision: 1 });
    expect(c.identify).toMatchObject({ confidenceLevel: "user_confirmed", userChoice: { choice: "best_guess" }, bestGuess: { model: "Pegasus 40" } });
    expect(c.identify!.evidence.map((e) => e.label)).toContain("Confirmed by you");
    const checks = checksFrom(deps.hub.events(caseId));
    expect(checks.identify).toMatchObject({ status: "pass", details: { level: "user_confirmed", userChoice: "best_guess" } });
    expect(checks.identify.summary).toBe("You confirmed this as the Nike Pegasus 40.");
    expect(checks.price.details).not.toHaveProperty("conditional");
    expect(checks.comfort.summary).not.toMatch(/best guess/);
    expect(deps.shoppingRequests.every((q) => q.includes("Pegasus 40"))).toBe(true);
    expect((deps.hub.events(caseId).find((e) => e.event === "verdict")!.data as Verdict).label).toBeTruthy();
    expect(eventNames(deps.hub.events(caseId)).at(-1)).toBe("investigation_done");
    expect((await deps.store.getChecks(caseId, 1)).map((x) => x.check).sort()).toEqual(["comfort", "condition", "fit", "identify", "price"]);
  });

  it("alternative: the alternative becomes the model that is searched", async () => {
    const { deps, caseId } = await start();
    await (await startConfirm(deps, caseId, { choice: "alternative", index: 0 }))!.done;
    const c = (await deps.store.getCase(caseId))!;
    expect(c.identify).toMatchObject({ confidenceLevel: "user_confirmed", catalogueModelId: "nike-pegasus-41", bestGuess: { model: "Pegasus 41" }, userChoice: { choice: "alternative" } });
    expect(deps.shoppingRequests.every((q) => q.includes("Pegasus 41"))).toBe(true);
    expect(deps.webSearchRequests).toContain("Nike Pegasus 41 review comfort");
  });

  it("custom: normalised against the catalogue and its aliases without any search", () => {
    const ref = fixtureReference();
    const base = identifyResult();
    const args = { catalogue: ref.catalogue, facts: { platform: "vinted" as const, conditionClaims: [], photoCount: 1, evidence: [] }, now: "2026-11-14T12:00:00Z" };
    const alias = applyIdentityChoice(base, { choice: "custom", brand: "nike", model: "air zoom pegasus 40" }, args);
    expect(alias).toMatchObject({ brand: "Nike", modelName: "Pegasus 40", catalogueModelId: "nike-pegasus-40", inCatalogue: true, confidenceLevel: "user_confirmed", userChoice: { choice: "custom" } });
    const unlisted = applyIdentityChoice(base, { choice: "custom", brand: "Brooks", model: "Ghost 16", version: "GTX", colourway: "Black" }, args);
    expect(unlisted).toMatchObject({ brand: "Brooks", modelName: "Ghost 16", catalogueModelId: null, inCatalogue: false, bestGuess: { version: "GTX", colourway: "Black" } });
  });

  it("custom through the pipeline: an unlisted model is searched by the name the buyer gave", async () => {
    const { deps, caseId } = await start();
    await (await startConfirm(deps, caseId, { choice: "custom", brand: "Nike", model: "Vomero 17" }))!.done;
    expect((await deps.store.getCase(caseId))!.identify).toMatchObject({ modelName: "Vomero 17", catalogueModelId: null, confidenceLevel: "user_confirmed" });
    expect(deps.shoppingRequests.some((q) => q.includes("Vomero 17"))).toBe(true);
  });

  it("skip: model-dependent checks are unknown and nothing searches", async () => {
    const { deps, caseId } = await start();
    await (await startConfirm(deps, caseId, { choice: "skip" }))!.done;
    const checks = checksFrom(deps.hub.events(caseId));
    expect(checks.price).toMatchObject({ status: "unknown", details: { skipped: true } });
    expect(checks.comfort).toMatchObject({ status: "unknown", details: { skipped: true } });
    expect(searches(deps)).toEqual([]);
    expect(deps.hub.events(caseId).some((e) => e.event === "leads_skipped")).toBe(true);
    const c = (await deps.store.getCase(caseId))!;
    expect(c.status).toBe("closed");
    expect(c.identify).toMatchObject({ confidenceLevel: "possible", userChoice: { choice: "skip" } });
  });

  it("a choice that contradicts a label read in a photo is kept, with a warning naming the photo", async () => {
    const label = { kind: "photo_region", label: "Tongue label", photoIndex: 1, box2d: [100, 100, 300, 400] };
    const { deps, caseId } = await start(identifyAt(0.6, { evidence: [label] }));
    await (await startConfirm(deps, caseId, { choice: "alternative", index: 0 }))!.done;
    const c = (await deps.store.getCase(caseId))!;
    expect(c.identify).toMatchObject({ catalogueModelId: "nike-pegasus-41", userChoice: { warning: "Your choice differs from the label in photo 2." } });
    expect(deps.hub.events(caseId).some((e) => e.event === "capture_warning" && (e.data as { message: string }).message === "Your choice differs from the label in photo 2.")).toBe(true);
    expect(checksFrom(deps.hub.events(caseId)).identify.summary).toContain("Pegasus 41");
    // Confirming what the label supports doesn't warn.
    const same = await start(identifyAt(0.6, { evidence: [label] }));
    await (await startConfirm(same.deps, same.caseId, { choice: "best_guess" }))!.done;
    expect((await same.deps.store.getCase(same.caseId))!.identify!.userChoice?.warning).toBeUndefined();
  });

  it("resumes after a restart, not just in the same process", async () => {
    const { deps, caseId } = await start();
    const restarted = makeDeps({ handlers: {}, shopping: SHOPPING, webSearch: {} });
    Object.assign(restarted, { store: deps.store, hub: new EventHub() }); // the database survives; the event buffer doesn't
    const started = await startConfirm(restarted, caseId, { choice: "best_guess" });
    await started!.done;
    expect((await restarted.store.getCase(caseId))!.status).toBe("closed");
    // The rebuilt buffer keeps counting from the replayed events, so a fresh stream sees one coherent sequence.
    const ids = restarted.hub.events(caseId).map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(eventNames(restarted.hub.events(caseId))).toContain("identity_check_needed");
    expect(eventNames(restarted.hub.events(caseId)).at(-1)).toBe("investigation_done");
  });

  it("rejects bad answers without changing the case", async () => {
    const { deps, caseId } = await start();
    await expect(startConfirm(deps, caseId, { choice: "alternative", index: 1 })).rejects.toBeInstanceOf(RequestError);
    expect((await deps.store.getCase(caseId))!.status).toBe("awaiting_confirmation");
    expect(await startConfirm(deps, "cm0doesnotexist", { choice: "best_guess" })).toBeNull();
    const running = await start();
    await running.deps.store.updateCase(running.caseId, { status: "investigating" });
    await expect(startConfirm(running.deps, running.caseId, { choice: "best_guess" })).rejects.toBeInstanceOf(ConfirmConflictError);
  });

  it("a second answer is refused once the case has moved on", async () => {
    const { deps, caseId } = await start();
    await (await startConfirm(deps, caseId, { choice: "best_guess" }))!.done;
    await expect(startConfirm(deps, caseId, { choice: "skip" })).rejects.toBeInstanceOf(RequestError); // skip only applies while waiting
  });
});

describe("correcting a finished case (\"Not right?\")", () => {
  it("reruns as revision 2 with the corrected model and a diff", async () => {
    const { deps, caseId } = await start(identifyAt(0.9, { alternatives: [{ modelName: "Pegasus 41", confidence: 0.3 }] }));
    expect((await deps.store.getCase(caseId))!.status).toBe("closed");
    const started = await startConfirm(deps, caseId, { choice: "custom", brand: "Nike", model: "Pegasus 41" });
    expect(started!.revision).toBe(2);
    await started!.done;
    const c = (await deps.store.getCase(caseId))!;
    expect(c).toMatchObject({ status: "closed", revision: 2 });
    expect(c.identify).toMatchObject({ confidenceLevel: "user_confirmed", catalogueModelId: "nike-pegasus-41" });
    const events = deps.hub.events(caseId);
    expect(eventNames(events)).toContain("case_reopened");
    expect(eventNames(events)).toContain("diff");
    expect(eventNames(events).at(-1)).toBe("investigation_done");
  });
});

describe("POST /api/cases/:id/confirm-identity", () => {
  const ORIGIN = "chrome-extension://testextensionid";
  const call = (id: string, body: unknown) =>
    confirmRoute.POST(new Request(`http://localhost:3000/api/cases/${id}/confirm-identity`, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), headers: { origin: ORIGIN } }), { params: Promise.resolve({ id }) });

  it("202 with the revision, then the case finishes", async () => {
    const { deps, caseId } = await start();
    setDeps(deps);
    const res = await call(caseId, { choice: "alternative", index: 0 });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ caseId, revision: 1 });
    for (let i = 0; i < 200 && (await deps.store.getCase(caseId))!.status !== "closed"; i++) await new Promise((r) => setTimeout(r, 10));
    expect((await deps.store.getCase(caseId))!.identify).toMatchObject({ catalogueModelId: "nike-pegasus-41" });
  });

  it("400 for a bad body, 404 for an unknown case, 409 while it is still running", async () => {
    const { deps, caseId } = await start();
    setDeps(deps);
    expect((await call(caseId, "not json")).status).toBe(400);
    expect((await call(caseId, { choice: "maybe" })).status).toBe(400);
    expect((await call(caseId, { choice: "custom", brand: "", model: "x" })).status).toBe(400);
    expect((await call(caseId, { choice: "alternative", index: 1 })).status).toBe(400);
    expect((await call("cm0doesnotexist1", { choice: "best_guess" })).status).toBe(404);
    await deps.store.updateCase(caseId, { status: "investigating" });
    expect((await call(caseId, { choice: "best_guess" })).status).toBe(409);
  });
});

function identifyResult(): IdentifyResult {
  return {
    brand: "Nike",
    brandConfidence: 0.9,
    modelName: "Pegasus 40",
    catalogueModelId: "nike-pegasus-40",
    inCatalogue: true,
    confidence: 0.6,
    reasons: "",
    evidence: [],
    confidenceLevel: "possible",
    bestGuess: { brand: "Nike", model: "Pegasus 40", version: null, colourway: null, confidence: 0.6, evidence: [] },
    alternatives: [{ brand: "Nike", model: "Pegasus 41", version: null, colourway: null, confidence: 0.4, evidence: [] }],
  };
}
void (null as unknown as CheckResult);
