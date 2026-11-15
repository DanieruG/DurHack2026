import { describe, expect, it } from "vitest";
import { ConditionWireSchema, conditionStatus, finaliseCondition, gradeFromClaims, wireToFindings } from "@/pipeline/checks/condition";
import { checkComfort, comfortFromSnippets, comfortFromSummary, comfortResult, verifiedQuote, type ComfortDetails, type ComfortSummary } from "@/pipeline/checks/comfort";
import { comfortQuery, resultDomain, topOrganic, type WebResult } from "@/lib/webSearch";
import { MemoryStore } from "@/lib/store";
import { computeGaps } from "@/pipeline/nextMoves";
import { classifySource } from "@/gemini/grounding";
import type { ConditionFinding, ListingFacts, UserNeeds } from "@/schemas/domain";
import { COMFORT_RESULTS, fakeWebSearch, fixtureReference } from "./helpers";

const f = (severity: ConditionFinding["severity"], confidence = 0.8): ConditionFinding => ({ label: "outsole_wear", photoIndex: 0, box2d: [1, 2, 3, 4], severity, confidence, note: "", evidenceId: "ev_cond_1" });
const needs: UserNeeds = { sizes: [], priorities: ["all-day comfort", "wide fit"], wearTolerance: "light", extraPriorities: [], assumptions: [] };

describe("condition status", () => {
  it("parses per-photo stock and label visibility fields, defaulting photos for old responses", () => {
    expect(ConditionWireSchema.parse({ findings: [], notVisible: [], contradictions: [], photos: [{ photoIndex: 0, stockPhotoLikely: true, confidence: 0.82, showsSizeLabel: false, showsInsole: true }] }).photos[0]).toEqual({
      photoIndex: 0,
      stockPhotoLikely: true,
      confidence: 0.82,
      showsSizeLabel: false,
      showsInsole: true,
    });
    expect(ConditionWireSchema.parse({ findings: [], notVisible: [], contradictions: [] }).photos).toEqual([]);
  });
  it("light tolerance (spec default)", () => {
    expect(conditionStatus([f("major")], [], "light")).toBe("fail");
    expect(conditionStatus([f("moderate")], [], "light")).toBe("warn");
    expect(conditionStatus([f("minor")], [], "light")).toBe("pass");
    expect(conditionStatus([], [], "light")).toBe("pass");
    expect(conditionStatus([f("minor")], ["described as new"], "light")).toBe("warn");
  });
  it("possible (< 0.6 confidence) findings count one level lower", () => {
    expect(conditionStatus([f("major", 0.5)], [], "light")).toBe("warn");
    expect(conditionStatus([f("moderate", 0.5)], [], "light")).toBe("pass");
  });
  it("respects wear tolerance", () => {
    expect(conditionStatus([f("minor")], [], "none")).toBe("warn");
    expect(conditionStatus([f("moderate")], [], "moderate")).toBe("pass");
    expect(conditionStatus([f("major")], [], "any")).toBe("warn");
  });
  it("maps seller words to grades", () => {
    expect(gradeFromClaims(["Brand new with tags"])).toBe("new_with_tags");
    expect(gradeFromClaims(["Very good, worn twice"])).toBe("like_new");
    expect(gradeFromClaims(["Good condition"])).toBe("good");
    expect(gradeFromClaims(["Well worn, signs of wear"])).toBe("worn");
    expect(gradeFromClaims([])).toBeUndefined();
  });
  it("normalises boxes, drops bad photo indices, records a contradiction", () => {
    const findings = wireToFindings(
      { photos: [], findings: [
        { label: "heel_wear", photoIndex: 0, box2d: [600, 900, 400, 1200], severity: "moderate", confidence: 0.9, note: "Worn heel" },
        { label: "tear_or_hole", photoIndex: 5, box2d: [1, 1, 2, 2], severity: "major", confidence: 0.9, note: "x" },
      ], notVisible: [], contradictions: [] },
      [0, 1],
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].box2d).toEqual([400, 900, 600, 1000]);
    const facts: ListingFacts = { platform: "vinted", photoCount: 2, conditionClaims: ["Like new"], evidence: [] };
    const r = finaliseCondition({ findings, notVisible: ["inside lining"], modelContradictions: [], facts, needs, photosChecked: 2 });
    expect(r.status).toBe("warn");
    expect((r.details as { contradictions: string[] }).contradictions[0]).toMatch(/Described as "Like new"; moderate heel wear visible in photo 1/);
    expect(r.evidence[0]).toMatchObject({ kind: "photo_region", photoIndex: 0, box2d: [400, 900, 600, 1000] });
    expect(r.geminiFeatures).toEqual(["vision", "object_detection", "structured_output"]);
  });
  it("marks low-confidence findings as possible", () => {
    const [x] = wireToFindings({ photos: [], findings: [{ label: "discolouration", photoIndex: 0, box2d: [0, 0, 10, 10], severity: "minor", confidence: 0.4, note: "maybe a shadow" }], notVisible: [], contradictions: [] }, [0]);
    const r = finaliseCondition({ findings: [x], notVisible: [], modelContradictions: [], facts: { platform: "other", photoCount: 1, conditionClaims: [], evidence: [] }, needs, photosChecked: 1 });
    expect(r.evidence[0].label).toMatch(/^Possible discolouration/);
  });
});

