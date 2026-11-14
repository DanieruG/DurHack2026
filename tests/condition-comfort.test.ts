import { describe, expect, it } from "vitest";
import { conditionStatus, finaliseCondition, gradeFromClaims, wireToFindings } from "@/pipeline/checks/condition";
import { comfortFromPoints, comfortFromSnippets, comfortResult } from "@/pipeline/checks/comfort";
import { resolveSegment, supportedSegments } from "@/gemini/groundedSearch";
import { classifySource, groundingSources, sourceDomain } from "@/gemini/grounding";
import type { ConditionFinding, ListingFacts, UserNeeds } from "@/schemas/domain";
import { fixtureReference, grounded } from "./helpers";

const f = (severity: ConditionFinding["severity"], confidence = 0.8): ConditionFinding => ({ label: "outsole_wear", photoIndex: 0, box2d: [1, 2, 3, 4], severity, confidence, note: "", evidenceId: "ev_cond_1" });
const needs: UserNeeds = { sizes: [], priorities: ["all-day comfort", "wide fit"], wearTolerance: "light", extraPriorities: [], assumptions: [] };

describe("condition status", () => {
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
      { findings: [
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
    const [x] = wireToFindings({ findings: [{ label: "discolouration", photoIndex: 0, box2d: [0, 0, 10, 10], severity: "minor", confidence: 0.4, note: "maybe a shadow" }], notVisible: [], contradictions: [] }, [0]);
    const r = finaliseCondition({ findings: [x], notVisible: [], modelContradictions: [], facts: { platform: "other", photoCount: 1, conditionClaims: [], evidence: [] }, needs, photosChecked: 1 });
    expect(r.evidence[0].label).toMatch(/^Possible discolouration/);
  });
});

describe("grounding + comfort", () => {
  it("classifies sources by domain; model hints never upgrade manufacturer/retailer", () => {
    expect(classifySource("runrepeat.com")).toBe("independent_review");
    expect(classifySource("nike.com", "independent_review")).toBe("manufacturer");
    expect(classifySource("sportsshoes.com")).toBe("retailer");
    expect(classifySource("someblog.net", "independent_review")).toBe("independent_review");
    expect(classifySource("someblog.net")).toBe("other");
    expect(sourceDomain({ uri: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc", title: "www.runnersworld.com" })).toBe("runnersworld.com");
  });
  it("keeps the exact segment each source supports", () => {
    const g = grounded([["PRIORITY | comfort | positive | Very comfy.", ["runrepeat.com"]]]);
    expect(groundingSources(g.groundingMetadata)[0].segments).toEqual(["PRIORITY | comfort | positive | Very comfy."]);
  });
  type Point = { text: string; domains: string[]; topic: string; assessment?: "positive" | "negative" | "mixed" | "unclear"; sizing?: "runs_small" | "runs_large" | "true_to_size" | "unclear" };
  const run = (ps: Point[]) => {
    const g = grounded(ps.map((p) => [p.text, p.domains] as [string, string[]]));
    const segs = supportedSegments(g.groundingMetadata);
    const points = { points: ps.map((p) => ({ segment: segs.find((s) => s.text === p.text)?.id ?? "S99", topic: p.topic, assessment: p.assessment, sizing: p.sizing })), sourceTypes: [] };
    return comfortResult(comfortFromPoints(points, segs, ["all-day comfort", "wide fit"]), { today: "2026-11-14", features: ["search_grounding"] });
  };
  it("passes with >= 2 independent sources and positive priorities; quotes the cited sentence", () => {
    const r = run([{ text: "RunRepeat and Runner's World find it comfortable all day.", domains: ["runrepeat.com", "runnersworld.com"], topic: "all-day comfort", assessment: "positive" }]);
    expect(r.status).toBe("pass");
    expect(r.evidence).toHaveLength(2);
    expect(r.evidence[0]).toMatchObject({ kind: "source", sourceType: "independent_review", observedOn: "2026-11-14", quote: "RunRepeat and Runner's World find it comfortable all day." });
  });
  it("warns with fewer than 2 independent sources; manufacturer claims alone never pass", () => {
    expect(run([{ text: "Comfortable.", domains: ["runrepeat.com", "nike.com"], topic: "all-day comfort", assessment: "positive" }]).status).toBe("warn");
    expect(run([{ text: "Comfortable.", domains: ["nike.com"], topic: "all-day comfort", assessment: "positive" }]).status).toBe("warn");
  });
  it("warns on a negative priority and is unknown with no sources", () => {
    expect(run([{ text: "The toe box is narrow.", domains: ["runrepeat.com", "runnersworld.com"], topic: "wide fit", assessment: "negative" }]).summary).toMatch(/wide fit/);
    expect(run([{ text: "Not sure.", domains: [], topic: "wide fit", assessment: "unclear" }]).status).toBe("unknown");
  });
  it("drops points that cite no real sentence or an unknown topic (attribution stays exact)", () => {
    const g = grounded([["Comfortable all day.", ["runrepeat.com", "runnersworld.com"]]]);
    const segs = supportedSegments(g.groundingMetadata);
    const parsed = comfortFromPoints({ points: [{ segment: "S7", topic: "all-day comfort", assessment: "positive" }, { segment: "S1", topic: "style", assessment: "positive" }], sourceTypes: [] }, segs, ["all-day comfort"]);
    expect(parsed.priorities).toEqual([]);
  });
  it("passes review sizing advice through details", () => {
    const r = run([
      { text: "Comfortable.", domains: ["runrepeat.com", "runnersworld.com"], topic: "all-day comfort", assessment: "positive" },
      { text: "Size up half.", domains: ["runrepeat.com"], topic: "sizing", sizing: "runs_small" },
    ]);
    expect(r.details).toMatchObject({ reviewSizing: "runs_small", reviewSizingNote: "Size up half." });
  });
  it("snippet fallback caps confidence at 0.6", () => {
    const r = comfortFromSnippets(fixtureReference().reviews, needs, "2026-11-14");
    expect(r.status).toBe("pass");
    expect(r.confidence).toBeLessThanOrEqual(0.6);
    expect((r.details as { fallback: boolean }).fallback).toBe(true);
    expect(comfortFromSnippets([], needs, "2026-11-14").status).toBe("unknown");
  });
});

describe("comfort structuring: sentence references", () => {
  it("accepts the sentence id or the sentence text echoed back", () => {
    const g = grounded([["Comfortable all day, says RunRepeat.", ["runrepeat.com", "runnersworld.com"]], ["Runs half a size small.", ["runrepeat.com"]]]);
    const segs = supportedSegments(g.groundingMetadata);
    expect(resolveSegment(segs, "S2")?.text).toBe("Runs half a size small.");
    expect(resolveSegment(segs, "Comfortable all day, says RunRepeat.")?.id).toBe("S1");
    expect(resolveSegment(segs, "S1: Comfortable all day, says RunRepeat. (sources: runrepeat.com, runnersworld.com)")?.id).toBe("S1");
    expect(resolveSegment(segs, "Something the search never said.")).toBeUndefined();
  });
});
