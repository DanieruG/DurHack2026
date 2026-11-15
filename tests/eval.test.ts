import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { fraction, iou, matchBoxes, median, nameMatch, OVERLAP_THRESHOLD, sizeAgrees, spread, summarise } from "@/eval/metrics";
import { EMPTY_LABEL, LabelSchema, missingFields, missingLabelsMarkdown, readLabels, updateLabellingDoc, type Label } from "@/eval/labels";
import { reportMarkdown, slideMarkdown } from "@/eval/report";
import { EVAL_PROFILE, runCase, type CaseRun } from "@/eval/collect";
import { redact } from "@/lib/redact";
import { loadPublicEvalSummary } from "@/lib/evalSummary";
import { EvalSummarySchema, fractionText, honestLine, spreadText } from "@/schemas/eval";
import { makeDeps, PAGE_TEXT } from "./helpers";

const label = (over: Partial<Label> = {}): Label => ({ ...EMPTY_LABEL, ...over });
const run = (id: string, over: Partial<CaseRun> = {}): CaseRun => ({
  id,
  label: EMPTY_LABEL,
  tier: "catalogue",
  brand: "Nike",
  modelName: "Pegasus 40",
  styleCode: null,
  colours: null,
  size: { text: null, system: null, options: null },
  findings: [],
  offers: [],
  verdict: null,
  durationMs: 40_000,
  geminiCalls: 8,
  ...over,
});
const META = { runAt: "2026-11-15T10:00:00.000Z", pipelineVersion: "3", models: { fast: "flash-x", strong: "pro-x" }, cacheMode: "off" };

describe("figures never round in Sleuth's favour", () => {
  it("higher-is-better rounds down, lower-is-better rounds up, and the raw fraction is always shown", () => {
    expect(fraction("x", 17, 20)).toMatchObject({ percent: 85 });
    expect(fractionText(fraction("Model identified correctly", 17, 20))).toBe("17 of 20 (85%)");
    expect(fraction("x", 2, 3).percent).toBe(66); // 66.7 down
    expect(fraction("x", 1, 3, false).percent).toBe(34); // 33.3 up, for false alarms
    expect(fraction("x", 29, 100).percent).toBe(29); // integer arithmetic, not 28.999
    expect(fraction("x", 0, 0)).toMatchObject({ percent: null });
    expect(fractionText(fraction("x", 0, 0))).toBe("not measured yet (0 labelled)");
  });

  it("times: median and slowest, rounded up to a tenth of a second, with the case count", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    const s = spread("Time per case", [41_210, 39_000, 58_001], "seconds");
    expect(s).toMatchObject({ median: 41.3, max: 58.1, n: 3 });
    expect(spreadText(s)).toBe("median 41.3 s, slowest 58.1 s (3 cases)");
    expect(spreadText(spread("Gemini calls per case", [7, 9, 8, 12], "calls"))).toBe("median 8.5, mean 9.0, most 12 (4 cases)");
    expect(spreadText(spread("t", [], "seconds"))).toBe("not measured yet (0 cases)");
  });
});

describe("defect boxes", () => {
  it("overlap is intersection over union", () => {
    expect(iou([0, 0, 100, 100], [0, 0, 100, 100])).toBe(1);
    expect(iou([0, 0, 100, 100], [0, 50, 100, 150])).toBeCloseTo(1 / 3);
    expect(iou([0, 0, 100, 100], [200, 200, 300, 300])).toBe(0);
  });

  it(`a match needs overlap of at least ${OVERLAP_THRESHOLD}, and each box matches once`, () => {
    // 1/3 overlap matches; a box offset by three quarters (1/7) doesn't.
    expect(matchBoxes([[0, 0, 100, 100]], [[0, 50, 100, 150]])).toEqual({ matched: 1, missed: 0, falseAlarms: 0 });
    expect(matchBoxes([[0, 0, 100, 100]], [[0, 75, 100, 175]])).toEqual({ matched: 0, missed: 1, falseAlarms: 1 });
    // Two reported boxes on one marked defect: one match, one false alarm.
    expect(matchBoxes([[0, 0, 100, 100]], [[0, 0, 100, 100], [0, 5, 100, 105]])).toEqual({ matched: 1, missed: 0, falseAlarms: 1 });
    expect(matchBoxes([], [[0, 0, 10, 10]])).toEqual({ matched: 0, missed: 0, falseAlarms: 1 });
  });
});