describe("source classification", () => {
  it("classifies sources by domain; model hints never upgrade manufacturer/retailer", () => {
    expect(classifySource("runrepeat.com")).toBe("independent_review");
    expect(classifySource("nike.com", "independent_review")).toBe("manufacturer");
    expect(classifySource("sportsshoes.com")).toBe("retailer");
    expect(classifySource("someblog.net", "independent_review")).toBe("independent_review");
    expect(classifySource("someblog.net")).toBe("other");
  });
});

describe("comfort from SerpApi results", () => {
  const results: WebResult[] = topOrganic(COMFORT_RESULTS);
  const priorities = ["all-day comfort", "wide fit"];
  type Point = ComfortSummary["points"][number];
  const run = (points: Point[], sourceTypes: ComfortSummary["sourceTypes"] = []) =>
    comfortResult(comfortFromSummary({ points, sourceTypes }, results, priorities), { today: "2026-11-14", features: ["structured_output"] });

  it("keeps the top 6 organic results in rank order, numbered from 1", () => {
    const raw = [{ position: 2, title: "B", link: "https://b.test" }, { position: 1, title: "A", link: "https://a.test" }, { position: 3, title: "no link" }];
    expect(topOrganic([...raw, ...COMFORT_RESULTS.map((r) => ({ ...r, position: r.position + 3 }))]).map((r) => [r.index, r.title])).toEqual([
      [1, "A"], [2, "B"], [3, COMFORT_RESULTS[0].title], [4, COMFORT_RESULTS[1].title], [5, COMFORT_RESULTS[2].title], [6, COMFORT_RESULTS[3].title],
    ]);
  });

  it("each cited result becomes one source evidence item with its real link, quoting its snippet verbatim", () => {
    const r = run([
      { topic: "all-day comfort", assessment: "positive", summary: "RunRepeat and Runner's World find it comfortable all day.", citations: [{ result: 1, quote: "Comfortable for long days on your feet" }, { result: 2, quote: "happily wore all day" }] },
    ]);
    expect(r.status).toBe("pass");
    expect(r.evidence).toHaveLength(2);
    expect(r.evidence[0]).toMatchObject({ kind: "source", url: "https://runrepeat.com/nike-pegasus-40", sourceType: "independent_review", observedOn: "2026-11-14", quote: "Comfortable for long days on your feet" });
    expect(r.evidence[1]).toMatchObject({ url: "https://www.runnersworld.com/uk/nike-pegasus-40", quote: "happily wore all day" });
    expect((r.details as ComfortDetails).priorities[0]).toMatchObject({ priority: "all-day comfort", summary: "RunRepeat and Runner's World find it comfortable all day.", evidenceIds: ["ev_comf_1", "ev_comf_2"] });
  });

  it("takes the site from displayed_link when SerpApi links through a Google redirect", () => {
    expect(resultDomain({ link: "https://www.google.com/goto?url=CAES", displayed_link: "https://runbryanrun.com › 2023-hoka-clifton-9-review" })).toBe("runbryanrun.com");
    expect(resultDomain({ link: "https://www.google.co.uk/goto?url=CAES", displayed_link: "https://www.runnersworld.com › uk › gear" })).toBe("runnersworld.com");
    expect(resultDomain({ link: "https://www.google.com/goto?url=CAES", displayed_link: "30+ reactions", source: "zone2.uk" })).toBe("zone2.uk");
    expect(resultDomain({ link: "https://www.google.com/goto?url=CAES", displayed_link: "30+ reactions", source: "Facebook · A Runner" })).toBe("");
    expect(resultDomain({ link: "https://runrepeat.com/x" })).toBe("runrepeat.com");
    const r = run([{ topic: "all-day comfort", assessment: "positive", summary: "x", citations: [{ result: 1, quote: "" }, { result: 6, quote: "softens after a few runs" }] }]);
    expect(r.evidence[1]).toMatchObject({ url: "https://www.google.com/goto?url=CAESabc", domain: "believeintherun.com", sourceType: "independent_review", quote: "softens after a few runs" });
    expect(r.status).toBe("pass"); // a redirect is never mistaken for google.com (a "retailer")
  });

  it("a result with no known site is only what the model says it is, and never merges with another", () => {
    const anon = (index: number): WebResult => ({ index, title: "Post", link: "https://www.google.com/goto?url=x" + index, domain: "", snippet: "Comfy all day." });
    const parsed = comfortFromSummary({ points: [{ topic: "all-day comfort", assessment: "positive", summary: "x", citations: [{ result: 1, quote: "" }, { result: 2, quote: "" }] }], sourceTypes: [{ result: 1, type: "independent_review" }] }, [anon(1), anon(2)], priorities);
    expect(parsed.priorities[0].sources.map((x) => [x.domain, x.sourceType])).toEqual([["result-1", "independent_review"], ["result-2", "other"]]);
    const r = comfortResult(parsed, { today: "2026-11-14", features: [] });
    expect(r.evidence[0]).not.toHaveProperty("domain");
  });

  it("a quote that isn't in the snippet is replaced by the snippet itself (no invented quotes)", () => {
    expect(verifiedQuote(results[0], "the most comfortable shoe ever made")).toBe(results[0].snippet);
    expect(verifiedQuote(results[0], "“Comfortable for long days”")).toBe("Comfortable for long days");
  });

  it("drops citations of results that don't exist and topics that aren't priorities", () => {
    const parsed = comfortFromSummary(
      { points: [{ topic: "all-day comfort", assessment: "positive", summary: "x", citations: [{ result: 9, quote: "" }] }, { topic: "style", assessment: "positive", summary: "x", citations: [{ result: 1, quote: "" }] }], sourceTypes: [] },
      results,
      priorities,
    );
    expect(parsed.priorities).toEqual([]);
  });

  it("warns with fewer than 2 independent sources; manufacturer and retailer claims alone never pass", () => {
    expect(run([{ topic: "all-day comfort", assessment: "positive", summary: "x", citations: [{ result: 1, quote: "" }, { result: 3, quote: "" }] }]).status).toBe("warn");
    const r = run([{ topic: "all-day comfort", assessment: "positive", summary: "x", citations: [{ result: 3, quote: "" }, { result: 5, quote: "" }] }]);
    expect(r.status).toBe("warn");
    expect(r.evidence.map((e) => e.sourceType)).toEqual(["manufacturer", "retailer"]);
  });

  it("uses the model's source type only for unknown domains", () => {
    const blog: WebResult = { index: 1, title: "Blog", link: "https://someblog.net/review", domain: "someblog.net", snippet: "Comfy." };
    const parsed = comfortFromSummary({ points: [{ topic: "all-day comfort", assessment: "positive", summary: "x", citations: [{ result: 1, quote: "" }] }], sourceTypes: [{ result: 1, type: "independent_review" }] }, [blog], priorities);
    expect(parsed.priorities[0].sources[0].sourceType).toBe("independent_review");
  });

  it("warns on a negative priority and is unknown when nothing is cited", () => {
    expect(run([{ topic: "wide fit", assessment: "negative", summary: "Narrow toe box.", citations: [{ result: 4, quote: "the toe box is a bit narrow" }, { result: 2, quote: "" }] }]).summary).toMatch(/wide fit/);
    expect(run([{ topic: "wide fit", assessment: "unclear", summary: "Not sure.", citations: [] }]).status).toBe("unknown");
  });

  it("passes review sizing advice through details", () => {
    const r = run([
      { topic: "all-day comfort", assessment: "positive", summary: "Comfortable.", citations: [{ result: 1, quote: "" }, { result: 2, quote: "" }] },
      { topic: "sizing", sizing: "true_to_size", summary: "RunRepeat says it fits true to size.", citations: [{ result: 1, quote: "fits true to size" }] },
    ]);
    expect(r.details).toMatchObject({ reviewSizing: "true_to_size", reviewSizingNote: "RunRepeat says it fits true to size." });
  });

  it("snippet fallback caps confidence at 0.6", () => {
    const r = comfortFromSnippets(fixtureReference().reviews, needs, "2026-11-14");
    expect(r.status).toBe("pass");
    expect(r.confidence).toBeLessThanOrEqual(0.6);
    expect((r.details as { fallback: boolean }).fallback).toBe(true);
    expect(comfortFromSnippets([], needs, "2026-11-14").status).toBe("unknown");
  });
});

