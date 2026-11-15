import { describe, expect, it } from "vitest";
import type { GeminiClient, GenRequest } from "@/gemini/client";
import { askBaseline, BASELINE_PROMPT, baselineModelName, baselineParts, baselineRun, buyerLine, type BaselineAnswer } from "@/eval/baseline";
import { EVAL_PROFILE, type CaseRun } from "@/eval/collect";
import { EMPTY_LABEL, type Label } from "@/eval/labels";
import { summarise } from "@/eval/metrics";
import { better, compare, comparisonMarkdown, reportMarkdown, slideMarkdown } from "@/eval/report";
import { fraction, spread } from "@/eval/metrics";
import { PNG } from "./helpers";

const IMG = { bytes: PNG, mimeType: "image/png" as const };
const ANSWER: BaselineAnswer = {
  brand: "Nike",
  model: "Pegasus",
  version: "40",
  styleCode: "DV3853-001",
  colours: ["black", "white"],
  size: { kind: "single", value: "9", system: "UK" },
  defects: [
    { photo: 2, description: "heel wear", box_2d: [500, 600, 300, 400] },
    { photo: 9, description: "on a photo that doesn't exist", box_2d: [0, 0, 10, 10] },
  ],
  recommendation: "worth_a_look",
  reason: "Looks fine.",
};
const LABEL: Label = {
  ...EMPTY_LABEL,
  listingShowsModel: true,
  brand: "Nike",
  model: "Pegasus",
  version: "40",
  styleCode: { value: "DV3853-001", visible: true },
  size: { value: 9, system: "UK" },
  defects: { "2": [{ label: "heel_wear", box2d: [300, 400, 500, 600] }] },
  expectedVerdict: "worth_a_look",
};
const META = { runAt: "2026-11-15T10:00:00.000Z", pipelineVersion: "3", models: { fast: "flash-x", strong: "pro-x" }, cacheMode: "off" };

function fakeGemini(texts: string[]) {
  const reqs: GenRequest[] = [];
  const gemini: GeminiClient = {
    async generate(req) {
      reqs.push(req);
      return { text: texts[reqs.length - 1] ?? "", functionCalls: [], model: "flash-x", cached: false };
    },
  };
  return { gemini, reqs };
}

describe("baseline: one plain Gemini call", () => {
  it("sends the plain prompt, the buyer's profile, the page text and every photo in order, and nothing else", () => {
    const parts = baselineParts({ pageText: "Nike Pegasus 40\nUK 9", images: [IMG, IMG], profile: EVAL_PROFILE });
    const first = parts[0].text as string;
    expect(first.startsWith(BASELINE_PROMPT)).toBe(true);
    expect(first).toContain("About me: My usual size is UK 9; I care about all-day comfort; light wear is fine.");
    expect(first).toContain("Nike Pegasus 40\nUK 9");
    expect(parts.slice(1).map((p) => p.text ?? "image")).toEqual(["Photo 1:", "image", "Photo 2:", "image"]);
    expect(buyerLine({ ...EVAL_PROFILE, defaultSize: undefined, priorities: [], wearTolerance: "none" })).toBe("About me: I don't want any wear.");
  });

  it("is one fast-tier call with structured output: no system prompt, no tools, no search", async () => {
    const { gemini, reqs } = fakeGemini([JSON.stringify(ANSWER)]);
    const r = await askBaseline(gemini, { pageText: "t", images: [IMG], profile: EVAL_PROFILE });
    expect(r).toMatchObject({ answer: ANSWER, calls: 1 });
    expect(reqs).toHaveLength(1);
    expect(reqs[0].tier).toBe("fast");
    expect(reqs[0].config?.systemInstruction).toBeUndefined();
    expect(reqs[0].config?.tools).toBeUndefined();
    expect(reqs[0].config?.responseMimeType).toBe("application/json");
    expect(JSON.stringify(reqs[0].config?.responseJsonSchema)).toContain("recommendation");
  });

  it("counts a retry after a malformed answer, and reports a failure as an error", async () => {
    const retried = await askBaseline(fakeGemini(["not json", JSON.stringify(ANSWER)]).gemini, { pageText: "t", images: [], profile: EVAL_PROFILE });
    expect(retried.calls).toBe(2);
    const failed = await askBaseline(fakeGemini(["no", "still no"]).gemini, { pageText: "t", images: [], profile: EVAL_PROFILE });
    expect(failed).toMatchObject({ answer: null, calls: 2 });
    expect(failed.error).toMatch(/Invalid structured output/);
  });
});