describe("matching names and sizes with labels", () => {
  const peg = { brand: "Nike", model: "Pegasus", version: "40" };
  it("model: every labelled word appears; version: exactly the words left over", () => {
    expect(nameMatch("Pegasus 40", peg)).toEqual({ model: true, version: true });
    expect(nameMatch("Nike Air Zoom Pegasus 40", { ...peg, model: "Air Zoom Pegasus" })).toEqual({ model: true, version: true });
    expect(nameMatch("Pegasus 41", peg)).toEqual({ model: true, version: false });
    expect(nameMatch("Pegasus", peg)).toEqual({ model: true, version: false });
    expect(nameMatch("Vomero 17", peg)).toEqual({ model: false, version: false });
    expect(nameMatch("P-6000", { brand: "Nike", model: "P-6000", version: "none" })).toEqual({ model: true, version: true });
    expect(nameMatch("Air Jordan 1", { brand: "Nike", model: "Air Jordan 1 Mid", version: "none" }).model).toBe(false);
    expect(nameMatch(null, peg)).toEqual({ model: false, version: false });
  });

  it("size: the value and system as labelled; unknown when the listing doesn't say; a size menu", () => {
    expect(sizeAgrees({ text: "UK 9", system: "UK", options: null }, { value: 9, system: "UK" })).toBe(true);
    expect(sizeAgrees({ text: "9", system: "unknown", options: null }, { value: 9, system: "UK" })).toBe(false); // never assumed
    expect(sizeAgrees({ text: "9", system: "unknown", options: null }, { value: 9, system: "unknown" })).toBe(true);
    expect(sizeAgrees({ text: "US 10", system: "US", options: null }, { value: 9, system: "UK" })).toBe(false);
    expect(sizeAgrees({ text: null, system: null, options: { system: "UK" } }, { value: "multiple", system: "UK" })).toBe(true);
    expect(sizeAgrees({ text: null, system: null, options: null }, { value: "not_stated", system: "unknown" })).toBe(true);
    expect(sizeAgrees({ text: "UK 9", system: "UK", options: null }, { value: "not_stated", system: "unknown" })).toBe(false);
  });
});

