import { figureText, honestLine, HEADLINE_IDS, type EvalSummary, type Figure } from "../schemas/eval";
import { missingLabelsMarkdown, type CaseLabels } from "./labels";
import { BASELINE_PROMPT } from "./baseline";

/**
 * eval/report.md and eval/slide.md from a summary. Same figures everywhere; every one with its sample size and the
 * raw fraction beside the percentage.
 */

const day = (iso: string) => iso.slice(0, 10);

// ---------- Sleuth vs the baseline ----------

/** The metrics compared side by side, in this order, with the names the table uses. */
export const COMPARED: [id: string, name: string][] = [
  ["brandAccuracy", "Brand"],
  ["modelIdentification", "Model"],
  ["versionAccuracy", "Version"],
  ["styleCodeRead", "Style code read (when visible)"],
  ["fitAccuracy", "Size and size system"],
  ["defectDetection", "Marked defects found"],
  ["falseAlarms", "False alarms (of defects reported)"],
  ["verdict", "Verdict as expected"],
  ["timePerCase", "Time per case"],
  ["geminiCalls", "Gemini calls per case"],
];

export const figureById = (s: EvalSummary, id: string): Figure | undefined => s.sections.flatMap((x) => x.figures).find((f) => f.id === id)?.figure;

/** Which did better, from the exact ratios (not the rounded percentages); null when either isn't measured. */
export function better(baseline: Figure, sleuth: Figure): "baseline" | "sleuth" | "tie" | null {
  if (baseline.kind === "fraction" && sleuth.kind === "fraction") {
    if (!baseline.d || !sleuth.d) return null;
    const diff = baseline.n * sleuth.d - sleuth.n * baseline.d; // baseline rate minus Sleuth's, without division
    if (diff === 0) return "tie";
    return diff > 0 === baseline.higherIsBetter ? "baseline" : "sleuth";
  }
  if (baseline.kind === "spread" && sleuth.kind === "spread") {
    if (baseline.median === null || sleuth.median === null) return null;
    return baseline.median === sleuth.median ? "tie" : baseline.median < sleuth.median ? "baseline" : "sleuth";
  }
  return null;
}

/** Why the two runs can't be compared yet, or null when they can (same cases, same labels). */
export function mismatch(sleuth: EvalSummary, baseline: EvalSummary): string | null {
  if (JSON.stringify(sleuth.caseIds) !== JSON.stringify(baseline.caseIds)) return "the two runs covered different cases";
  if (sleuth.labelsHash !== baseline.labelsHash) return "the labels changed between the two runs";
  return null;
}

export type Comparison = { rows: { name: string; baseline: string; sleuth: string; better: ReturnType<typeof better> }[]; baselineWins: string[]; stale: string | null };

export function compare(sleuth: EvalSummary, baseline: EvalSummary): Comparison {
  const rows = COMPARED.flatMap(([id, name]) => {
    const b = figureById(baseline, id);
    const s = figureById(sleuth, id);
    return b && s ? [{ name, baseline: figureText(b), sleuth: figureText(s), better: better(b, s) }] : [];
  });
  return { rows, baselineWins: rows.filter((r) => r.better === "baseline").map((r) => r.name), stale: mismatch(sleuth, baseline) };
}

const BETTER_TEXT = { baseline: "baseline", sleuth: "Sleuth", tie: "tie" } as const;

function comparisonTable(c: Comparison): string[] {
  return [
    "| Metric | Baseline (one Gemini call) | Sleuth | Better |",
    "| --- | --- | --- | --- |",
    ...c.rows.map((r) => `| ${r.name} | ${r.baseline} | ${r.sleuth} | ${r.better ? BETTER_TEXT[r.better] : "not measured"} |`),
  ];
}

function winsLine(c: Comparison): string {
  return c.baselineWins.length
    ? `**Where the baseline does better: ${c.baselineWins.join(", ")}.**`
    : "The baseline doesn't do better than Sleuth on any metric measured so far.";
}

export function comparisonMarkdown(sleuth: EvalSummary, baseline: EvalSummary): string[] {
  const c = compare(sleuth, baseline);
  const out = ["## Sleuth vs a single Gemini call (baseline)", ""];
  if (c.stale) out.push(`**Not comparable yet: ${c.stale}. Run npm run eval and npm run eval:baseline again, one after the other.**`, "");
  out.push(
    `The baseline is what a person gets by pasting the listing into a chatbot: one call per case to ${baseline.models.fast ?? "GEMINI_MODEL_FAST"}, with no system prompt, tools, search, catalogue or rules. Its prompt:`,
    "",
    `> ${BASELINE_PROMPT}`,
    "",
    "followed by the buyer's profile in one line (the same profile Sleuth gets: usual size UK 9, all-day comfort, light wear fine), the page text and the photos. Its answer comes back as structured output with the same fields Sleuth reports.",
    "",
    `Same ${sleuth.cases} cases, same inputs (the page text redacted and scoped exactly as Sleuth receives it, the same photos in the same order, and the listing's structured fields where a case has them), same labels, and the same scoring code (eval/metrics.ts, boxes matched at an overlap of ${sleuth.overlapThreshold}). Better is decided on the exact fractions, not the rounded percentages. Time is the investigation's duration for Sleuth and the call's for the baseline; a malformed answer gets one retry, counted as a call.`,
    "",
    ...comparisonTable(c),
    "",
    winsLine(c),
    "",
    `Sleuth run ${sleuth.runAt} (CACHE_MODE=${sleuth.cacheMode}); baseline run ${baseline.runAt} (CACHE_MODE=${baseline.cacheMode}).`,
  );
  return out;
}