describe("comfort web search client", () => {
  it("queries SerpApi google with UK results and caches per model for 7 days", async () => {
    const store = new MemoryStore(fixtureReference());
    let now = new Date("2026-11-14T12:00:00Z");
    const urls: URL[] = [];
    const { client, requests } = fakeWebSearch({
      store,
      now: () => now,
      fetch: async (url) => {
        urls.push(new URL(url));
        return { ok: true, status: 200, json: async () => ({ organic_results: COMFORT_RESULTS }) };
      },
    });
    const q = comfortQuery("Nike", "Pegasus 40");
    expect(q).toBe("Nike Pegasus 40 review comfort");
    const first = await client.search(q);
    expect(first).toMatchObject({ fromCache: false, fetchedOn: "2026-11-14" });
    expect(first.results).toHaveLength(6);
    expect(Object.fromEntries(urls[0].searchParams)).toMatchObject({ engine: "google", q, gl: "uk", google_domain: "google.co.uk" });
    now = new Date("2026-11-20T12:00:00Z");
    expect(await client.search(q)).toMatchObject({ fromCache: true, fetchedOn: "2026-11-14" });
    now = new Date("2026-11-21T12:00:01Z");
    expect(await client.search(q)).toMatchObject({ fromCache: false, fetchedOn: "2026-11-21" });
    expect(requests).toEqual([q, q]);
  });

  it("falls back to saved review snippets when the search fails, and never offers Gemini's search tool", async () => {
    const gemini = { calls: 0 };
    const base = { model: { brand: "Nike", name: "Pegasus 40" }, needs, today: "2026-11-14", combinedTools: false, executors: {}, snippets: fixtureReference().reviews };
    const down = fakeWebSearch({ fetch: async () => ({ ok: false, status: 403, json: async () => ({}) }) }).client;
    const r = await checkComfort({ ...base, webSearch: down, gemini: { generate: async () => { gemini.calls++; throw new Error("unused"); } } as never });
    expect(r.details).toMatchObject({ fallback: true });
    expect(gemini.calls).toBe(0);
    const empty = fakeWebSearch({ results: [] }).client;
    expect((await checkComfort({ ...base, webSearch: empty, gemini: {} as never })).details).toMatchObject({ fallback: true });
  });
});

