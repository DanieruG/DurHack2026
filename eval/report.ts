import { figureText, honestLine, HEADLINE_IDS, type EvalSummary } from "../schemas/eval";
import { missingLabelsMarkdown, type CaseLabels } from "./labels";

/**
 * eval/report.md and eval/slide.md from a summary. Same figures everywhere; every one with its sample size and the
 * raw fraction beside the percentage.
 */

const day = (iso: string) => iso.slice(0, 10);

export function reportMarkdown(s: EvalSummary, labels: CaseLabels[]): string {
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
  for (const sec of s.sections) {
    out.push("", `## ${sec.title}`, "", "| Metric | Result |", "| --- | --- |", ...sec.figures.map(({ figure }) => `| ${figure.label} | ${figureText(figure)} |`));
  }
  out.push("", ...structuredMarkdown(s));
  out.push("", "## Failure cases", "");
  if (!s.failures.length) out.push("None.");
  else out.push("| Case | Metric | What happened |", "| --- | --- | --- |", ...s.failures.map((f) => `| ${f.caseId} | ${f.metric} | ${f.detail.replace(/\|/g, "\\|")} |`));
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
export function slideMarkdown(s: Pick<EvalSummary, "headline" | "runAt" | "cases" | "pipelineVersion">): string {
  return [
    "| How accurate is Sleuth? | Result |",
    "| --- | --- |",
    ...HEADLINE_IDS.map((id) => `| ${s.headline[id].label} | ${figureText(s.headline[id])} |`),
    "",
    `${honestLine(s.cases)} Tested ${day(s.runAt)} (pipeline v${s.pipelineVersion}).`,
    "",
  ].join("\n");
}