export function reportMarkdown(s: EvalSummary, labels: CaseLabels[], baseline?: EvalSummary | null): string {
  const out: string[] = [
    "# Sleuth evaluation report",
    "",
    `Run ${s.runAt} · ${s.cases} labelled listing${s.cases === 1 ? "" : "s"} · PIPELINE_VERSION=${s.pipelineVersion} · CACHE_MODE=${s.cacheMode}`,
    `Models: fast=${s.models.fast ?? "unset"}, strong=${s.models.strong ?? "unset"}`,
    "",
    `Percentages are whole numbers rounded against Sleuth (down when higher is better, up when lower is better); times round up. Defect boxes match when their overlap (intersection over union) is at least ${s.overlapThreshold}. A case missing a label is left out of that figure, so sample sizes differ.`,
    "",
    honestLine(s.cases),
    "",
    "## Headline",
    "",
    "| Metric | Result |",
    "| --- | --- |",
    ...HEADLINE_IDS.map((id) => `| ${s.headline[id].label} | ${figureText(s.headline[id])} |`),
  ];
  if (baseline) out.push("", ...comparisonMarkdown(s, baseline));
  else out.push("", "## Sleuth vs a single Gemini call (baseline)", "", "Not run yet: npm run eval:baseline.");
  for (const sec of s.sections) {
    out.push("", `## ${sec.title}`, "", "| Metric | Result |", "| --- | --- |", ...sec.figures.map(({ figure }) => `| ${figure.label} | ${figureText(figure)} |`));
  }
  out.push("", ...structuredMarkdown(s));
  out.push("", "## Failure cases", "");
  if (!s.failures.length) out.push("None.");
  else out.push("| Case | Metric | What happened |", "| --- | --- | --- |", ...s.failures.map((f) => `| ${f.caseId} | ${f.metric} | ${f.detail.replace(/\|/g, "\\|")} |`));
  if (baseline) {
    out.push("", "## Baseline failure cases", "");
    if (!baseline.failures.length) out.push("None.");
    else out.push("| Case | Metric | What happened |", "| --- | --- | --- |", ...baseline.failures.map((f) => `| ${f.caseId} | ${f.metric} | ${f.detail.replace(/\|/g, "\\|").replace(/Sleuth said/g, "baseline said").replace(/Sleuth named/g, "baseline named")} |`));
  }
  out.push("", "## Labels still missing", "", missingLabelsMarkdown(labels), "");
  return out.join("\n");
}

/** Which cases ran with the extension's structured fields: figures can differ between the two groups. */
export function structuredMarkdown(s: Pick<EvalSummary, "structuredCapture" | "cases">): string[] {
  const sc = s.structuredCapture;
  if (!sc) return ["## Structured capture", "", "Not recorded for this run."];
  const out = [
    "## Structured capture",
    "",
    `${sc.with.length} of ${s.cases} case${s.cases === 1 ? "" : "s"} ran with the extension's structured fields (item specifics, size options, attributes, pricing, each with its source); the rest ran on page text and photos only.`,
  ];
  if (sc.with.length) out.push("", "| Case | Structured fields |", "| --- | --- |", ...sc.with.map((c) => `| ${c.caseId} | ${c.groups.join(", ")} |`));
  if (sc.without.length) out.push("", `Page text only: ${sc.without.join(", ")}.`);
  return out;
}

/** eval/slide.md: the headline figures as a compact table to paste into a slide. */
export function slideMarkdown(s: EvalSummary, baseline?: EvalSummary | null): string {
  const out = [
    "| How accurate is Sleuth? | Result |",
    "| --- | --- |",
    ...HEADLINE_IDS.map((id) => `| ${s.headline[id].label} | ${figureText(s.headline[id])} |`),
    "",
    `${honestLine(s.cases)} Tested ${day(s.runAt)} (pipeline v${s.pipelineVersion}).`,
    "",
  ];
  if (baseline) {
    const c = compare(s, baseline);
    out.push("| Sleuth vs pasting the listing into a chatbot | Chatbot (one Gemini call) | Sleuth |", "| --- | --- | --- |", ...c.rows.map((r) => `| ${r.name} | ${r.baseline} | ${r.sleuth} |`), "");
    out.push(c.stale ? `Not comparable yet: ${c.stale}.` : `Same cases, inputs, labels and scoring. ${winsLine(c)}`, "");
  }
  return out.join("\n");
}