describe("condition: outsole or heel not visible", () => {
  const facts = { platform: "ebay" as const, photoCount: 4, conditionClaims: ["Pre-owned - Good"], evidence: [] };
  const needs = { sizes: [], priorities: [], wearTolerance: "light" as const, extraPriorities: [], assumptions: [] };
  const run = (notVisible: string[]) => finaliseCondition({ findings: [], notVisible, modelContradictions: [], facts, needs, photosChecked: 4 });

  it("caps confidence at 0.5 and records the hidden sole areas", () => {
    const r = run(["outsole", "heel tread", "insole"]);
    expect(r.confidence).toBe(0.5);
    expect(r.details).toMatchObject({ soleNotVisible: ["outsole", "heel tread"] });
    expect(run(["insole", "size label"]).confidence).toBeGreaterThan(0.5); // insoles don't count
  });

  it("always generates a seller question for those photos, whatever the verdict", () => {
    const condition = run(["outsole", "heel tread"]);
    for (const label of ["hidden_gem", "proceed_with_caution", "wrong_fit", "not_enough_evidence"] as const) {
      const gaps = computeGaps({ checks: [condition], leads: [], label, answered: ["condition"] });
      expect(gaps.map((g) => g.id), label).toContain("gap_sole_photos");
      expect(gaps.find((g) => g.id === "gap_sole_photos")!.ask).toMatch(/outsole, heel tread/);
    }
    // Still asked when three other questions are open.
    const busy = computeGaps({
      checks: [
        { ...condition },
        { check: "identify", status: "warn", summary: "", evidence: [], confidence: 0.5, geminiFeatures: [] },
        { check: "fit", status: "unknown", summary: "", evidence: [], confidence: 0, geminiFeatures: [], details: { listed: null, match: null } },
        { check: "price", status: "warn", summary: "", evidence: [], confidence: 0.5, geminiFeatures: [], details: { position: "suspiciously_low" } },
      ],
      leads: [],
      label: "proceed_with_caution",
      answered: [],
    });
    expect(busy).toHaveLength(3);
    expect(busy.map((g) => g.id)).toContain("gap_sole_photos");
  });
});
