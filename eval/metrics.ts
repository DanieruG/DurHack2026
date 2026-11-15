import type { Box2d } from "../schemas/domain";
import type { EvalSummary, Figure, Fraction, HeadlineId, Spread } from "../schemas/eval";
import { brandToken, tokenise } from "../lib/titleMatch";
import { parseSizeText } from "../lib/sizes";
import type { CaseRun } from "./collect";
import { isKnown } from "./labels";
import { createHash } from "node:crypto";

/** A hash of the labels a run was scored against (case ids and labels, in order). */
export const labelsHash = (runs: Pick<CaseRun, "id" | "label">[]) => createHash("sha256").update(JSON.stringify(runs.map((r) => [r.id, r.label]))).digest("hex").slice(0, 16);

/**
 * Eval metrics: pure functions from labelled runs to figures. Every figure carries its sample size. Percentages are
 * whole numbers rounded against Sleuth: down when higher is better, up when lower is better. Times round up.
 */

/** Two boxes match when their intersection over union is at least this (hand boxes are loose, so not 0.5). */
export const OVERLAP_THRESHOLD = 0.3;

const EXACT_TIERS = new Set(["model", "catalogue"]);

export function fraction(label: string, n: number, d: number, higherIsBetter = true): Fraction {
  // Integer arithmetic, so 29 of 100 is 29% and not 28.999...
  const percent = d === 0 ? null : higherIsBetter ? Math.floor((n * 100) / d) : Math.ceil((n * 100) / d);
  return { kind: "fraction", label, n, d, percent, higherIsBetter };
}

const ceil1 = (x: number) => Math.ceil(x * 10 - 1e-9) / 10;

export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function spread(label: string, values: number[], unit: Spread["unit"]): Spread {
  const scale = unit === "seconds" ? (x: number) => ceil1(x / 1000) : (x: number) => x;
  const m = median(values);
  return {
    kind: "spread",
    label,
    unit,
    n: values.length,
    median: m === null ? null : unit === "seconds" ? scale(m) : m,
    max: values.length ? scale(Math.max(...values)) : null,
    mean: values.length ? ceil1(values.reduce((a, b) => a + b, 0) / values.length / (unit === "seconds" ? 1000 : 1)) : null,
  };
}

// ---------- names ----------

const norm = (s: string | null | undefined) => tokenise(s ?? "").join(" ");

export function sameBrand(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && brandToken(a) === brandToken(b);
}

/**
 * Does a predicted model name match the labelled model, and the version too? Model: every word of the labelled model
 * appears in the prediction. Version: the words left over are exactly the labelled version ("none": nothing left).
 */
export function nameMatch(predicted: string | null, label: { brand: string | null; model: string | null; version: string | null }): { model: boolean; version: boolean } {
  if (!predicted || !label.model) return { model: false, version: false };
  const brand = label.brand ? brandToken(label.brand) : "";
  const words = tokenise(predicted).filter((w) => w !== brand);
  const model = tokenise(label.model).filter((w) => w !== brand);
  const modelOk = model.every((w) => words.includes(w));
  if (!modelOk || label.version === null) return { model: modelOk, version: false };
  const rest = words.filter((w) => !model.includes(w)).sort();
  const want = label.version.trim().toLowerCase() === "none" ? [] : tokenise(label.version).sort();
  return { model: true, version: rest.length === want.length && rest.every((w, i) => w === want[i]) };
}

