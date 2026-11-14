import { describe, expect, it } from "vitest";
import { createCase } from "@/pipeline";
import { caseDetail } from "@/pipeline/views";
import { actualFeatures } from "@/pipeline/util";
import { checkTags, geminiTag, runTotals, stepTags } from "@/extension/src/lib/tags";
import { applyEvent, newInvestigation } from "@/extension/src/lib/progress";
import type { CheckResult } from "@/schemas/domain";
import { checksFrom, fakeNewPrices, json, makeDeps, PAGE_TEXT, PROFILE, shoppingFixture } from "./helpers";

describe("tags: formatting", () => {
  it("Gemini feature tags", () => {
    expect(geminiTag(["vision", "object_detection", "structured_output"])).toBe("Gemini vision · object detection");
    expect(geminiTag(["structured_output", "function_calling"])).toBe("Gemini · function calling");
    expect(geminiTag(["structured_output"])).toBe("Gemini");
    expect(geminiTag([])).toBeNull();
  });
  it("steps: nothing without a Gemini call; cached when every call was a cache hit", () => {
    expect(stepTags({ geminiFeatures: ["vision"], geminiCalls: 0 })).toEqual([]);
    expect(stepTags({ geminiFeatures: ["vision", "structured_output"], geminiCalls: 1, cachedCalls: 0 })).toEqual(["Gemini vision"]);
    expect(stepTags({ geminiFeatures: ["vision", "structured_output"], geminiCalls: 2, cachedCalls: 2 })).toEqual(["Gemini vision", "cached"]);
  });
  it("exhibits: a cached search shows 'cached', not a search tag", () => {
    const c = (usage: CheckResult["usage"]): Pick<CheckResult, "geminiFeatures" | "usage"> => ({ geminiFeatures: ["structured_output"], usage });
    expect(checkTags(c({ geminiCalls: 1, cachedCalls: 0, search: { kind: "web", live: true } }))).toEqual(["Gemini", "Web search"]);
    expect(checkTags(c({ geminiCalls: 1, cachedCalls: 0, search: { kind: "web", live: false } }))).toEqual(["Gemini", "cached"]);
    expect(checkTags({ geminiFeatures: [], usage: { geminiCalls: 0, cachedCalls: 0, search: { kind: "shopping", live: true } } })).toEqual(["Google Shopping"]);
    expect(checkTags({ geminiFeatures: [], usage: { geminiCalls: 0, cachedCalls: 0, search: { kind: "shopping", live: false } } })).toEqual(["cached"]);
  });
  it("run totals", () => {
    expect(runTotals({ durationMs: 11400, geminiCalls: 7 })).toBe("7 Gemini calls · 11.4s");
    expect(runTotals({ durationMs: 900, geminiCalls: 1, cachedCalls: 1 })).toBe("1 Gemini call (1 cached) · 0.9s");
  });
  it("actual features: function_calling only when Gemini called a tool", () => {
    expect(actualFeatures(["function_calling", "structured_output"], { geminiCalls: 1, cachedCalls: 0, functionCalls: 0 })).toEqual(["structured_output"]);
    expect(actualFeatures(["structured_output"], { geminiCalls: 2, cachedCalls: 0, functionCalls: 1 })).toEqual(["structured_output", "function_calling"]);
    expect(actualFeatures(["vision"], { geminiCalls: 0, cachedCalls: 0, functionCalls: 0 })).toEqual([]);
  });
});

describe("tags: what the pipeline reports", () => {
  const run = async (handlers = {}, extra = {}) => {
    const deps = makeDeps({ handlers, shopping: { "Nike Pegasus 40": shoppingFixture("nike-pegasus-40") }, ...extra });
    const { caseId, done } = await createCase(deps, { capture: { pageText: PAGE_TEXT, imageUrls: ["https://img.example.com/1.jpg"] }, profile: PROFILE, screenshots: [] });
    await done;
    return { deps, caseId, events: deps.hub.events(caseId) };
  };
  const stageDone = (events: { event: string; data: unknown }[], stage: string) =>
    events.filter((e) => e.event === "stage_done" && (e.data as { stage: string }).stage === stage).map((e) => e.data as { geminiFeatures?: string[]; geminiCalls?: number });

  it("each stage reports the features it used and its call count; checks carry usage", async () => {
    const { events, deps, caseId } = await run();
    expect(stageDone(events, "condition")[0]).toMatchObject({ geminiFeatures: ["vision", "object_detection", "structured_output"], geminiCalls: 1 });
    expect(stageDone(events, "fit")[0]).toMatchObject({ geminiFeatures: [], geminiCalls: 0 });
    const checks = checksFrom(events);
    expect(checks.comfort.usage).toEqual({ geminiCalls: 1, cachedCalls: 0, search: { kind: "web", live: true } });
    expect(checks.fit.usage).toEqual({ geminiCalls: 0, cachedCalls: 0 });
    expect(checks.identify.usage).toEqual({ geminiCalls: 1, cachedCalls: 0 });
    const detail = await caseDetail(deps, (await deps.store.getCase(caseId))!, "http://x.test");
    expect(detail.run).toMatchObject({ geminiCalls: expect.any(Number), durationMs: expect.any(Number) });
    // The log shows them.
    let s = newInvestigation(1, 0);
    for (const e of events) s = applyEvent(s, { name: e.event, data: e.data, revision: e.revision, at: 1 });
    expect(s.log.find((l) => l.key === "condition")?.tags).toEqual(["Gemini vision · object detection"]);
    expect(s.log.find((l) => l.key === "comfort")?.tags).toEqual(["Gemini", "Web search"]);
    expect(s.totals?.geminiCalls).toBe(detail.run?.geminiCalls);
  });

  it("leads: function calling is tagged only when Gemini actually called a tool", async () => {
    const weak = { comfort: () => json({ points: [], sourceTypes: [] }) };
    const without = await run({ ...weak, leads: () => json({ leads: [] }) });
    expect(stageDone(without.events, "leads")[0]?.geminiFeatures).toEqual(["structured_output"]);
    const withTool = await run({
      ...weak,
      leads: (req: { contents: unknown[] }) => (req.contents.length === 1 ? { text: "", functionCalls: [{ id: "f1", name: "convertSize", args: { brand: "Nike", size: 9, system: "UK" } }] } : json({ leads: [] })),
    });
    expect(stageDone(withTool.events, "leads")[0]?.geminiFeatures).toEqual(["structured_output", "function_calling"]);
  });

  it("a Shopping answer from the 24-hour cache is reported as not live", async () => {
    const { client } = fakeNewPrices({ "Nike Pegasus 40": shoppingFixture("nike-pegasus-40") });
    expect((await client.getNewPrices("Pegasus 40", "Nike")).fromCache).toBe(false);
    expect((await client.getNewPrices("Pegasus 40", "Nike")).fromCache).toBe(true);
  });
});