describe("baseline answers are scored like Sleuth's", () => {
  it("maps the answer into the fields the scoring reads", () => {
    const run = baselineRun("ebay-1", LABEL, { answer: ANSWER, durationMs: 5000, calls: 1 }, 3);
    expect(run).toMatchObject({ tier: "model", brand: "Nike", modelName: "Pegasus 40", styleCode: "DV3853-001", colours: ["black", "white"], verdict: "worth_a_look", geminiCalls: 1 });
    expect(run.size).toEqual({ text: "UK 9", system: "UK", options: null });
    // Box corners put in order; defects on photos the case doesn't have are dropped.
    expect(run.findings).toEqual([{ photo: 2, label: "heel wear", box2d: [300, 400, 500, 600] }]);
    expect(baselineRun("x", LABEL, { answer: { ...ANSWER, size: { kind: "multiple", value: null, system: "UK" } }, durationMs: 1, calls: 1 }, 1).size).toEqual({ text: null, system: "UK", options: { system: "UK" } });
    expect(baselineRun("x", LABEL, { answer: null, durationMs: 1, calls: 2, error: "boom" }, 1)).toMatchObject({ tier: "none", error: "boom" });
  });

  it("joins model and version without repeating it", () => {
    expect(baselineModelName("Pegasus", "40")).toBe("Pegasus 40");
    expect(baselineModelName("Pegasus 40", "40")).toBe("Pegasus 40");
    expect(baselineModelName("Samba OG", "none")).toBe("Samba OG");
    expect(baselineModelName(null, "40")).toBeNull();
  });

  it("the same answer scores the same whichever system gave it (one scoring code)", () => {
    const b = baselineRun("ebay-1", LABEL, { answer: ANSWER, durationMs: 5000, calls: 1 }, 3);
    const sleuthLike: CaseRun = { ...b, tier: "catalogue", findings: [{ photo: 2, label: "heel_wear", box2d: [300, 400, 500, 600] }] };
    const sb = summarise([b], META);
    const ss = summarise([sleuthLike], META);
    for (const id of ["brandAccuracy", "modelIdentification", "versionAccuracy", "styleCodeRead", "fitAccuracy", "defectDetection", "falseAlarms", "verdict"]) {
      const f = (s: typeof sb) => s.sections.flatMap((x) => x.figures).find((x) => x.id === id)!.figure;
      expect(f(sb)).toEqual(f(ss));
    }
    expect(sb.labelsHash).toBe(ss.labelsHash);
  });
});

describe("side-by-side report", () => {
  it("decides 'better' on exact fractions, lower is better for false alarms and time", () => {
    expect(better(fraction("x", 2, 3), fraction("x", 3, 5))).toBe("baseline"); // 66.7% vs 60%
    expect(better(fraction("x", 2, 4), fraction("x", 1, 2))).toBe("tie");
    expect(better(fraction("x", 1, 4, false), fraction("x", 1, 2, false))).toBe("baseline");
    expect(better(fraction("x", 0, 0), fraction("x", 1, 2))).toBeNull();
    expect(better(spread("t", [9000], "seconds"), spread("t", [40000], "seconds"))).toBe("baseline");
  });

  it("puts both systems' raw fractions side by side, names where the baseline wins, and flags mismatched runs", () => {
    const sleuthRun = baselineRun("ebay-1", LABEL, { answer: { ...ANSWER, styleCode: null }, durationMs: 40_000, calls: 8 }, 3);
    const baseRun = baselineRun("ebay-1", LABEL, { answer: ANSWER, durationMs: 6_000, calls: 1 }, 3);
    const s = { ...summarise([sleuthRun], META), system: "sleuth" as const };
    const b = { ...summarise([baseRun], { ...META, pipelineVersion: "baseline" }), system: "baseline" as const };
    const c = compare(s, b);
    expect(c.stale).toBeNull();
    expect(c.rows.find((r) => r.name === "Style code read (when visible)")).toEqual({ name: "Style code read (when visible)", baseline: "1 of 1 (100%)", sleuth: "0 of 1 (0%)", better: "baseline" });
    expect(c.baselineWins).toEqual(["Style code read (when visible)", "Time per case", "Gemini calls per case"]);
    const md = comparisonMarkdown(s, b).join("\n");
    expect(md).toContain("| Metric | Baseline (one Gemini call) | Sleuth | Better |");
    expect(md).toContain(BASELINE_PROMPT);
    expect(md).toContain("**Where the baseline does better: Style code read (when visible), Time per case, Gemini calls per case.**");
    expect(reportMarkdown(s, [], b)).toContain("## Baseline failure cases");
    expect(slideMarkdown(s, b)).toContain("| Sleuth vs pasting the listing into a chatbot | Chatbot (one Gemini call) | Sleuth |");
    expect(reportMarkdown(s, [])).toContain("Not run yet: npm run eval:baseline.");

    const relabelled = { ...b, labelsHash: "different" };
    expect(comparisonMarkdown(s, relabelled).join("\n")).toContain("Not comparable yet: the labels changed between the two runs");
  });
});