const styleKey = (s: string | null | undefined) => (s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");

// ---------- boxes ----------

export function iou(a: Box2d, b: Box2d): number {
  const [ay0, ax0, ay1, ax1] = a;
  const [by0, bx0, by1, bx1] = b;
  const ih = Math.max(0, Math.min(ay1, by1) - Math.max(ay0, by0));
  const iw = Math.max(0, Math.min(ax1, bx1) - Math.max(ax0, bx0));
  const inter = ih * iw;
  const union = (ay1 - ay0) * (ax1 - ax0) + (by1 - by0) * (bx1 - bx0) - inter;
  return union > 0 ? inter / union : 0;
}

/** One-to-one matching on one photo: the best-overlapping pairs first, each box used once, overlap at least the threshold. */
export function matchBoxes(marked: Box2d[], found: Box2d[], threshold = OVERLAP_THRESHOLD): { matched: number; missed: number; falseAlarms: number } {
  const pairs: { i: number; j: number; o: number }[] = [];
  marked.forEach((m, i) => found.forEach((f, j) => pairs.push({ i, j, o: iou(m, f) })));
  pairs.sort((x, y) => y.o - x.o);
  const usedM = new Set<number>();
  const usedF = new Set<number>();
  for (const p of pairs) {
    if (p.o < threshold) break;
    if (usedM.has(p.i) || usedF.has(p.j)) continue;
    usedM.add(p.i);
    usedF.add(p.j);
  }
  return { matched: usedM.size, missed: marked.length - usedM.size, falseAlarms: found.length - usedF.size };
}

// ---------- size ----------

/** Did Sleuth read the listing's size as labelled: same value and system, "unknown" when it isn't stated, or a size menu? */
export function sizeAgrees(run: CaseRun["size"], label: NonNullable<CaseRun["label"]["size"]>): boolean {
  // No size on the listing: right only when nothing was read as one.
  if (label.value === "not_stated") return !run.options && !parseSizeText(run.text ?? undefined, undefined);
  if (label.value === "multiple") return !!run.options && (label.system === "unknown" ? run.options.system === "unknown" : run.options.system === label.system);
  const parsed = parseSizeText(run.text ?? undefined, run.system && run.system !== "unknown" ? (run.system as "UK") : undefined);
  if (!parsed) return false;
  if (label.system === "unknown") return parsed.system === "unknown" && Math.abs(parsed.size - label.value) < 0.01;
  return parsed.system === label.system && Math.abs(parsed.size - label.value) < 0.01;
}

// ---------- the summary ----------

type Failure = EvalSummary["failures"][number];

export function summarise(
  runs: CaseRun[],
  meta: Pick<EvalSummary, "runAt" | "pipelineVersion" | "models" | "cacheMode">,
): EvalSummary {
  const failures: Failure[] = [];
  const fail = (caseId: string, metric: string, detail: string) => failures.push({ caseId, metric, detail });
  const say = (s: string | null | undefined) => (s ? `"${s}"` : "nothing");

  // Identification
  const brandCases = runs.filter((r) => r.label.brand);
  const brandOk = brandCases.filter((r) => r.tier !== "none" && sameBrand(r.brand, r.label.brand));
  brandCases.filter((r) => !brandOk.includes(r)).forEach((r) => fail(r.id, "Brand", `labelled ${r.label.brand}, Sleuth said ${say(r.tier === "none" ? null : r.brand)}`));

  const named = (r: CaseRun) => (EXACT_TIERS.has(r.tier) ? nameMatch(r.modelName, r.label) : { model: false, version: false });
  // Every case with a known model is scored, however vague the listing: Sleuth always owes a best guess, and naming
  // only the brand (or nothing) counts as wrong.
  const modelCases = runs.filter((r) => isKnown(r.label.model));
  const modelOk = modelCases.filter((r) => named(r).model);
  const vagueCases = modelCases.filter((r) => r.label.listingShowsModel === false);
  const vagueOk = vagueCases.filter((r) => modelOk.includes(r));
  const wrongPassed = modelCases.filter((r) => EXACT_TIERS.has(r.tier) && !named(r).model);
  modelCases
    .filter((r) => !modelOk.includes(r))
    .forEach((r) => fail(r.id, "Model", `labelled ${r.label.model}, Sleuth ${EXACT_TIERS.has(r.tier) ? `said ${say(r.modelName)}` : `named no exact model (${r.tier})`}`));
  const versionCases = modelCases.filter((r) => isKnown(r.label.version));
  const versionOk = versionCases.filter((r) => named(r).version);
  versionCases
    .filter((r) => modelOk.includes(r) && !versionOk.includes(r))
    .forEach((r) => fail(r.id, "Version", `labelled ${r.label.model} ${r.label.version}, Sleuth said ${say(r.modelName)}`));
  const styleCases = runs.filter((r) => r.label.styleCode?.visible && r.label.styleCode.value);
  const styleOk = styleCases.filter((r) => styleKey(r.styleCode) === styleKey(r.label.styleCode!.value));
  styleCases.filter((r) => !styleOk.includes(r)).forEach((r) => fail(r.id, "Style code", `labelled ${r.label.styleCode!.value}, read ${say(r.styleCode)}`));

  // Flash and Pro
  const rechecks = runs.filter((r) => r.proRecheck);
  const answered = rechecks.filter((r) => r.proRecheck!.outcome === "agree" || r.proRecheck!.outcome === "disagree");
  const disagreed = answered.filter((r) => r.proRecheck!.outcome === "disagree");
  const judged = disagreed.filter((r) => isKnown(r.label.model) && isKnown(r.label.version));
  const right = (name: string | null, r: CaseRun) => nameMatch(name, r.label).version;
  const flashRight = judged.filter((r) => right(r.proRecheck!.flash, r));
  const proRight = judged.filter((r) => right(r.proRecheck!.pro, r));
  const neither = judged.filter((r) => !flashRight.includes(r) && !proRight.includes(r));
  disagreed.forEach((r) => fail(r.id, "Flash/Pro", `Flash said ${say(r.proRecheck!.flash)}, Pro said ${say(r.proRecheck!.pro)}${r.label.model ? `; labelled ${r.label.model} ${r.label.version ?? "?"}` : ""}`));

  // Condition
  let marked = 0;
  let matched = 0;
  let reported = 0;
  let falseAlarms = 0;
  let photosChecked = 0;
  for (const r of runs) {
    if (!r.label.defects) continue;
    for (const [key, boxes] of Object.entries(r.label.defects)) {
      const photo = Number(key);
      photosChecked++;
      const found = r.findings.filter((f) => f.photo === photo);
      const m = matchBoxes(boxes.map((b) => b.box2d), found.map((f) => f.box2d));
      marked += boxes.length;
      matched += m.matched;
      reported += found.length;
      falseAlarms += m.falseAlarms;
      if (m.missed) fail(r.id, "Defects", `photo ${photo}: ${m.missed} of ${boxes.length} marked defect${boxes.length === 1 ? "" : "s"} not found`);
      if (m.falseAlarms) fail(r.id, "Defects", `photo ${photo}: ${m.falseAlarms} defect${m.falseAlarms === 1 ? "" : "s"} reported that weren't marked`);
    }
  }

  // Fit
  const sizeCases = runs.filter((r) => r.label.size);
  const sizeOk = sizeCases.filter((r) => sizeAgrees(r.size, r.label.size!));
  sizeCases
    .filter((r) => !sizeOk.includes(r))
    .forEach((r) => fail(r.id, "Fit", `labelled ${r.label.size!.system} ${r.label.size!.value}, read ${say(r.size.text)}${r.size.system ? ` (${r.size.system})` : ""}`));

  // Colour
  const colourCases = runs.filter((r) => r.label.colourway);
  const mainOk = colourCases.filter((r) => r.colours?.[0] === r.label.colourway![0]);
  const allOk = colourCases.filter((r) => !!r.colours && r.colours.length === r.label.colourway!.length && r.colours.every((c) => r.label.colourway!.includes(c as never)));
  colourCases
    .filter((r) => !allOk.includes(r))
    .forEach((r) => fail(r.id, "Colour", `labelled ${r.label.colourway!.join("/")}, Sleuth said ${r.colours?.join("/") || "nothing"}`));
  let offerChecked = 0;
  let offerOk = 0;
  for (const r of runs) {
    for (const o of r.label.offerColours ?? []) {
      const got = r.offers.find((x) => x.url === o.url);
      if (!got) continue; // not among this run's offers
      offerChecked++;
      if (got.colourMatch === o.colourMatch) offerOk++;
      else fail(r.id, "Offer colour", `${o.url}: checked ${o.colourMatch}, Sleuth said ${got.colourMatch}`);
    }
  }

  // Verdict
  const verdictCases = runs.filter((r) => r.label.expectedVerdict);
  const verdictOk = verdictCases.filter((r) => r.verdict === r.label.expectedVerdict);
  verdictCases.filter((r) => !verdictOk.includes(r)).forEach((r) => fail(r.id, "Verdict", `expected ${r.label.expectedVerdict}, got ${r.verdict ?? "none"}`));

  // Time and calls (cases that finished)
  const finished = runs.filter((r) => !r.error);
  runs.filter((r) => r.error).forEach((r) => fail(r.id, "Error", r.error!));

  const f = {
    brandAccuracy: fraction("Brand identified correctly", brandOk.length, brandCases.length),
    modelIdentification: fraction("Model identified correctly", modelOk.length, modelCases.length),
    versionAccuracy: fraction("Version identified correctly", versionOk.length, versionCases.length),
    wrongModel: fraction("Wrong model named", wrongPassed.length, modelCases.length, false),
    styleCodeRead: fraction("Style code read (when visible)", styleOk.length, styleCases.length),
    vagueModel: fraction("Model identified correctly when the listing doesn't show it", vagueOk.length, vagueCases.length),
    proDisagreement: fraction("Flash and Pro disagreed", disagreed.length, answered.length, false),
    flashRight: fraction("Flash was right when they disagreed", flashRight.length, judged.length),
    proRight: fraction("Pro was right when they disagreed", proRight.length, judged.length),
    neitherRight: fraction("Neither was right when they disagreed", neither.length, judged.length, false),
    proNoAnswer: fraction("Pro declined or timed out", rechecks.length - answered.length, rechecks.length, false),
    defectDetection: fraction("Marked defects found", matched, marked),
    falseAlarms: fraction("Reported defects that weren't marked (false alarms)", falseAlarms, reported, false),
    defectPhotos: fraction("Photos with hand-marked defects (of 10 needed)", photosChecked, 10),
    fitAccuracy: fraction("Listed size read as labelled", sizeOk.length, sizeCases.length),
    colourMain: fraction("Listing's main colour correct", mainOk.length, colourCases.length),
    colourAll: fraction("All of the listing's colours correct", allOk.length, colourCases.length),
    offerColour: fraction("Offer colour labels agree with a hand check", offerOk, offerChecked),
    verdict: fraction("Verdict as expected", verdictOk.length, verdictCases.length),
    errors: fraction("Cases that stopped with an error", runs.length - finished.length, runs.length, false),
    timePerCase: spread("Time per case", finished.map((r) => r.durationMs), "seconds"),
    geminiCalls: spread("Gemini calls per case", finished.map((r) => r.geminiCalls), "calls"),
  } satisfies Record<string, Figure>;

  const section = (title: string, ids: (keyof typeof f)[]) => ({ title, figures: ids.map((id) => ({ id, figure: f[id] })) });
  const headline: Record<HeadlineId, Figure> = {
    modelIdentification: f.modelIdentification,
    defectDetection: f.defectDetection,
    falseAlarms: f.falseAlarms,
    fitAccuracy: f.fitAccuracy,
    timePerCase: f.timePerCase,
  };
  return {
    ...meta,
    cases: runs.length,
    caseIds: runs.map((r) => r.id),
    labelsHash: labelsHash(runs),
    overlapThreshold: OVERLAP_THRESHOLD,
    sections: [
      section("Identification", ["brandAccuracy", "modelIdentification", "versionAccuracy", "wrongModel", "styleCodeRead", "vagueModel"]),
      section("Gemini Flash vs Pro (model read only from photos)", ["proDisagreement", "flashRight", "proRight", "neitherRight", "proNoAnswer"]),
      section("Condition", ["defectDetection", "falseAlarms", "defectPhotos"]),
      section("Fit", ["fitAccuracy"]),
      section("Colour", ["colourMain", "colourAll", "offerColour"]),
      section("Verdict", ["verdict"]),
      section("Time and cost", ["timePerCase", "geminiCalls", "errors"]),
    ],
    headline,
    structuredCapture: {
      with: runs.filter((r) => r.structured.length).map((r) => ({ caseId: r.id, groups: r.structured })),
      without: runs.filter((r) => !r.structured.length).map((r) => r.id),
    },
    failures,
  };
}
