import { describe, expect, it } from "vitest";
import { createCase } from "@/pipeline";
import { checkColour, compareColours, parseWish } from "@/pipeline/checks/colour";
import { buildNeeds, isColourPhrase, splitColourPriorities } from "@/pipeline/needs";
import { parseCaseRequest } from "@/pipeline/intake";
import { decideBadge, decideVerdict } from "@/pipeline/verdict/rules";
import { computeGaps } from "@/pipeline/nextMoves";
import type { ListingColour, ListingFacts, UserNeeds } from "@/schemas/domain";
import { UserNeedsSchema } from "@/schemas/domain";
import { check, checksFrom, json, makeDeps, PAGE_TEXT, PNG, PROFILE, type Handler } from "./helpers";
import { createGeminiClient } from "@/gemini/client";
import { testConfig } from "@/lib/config";

const facts = (listingColour?: ListingColour): ListingFacts => ({ platform: "vinted", conditionClaims: [], photoCount: 1, evidence: [], ...(listingColour ? { listingColour } : {}) });
const colour = (names: ListingColour["names"], confidence = 0.85, source: ListingColour["source"] = "colour_field"): ListingColour => ({ names, source, confidence, evidence: [{ source, names, note: `Colour field: "${names.join(", ")}"` }], conflicts: [] });
const needs = (colourWish?: string): UserNeeds => ({ sizes: [], priorities: [], wearTolerance: "light", extraPriorities: [], assumptions: [], ...(colourWish ? { colourWish } : {}) });
const noGemini = () => createGeminiClient({ config: testConfig(), transport: async () => { throw new Error("the colour check must not call Gemini here"); } });

describe("parseWish and compareColours", () => {
  it("one requirement per clause; negation marks colours as avoided", () => {
    expect(parseWish("all white, nothing neon; retro look")).toEqual([
      { text: "all white", wanted: ["white"], avoided: [] },
      { text: "nothing neon", wanted: [], avoided: [] },
      { text: "retro look", wanted: [], avoided: [] },
    ]);
    expect(parseWish("no black")[0]).toMatchObject({ wanted: [], avoided: ["black"] });
    expect(parseWish("")).toEqual([]);
  });
  it("compares wanted and avoided colours with the listing's", () => {
    const [white] = parseWish("white");
    expect(compareColours(white, colour(["white"]))!.verdict).toBe("meets");
    expect(compareColours(white, colour(["black"]))!.verdict).toBe("doesnt");
    expect(compareColours(parseWish("white and grey")[0], colour(["white", "navy"]))!.verdict).toBe("partly");
    expect(compareColours(parseWish("no black")[0], colour(["black", "white"]))!.verdict).toBe("doesnt");
    expect(compareColours(parseWish("no black")[0], colour(["white"]))!.verdict).toBe("meets");
  });
  it("says nothing when the requirement isn't about colour or the listing's colour is unknown", () => {
    expect(compareColours(parseWish("retro")[0], colour(["white"]))).toBeNull();
    expect(compareColours(parseWish("white")[0], undefined)).toBeNull();
    expect(compareColours(parseWish("white")[0], colour([]))).toBeNull();
  });
});