describe("summary", () => {
  const runs: CaseRun[] = [
    run("a", {
      label: label({ identifiable: true, brand: "Nike", model: "Pegasus", version: "40", size: { value: 9, system: "UK" }, colourway: ["grey", "white"], defects: { "2": [{ label: "heel_wear", box2d: [0, 0, 100, 100] }], "3": [] }, expectedVerdict: "worth_a_look" }),
      size: { text: "UK 9", system: "UK", options: null },
      colours: ["grey", "white"],
      findings: [
        { photo: 2, label: "Heel wear", box2d: [0, 10, 100, 110] },
        { photo: 3, label: "Creasing", box2d: [0, 0, 50, 50] },
        { photo: 5, label: "Not labelled photo", box2d: [0, 0, 50, 50] },
      ],
      verdict: "worth_a_look",
      durationMs: 30_000,
    }),
    run("b", {
      label: label({ identifiable: true, brand: "Nike", model: "Pegasus", version: "40", size: { value: 9, system: "UK" } }),
      modelName: "Pegasus 41",
      size: { text: "UK 10", system: "UK", options: null },
      proRecheck: { outcome: "disagree", flash: "Nike Pegasus 41", pro: "Nike Pegasus 40" },
      durationMs: 50_000,
    }),
    run("c", { label: label({ identifiable: false, brand: "Adidas" }), tier: "brand", brand: "Adidas", modelName: null, durationMs: 45_000 }),
    run("d", { label: EMPTY_LABEL, error: "boom", durationMs: 0 }), // nothing labelled: in no figure but time and errors
  ];
  const s = summarise(runs, META);
  const fig = (id: string) => s.sections.flatMap((x) => x.figures).find((f) => f.id === id)!.figure;

  it("counts only labelled cases, each figure with its own sample size", () => {
    expect(fractionText(fig("brandAccuracy") as never)).toBe("3 of 3 (100%)");
    expect(fractionText(s.headline.modelIdentification as never)).toBe("2 of 2 (100%)");
    expect(fractionText(fig("versionAccuracy") as never)).toBe("1 of 2 (50%)");
    expect(fractionText(fig("gateRefusal") as never)).toBe("1 of 1 (100%)");
    expect(fractionText(s.headline.fitAccuracy as never)).toBe("1 of 2 (50%)");
    expect(fractionText(fig("colourAll") as never)).toBe("1 of 1 (100%)");
    expect(fractionText(fig("verdict") as never)).toBe("1 of 1 (100%)");
    expect(fractionText(fig("errors") as never)).toBe("1 of 4 (25%)");
  });

  it("condition: marked defects found, and false alarms only on photos that were checked", () => {
    expect(fractionText(s.headline.defectDetection as never)).toBe("1 of 1 (100%)");
    // Photo 2: one match. Photo 3: checked, nothing marked, one reported: a false alarm. Photo 5 wasn't checked.
    expect(fractionText(s.headline.falseAlarms as never)).toBe("1 of 2 (50%)");
    expect(s.overlapThreshold).toBe(OVERLAP_THRESHOLD);
  });

  it("Flash and Pro: how often they disagreed and which was right", () => {
    expect(fractionText(fig("proDisagreement") as never)).toBe("1 of 1 (100%)");
    expect(fractionText(fig("flashRight") as never)).toBe("0 of 1 (0%)");
    expect(fractionText(fig("proRight") as never)).toBe("1 of 1 (100%)");
  });

  it("time over finished cases only; failures name the case", () => {
    expect(spreadText(s.headline.timePerCase as never)).toBe("median 45.0 s, slowest 50.0 s (3 cases)");
    expect(s.failures).toContainEqual({ caseId: "b", metric: "Version", detail: 'labelled Pegasus 40, Sleuth said "Pegasus 41"' });
    expect(s.failures).toContainEqual({ caseId: "b", metric: "Fit", detail: 'labelled UK 9, read "UK 10" (UK)' });
    expect(s.failures).toContainEqual({ caseId: "d", metric: "Error", detail: "boom" });
    expect(EvalSummarySchema.parse(JSON.parse(JSON.stringify(s)))).toEqual(s);
  });

  it("report.md: every metric with sample sizes, the run date, models, PIPELINE_VERSION and failures", () => {
    const md = reportMarkdown(s, [{ id: "d", photos: 3, label: EMPTY_LABEL }]);
    expect(md).toContain("Run 2026-11-15T10:00:00.000Z · 4 labelled listings · PIPELINE_VERSION=3");
    expect(md).toContain("Models: fast=flash-x, strong=pro-x");
    expect(md).toContain("| Version identified correctly | 1 of 2 (50%) |");
    expect(md).toContain(`at least ${OVERLAP_THRESHOLD}`);
    expect(md).toContain("| b | Version | labelled Pegasus 40, Sleuth said \"Pegasus 41\" |");
    expect(md).toContain("| d | 3 | identifiable, brand, model, version, styleCode, colourway, size, conditionGrade | 0 |");
    expect(md).toContain(honestLine(4));
  });

  it("slide.md: the headline figures as a compact table", () => {
    expect(slideMarkdown(s)).toBe(
      [
        "| How accurate is Sleuth? | Result |",
        "| --- | --- |",
        "| Model identified correctly | 2 of 2 (100%) |",
        "| Marked defects found | 1 of 1 (100%) |",
        "| Reported defects that weren't marked (false alarms) | 1 of 2 (50%) |",
        "| Listed size read as labelled | 1 of 2 (50%) |",
        "| Time per case | median 45.0 s, slowest 50.0 s (3 cases) |",
        "",
        "Tested on 4 real listings we labelled by hand. Small sample; results will vary. Tested 2026-11-15 (pipeline v3).",
        "",
      ].join("\n"),
    );
  });
});

describe("labels", () => {
  it("an empty label is all null, and every required field is reported missing", () => {
    expect(Object.values(EMPTY_LABEL).every((v) => v === null)).toBe(true);
    expect(missingFields(EMPTY_LABEL)).toEqual(["identifiable", "brand", "model", "version", "styleCode", "colourway", "size", "conditionGrade"]);
    // An unidentifiable listing needs no model or version.
    expect(missingFields(label({ identifiable: false }))).toEqual(["brand", "styleCode", "colourway", "size", "conditionGrade"]);
  });

  it("rejects labels that aren't in the format (colours, sizes, boxes)", () => {
    expect(LabelSchema.safeParse({ colourway: ["teal"] }).success).toBe(false);
    expect(LabelSchema.safeParse({ size: { value: 9, system: "UK" } }).success).toBe(true);
    expect(LabelSchema.safeParse({ defects: { "1": [{ label: "heel_wear", box2d: [0, 0, 2000, 10] }] } }).success).toBe(false);
  });

  it("every eval case has photos, a label.json in the format, and no invented labels yet", () => {
    const cases = readLabels(path.join(process.cwd(), "eval", "listings"));
    expect(cases.length).toBeGreaterThanOrEqual(12);
    for (const c of cases) {
      expect(c.error).toBeUndefined();
      expect(c.photos).toBeGreaterThan(0);
    }
  });

  it("updates the missing-labels list in LABELLING.md between its markers", () => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "labels-")), "L.md");
    fs.writeFileSync(f, "# Doc\n<!-- missing-labels:start -->\nold\n<!-- missing-labels:end -->\nafter\n");
    const cases = [{ id: "x", photos: 2, label: EMPTY_LABEL }];
    updateLabellingDoc(f, cases);
    const doc = fs.readFileSync(f, "utf8");
    expect(doc).toContain(missingLabelsMarkdown(cases));
    expect(doc).not.toContain("old");
    expect(doc).toContain("Defect boxes: marked on 0 of the 10 photos needed.");
    expect(doc.endsWith("<!-- missing-labels:end -->\nafter\n")).toBe(true);
  });
});

