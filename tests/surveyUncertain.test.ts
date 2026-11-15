import { describe, expect, it } from "vitest";
import { createCase } from "@/pipeline";
import { startConfirm } from "@/pipeline/confirm";
import { alternativesView, DEFERRED_LINE } from "@/extension/src/lib/alternatives";
import type { ObservedAlternatives, ObservedListing } from "@/schemas/domain";
import { checksFrom, json, makeDeps, PAGE_TEXT, PROFILE, type Handler } from "./helpers";

/** A survey was taken and the identification is only a guess: the panel must not say no survey was taken. */
let n = 0;
const card = (over: Partial<ObservedListing> = {}): ObservedListing => {
  n++;
  return {
    id: String(7000 + n),
    title: "Nike Pegasus 40 UK 9",
    price: 30,
    currency: "GBP",
    url: `https://www.vinted.co.uk/items/${7000 + n}-nike-pegasus-40`,
    thumbnailUrl: `https://images1.vinted.net/t/${7000 + n}/310x430/a.webp`,
    sponsored: false,
    priceBasis: "excl_buyer_protection",
    seenAt: "2026-11-14T10:00:00.000Z",
    ...over,
  };
};
const cards = () => [card({ price: 30 }), card({ price: 32 }), card({ price: 45 }), card({ price: 50 }), card({ price: 55 }), card({ id: "123", price: 1 })];
const vague: Handler = () => json({ catalogueModelId: "nike-pegasus-40", confidence: 0.55, reasons: "maybe", evidence: [], alternatives: [{ modelName: "Pegasus 41", confidence: 0.4 }] });
const capture = { pageUrl: "https://www.vinted.co.uk/items/123-nike-pegasus", pageText: PAGE_TEXT, imageUrls: ["https://img.example.com/1.jpg"], observedListings: cards(), searchQuery: "nike pegasus 40" };
const alternativesOf = (events: ReturnType<ReturnType<typeof makeDeps>["hub"]["events"]>) => events.filter((e) => e.event === "observed_alternatives").map((e) => e.data as ObservedAlternatives).at(-1)!;

describe("a survey with an uncertain identification", () => {
  it("(no pause) says the survey was taken but not compared yet, not that there was none", async () => {
    const deps = makeDeps({ handlers: { identify: vague }, webSearch: {} });
    const { caseId, done } = await createCase(deps, { capture, profile: PROFILE, screenshots: [] }, { pause: false });
    await done;
    const events = deps.hub.events(caseId);
    expect(alternativesOf(events)).toMatchObject({ surveyUsed: true, deferred: true, alternatives: [] });
    expect((checksFrom(events).price.details as { observedAlternatives: ObservedAlternatives }).observedAlternatives).toMatchObject({ surveyUsed: true, deferred: true });
    expect(alternativesView(alternativesOf(events))).toEqual({ kind: "empty", line: DEFERRED_LINE });
  });

  it("after the buyer confirms, the survey is compared and alternatives are found", async () => {
    const deps = makeDeps({ handlers: { identify: vague }, webSearch: {} });
    const { caseId, done } = await createCase(deps, { capture, profile: PROFILE, screenshots: [] });
    await done;
    expect((await deps.store.getCase(caseId))!.status).toBe("awaiting_confirmation");
    await (await startConfirm(deps, caseId, { choice: "best_guess" }))!.done;
    const last = alternativesOf(deps.hub.events(caseId));
    expect(last.surveyUsed).toBe(true);
    expect(last.deferred).toBeUndefined();
  });

  it("after Skip the survey is reported as not compared, still not as missing", async () => {
    const deps = makeDeps({ handlers: { identify: vague }, webSearch: {} });
    const { caseId, done } = await createCase(deps, { capture, profile: PROFILE, screenshots: [] });
    await done;
    await (await startConfirm(deps, caseId, { choice: "skip" }))!.done;
    expect(alternativesOf(deps.hub.events(caseId))).toMatchObject({ surveyUsed: true, deferred: true });
  });

  it("with no survey at all it still says there was none", async () => {
    const deps = makeDeps({ handlers: { identify: vague }, webSearch: {} });
    const { caseId, done } = await createCase(deps, { capture: { ...capture, observedListings: undefined, searchQuery: undefined }, profile: PROFILE, screenshots: [] }, { pause: false });
    await done;
    expect(alternativesOf(deps.hub.events(caseId))).toMatchObject({ surveyUsed: false });
    expect(alternativesOf(deps.hub.events(caseId)).deferred).toBeUndefined();
  });
});