describe("colour kept out of comfort", () => {
  it("recognises colour-only phrases, not real comfort priorities", () => {
    for (const p of ["black", "all white", "no bright colours", "nothing neon", "navy or grey"]) expect(isColourPhrase(p), p).toBe(true);
    for (const p of ["all-day comfort", "wide fit", "black sole grip", "for running a marathon"]) expect(isColourPhrase(p), p).toBe(false);
  });
  it("moves them out of the profile priorities and the note's extras into the colour wish", () => {
    expect(splitColourPriorities({ priorities: ["all-day comfort", "black"], extraPriorities: ["wide fit", "nothing neon"], colourWish: "retro" })).toEqual({
      priorities: ["all-day comfort"],
      extraPriorities: ["wide fit"],
      colourWish: "retro; black; nothing neon",
    });
  });
  it("buildNeeds keeps the buyer's colour box, and a colour typed into the profile or the note becomes a colour wish, not a priority", async () => {
    const n = await buildNeeds({ ...PROFILE, priorities: ["All-day comfort", "black"] }, undefined, null, "all white");
    expect(n).toMatchObject({ priorities: ["All-day comfort"], colourWish: "all white; black" });
    const gemini = createGeminiClient({ config: testConfig(), retryBackoffMs: 1, transport: async () => json({ extraPriorities: ["wide fit", "white"], sizes: [] }) });
    const fromNote = await buildNeeds(PROFILE, "I want white ones, wide fit", gemini);
    expect(fromNote.extraPriorities).toEqual(["wide fit"]);
    expect(fromNote.colourWish).toBe("white");
    expect((await buildNeeds(PROFILE, undefined, null)).colourWish).toBeUndefined();
  });
  it("needs stored before the field existed still parse", () => {
    expect(UserNeedsSchema.parse(needs()).colourWish).toBeUndefined();
  });
  it("the request carries the colour box, trimmed", async () => {
    const f = new FormData();
    f.set("capture", JSON.stringify({ pageText: "x" }));
    f.set("profile", JSON.stringify(PROFILE));
    f.set("colourWish", "  all   white  ");
    expect((await parseCaseRequest(f, 1_000_000)).colourWish).toBe("all white");
  });
});

describe("the colour check", () => {
  const img = [{ bytes: PNG, mimeType: "image/png" as const, index: 0 }];

  it("settles colour words from the listing's own colour without any Gemini call, and never fails", async () => {
    const meets = await checkColour({ gemini: noGemini(), images: img, facts: facts(colour(["white"])), needs: needs("all white") });
    expect(meets).toMatchObject({ check: "colour", status: "pass", geminiFeatures: [] });
    expect(meets.summary).toContain("all white");
    const clash = await checkColour({ gemini: noGemini(), images: img, facts: facts(colour(["black"])), needs: needs("all white") });
    expect(clash.status).toBe("warn"); // advisory: a mismatch is a warning at most
    expect(clash.summary).toMatch(/may not meet what you asked for/);
    expect(clash.evidence.map((e) => e.label).join(" ")).toContain("Listing colour");
  });

  it("asks Gemini about looks, and about colour when the listing's colour is unknown or weak", async () => {
    let asked = "";
    const gemini = createGeminiClient({
      config: testConfig(),
      retryBackoffMs: 1,
      transport: async (req) => {
        asked = JSON.stringify(req.contents);
        return json({ requirements: [{ index: 0, verdict: "meets", note: "All white upper.", photoIndex: 0, confidence: 0.8 }, { index: 1, verdict: "doesnt", note: "A neon heel tab.", photoIndex: 0, confidence: 0.7 }] });
      },
    });
    const r = await checkColour({ gemini, images: img, facts: facts(), needs: needs("all white, nothing neon") });
    expect(asked).toContain("1. nothing neon");
    expect(r).toMatchObject({ status: "warn", geminiFeatures: ["vision", "structured_output"] });
    expect(r.details).toMatchObject({ wish: "all white, nothing neon", requirements: [{ verdict: "meets", source: "photos" }, { verdict: "doesnt", note: "A neon heel tab." }] });
    expect(r.evidence.some((e) => e.kind === "photo_region" && e.photoIndex === 0)).toBe(true);
    // A photo-only colour reading (low confidence) doesn't override the photos' own judgement.
    const weak = await checkColour({ gemini, images: img, facts: facts(colour(["white"], 0.4, "photo")), needs: needs("all white, nothing neon") });
    expect(asked).toContain("0. all white");
    expect(weak.status).toBe("warn");
  });

  it("can't tell without photos or when Gemini can't", async () => {
    const none = await checkColour({ gemini: noGemini(), images: [], facts: facts(), needs: needs("retro") });
    expect(none).toMatchObject({ status: "unknown", confidence: expect.any(Number) });
    expect(none.confidence).toBeLessThanOrEqual(0.3);
  });
});