describe("exported eval cases carry no personal details", () => {
  const dir = path.join(process.cwd(), "eval", "listings");
  const ids = fs.readdirSync(dir).filter((d) => !d.startsWith("_") && fs.statSync(path.join(dir, d)).isDirectory());
  it.each(ids)("%s", (id) => {
    const file = JSON.parse(fs.readFileSync(path.join(dir, id, "capture.json"), "utf8"));
    expect(file.profile).toBeUndefined(); // the eval uses its own profile
    const text: string = file.capture.pageText;
    expect(redact(text).text).toBe(text); // nothing left for the redactor to remove
    expect(text).not.toMatch(/\n\(\d[\d,]*\)\n(Message|Private|Business)\n/); // no seller card
    expect(text).not.toMatch(/Verified purchase|eBay automated Feedback/i); // no feedback block
    for (const o of file.capture.observedListings ?? []) expect(Object.keys(o).sort()).toEqual(expect.arrayContaining(["id", "title", "price", "url"]));
  });
});

describe("seller redaction (gaps found while exporting the eval cases)", () => {
  it("drops a business seller's shop name and feedback count, and masks the name elsewhere", () => {
    const t = redact("Nike Revolution 6\nSampleshop Shoes\n(228410)\nMessage\nPrice\n£54.00\nThanks from Sampleshop Shoes").text;
    expect(t).not.toContain("Sampleshop");
    expect(t).not.toContain("228410");
    expect(t).toContain("£54.00");
  });
  it("drops the store after 'Find similar items from', and eBay's feedback block up to the footer", () => {
    const t = redact(
      ["Find similar items from", "Samplejo's style closet", "Nike P-6000", "About this seller", "All ratings", "Past year", "Verified purchase", "Great seller", "Watch (#206500725165)", "Back to search results", "More to explore"].join("\n"),
    ).text;
    expect(t).not.toMatch(/Samplejo|Verified purchase|Great seller|206500725165/);
    expect(t).toContain("Nike P-6000");
    expect(t).toContain("More to explore");
  });
  it("drops a Vinted seller's username, review count and badge", () => {
    const t = redact("Make an offer\nHow you’re covered\nsample_seller_03\n4\nSends items promptly — usually within the next 24 hours.").text;
    expect(t).toBe("Make an offer\nHow you’re covered");
  });
  it("keeps ordinary lines followed by a number", () => {
    expect(redact("Size\n9\nCondition\nVery good").text).toBe("Size\n9\nCondition\nVery good");
  });
});

describe("GET /api/eval/summary data", () => {
  it("serves the figures without the failure list; null before any run or for a broken file", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "evalsum-"));
    const f = path.join(tmp, "summary.json");
    expect(await loadPublicEvalSummary(f)).toBeNull();
    const s = summarise([run("a", { label: label({ brand: "Nike" }) })], META);
    fs.writeFileSync(f, JSON.stringify(s));
    const pub = await loadPublicEvalSummary(f);
    expect(pub).not.toBeNull();
    expect(pub).not.toHaveProperty("failures");
    expect(pub!.headline.modelIdentification).toEqual(s.headline.modelIdentification);
    fs.writeFileSync(f, "{ not json");
    expect(await loadPublicEvalSummary(f)).toBeNull();
  });
});

describe("running one eval case", () => {
  it("runs a labelled case with the eval profile and records what Sleuth said", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "evalcase-"));
    fs.writeFileSync(path.join(dir, "capture.json"), JSON.stringify({ capture: { pageUrl: "https://www.vinted.co.uk/items/123-nike", pageText: PAGE_TEXT, imageUrls: [] } }));
    const deps = makeDeps();
    const r = await runCase(deps, dir, "vinted-123", label({ brand: "Nike" }));
    expect(r.error).toBeUndefined();
    expect(r.tier).toBe("catalogue");
    expect(r.modelName).toBeTruthy();
    expect(r.size.text).toBe("UK 9");
    expect(r.geminiCalls).toBeGreaterThan(0);
    expect(EVAL_PROFILE).toMatchObject({ defaultSize: { size: 9, system: "UK" }, sizes: [] });
  });
});