describe("the colour check in the pipeline", () => {
  const run = async (colourWish: string | undefined, handlers: Record<string, Handler> = {}, opts: { pause?: boolean } = {}) => {
    const deps = makeDeps({ handlers, webSearch: {} });
    const { caseId, done } = await createCase(deps, { capture: { pageText: PAGE_TEXT, imageUrls: ["https://img.example.com/1.jpg"] }, profile: PROFILE, screenshots: [], ...(colourWish ? { colourWish } : {}) }, opts);
    await done;
    return { deps, caseId, events: deps.hub.events(caseId), c: (await deps.store.getCase(caseId))! };
  };

  it("no colour box, no colour row and no extra Gemini call", async () => {
    const { events, deps } = await run(undefined);
    expect(Object.keys(checksFrom(events))).not.toContain("colour");
    expect(deps.calls.some((c) => c.stage === "colour")).toBe(false);
  });

  it("with a colour box: a Colour row, and the comfort check never sees the colour", async () => {
    const { events, deps, c } = await run("all white");
    expect(checksFrom(events).colour).toMatchObject({ check: "colour", status: "pass" });
    expect(c.needs.colourWish).toBe("all white");
    const comfortPrompt = JSON.stringify(deps.calls.filter((x) => x.stage === "comfort").map((x) => x.contents));
    expect(comfortPrompt).not.toMatch(/all white/i);
    expect((await deps.store.getChecks(c.id, 1)).map((x) => x.check)).toContain("colour");
  });

  it("a mismatch is advisory: the verdict label is the same with or without it", async () => {
    const mismatch: Record<string, Handler> = { colour: () => json({ requirements: [{ index: 0, verdict: "doesnt", note: "The upper is black.", photoIndex: 0, confidence: 0.9 }] }) };
    const without = await run(undefined);
    const withWish = await run("all white", mismatch);
    expect(withWish.c.verdict!.label).toBe(without.c.verdict!.label);
    expect(checksFrom(withWish.events).colour.status).toBe("warn");
  });

  it("completes while the case waits for the buyer to confirm the model", async () => {
    const vague: Handler = () => json({ catalogueModelId: "nike-pegasus-40", confidence: 0.55, reasons: "maybe", evidence: [] });
    const { c, events } = await run("all white", { identify: vague });
    expect(c.status).toBe("awaiting_confirmation");
    expect(checksFrom(events).colour.status).toBe("pass");
    expect(checksFrom(events).price).toBeUndefined();
  });
});

describe("colour is advisory in the verdict and next moves", () => {
  const core = [
    check({ check: "identify", status: "pass" }),
    check({ check: "fit", status: "pass" }),
    check({ check: "price", status: "pass", details: { position: "below" } }),
    check({ check: "comfort", status: "pass" }),
    check({ check: "condition", status: "pass", details: { findings: [] } }),
  ];
  it("a colour warn or unknown never changes the label, and low confidence never blocks the badge", () => {
    const base = decideVerdict(core, true).label;
    expect(decideVerdict([...core, check({ check: "colour", status: "warn", confidence: 0.2 })], true).label).toBe(base);
    expect(decideVerdict([...core, check({ check: "colour", status: "unknown", confidence: 0 })], true).label).toBe(base);
    expect(decideBadge("hidden_gem", [...core, check({ check: "colour", status: "warn", confidence: 0.2 })])).toBe("out_sleuthed");
  });
  it("a colour warn adds a low-priority question for the seller", () => {
    const gaps = computeGaps({ checks: [...core, check({ check: "colour", status: "warn" })], leads: [], label: "worth_a_look", answered: [] });
    expect(gaps.find((g) => g.check === "colour")).toMatchObject({ id: "gap_colour", ask: expect.stringMatching(/daylight/) });
    expect(computeGaps({ checks: [...core, check({ check: "colour", status: "pass" })], leads: [], label: "worth_a_look", answered: [] }).some((g) => g.check === "colour")).toBe(false);
  });
});
