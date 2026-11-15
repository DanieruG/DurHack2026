import fs from "node:fs";
import path from "node:path";
import { EvalSummarySchema, type EvalSummary } from "../schemas/eval";
import { readLabels } from "./labels";
import { reportMarkdown, slideMarkdown } from "./report";

/**
 * eval/report.md and eval/slide.md from the latest eval/summary.json (npm run eval) and eval/baseline-summary.json
 * (npm run eval:baseline), whichever ran last: the side-by-side comparison appears once both exist.
 */
export const EVAL_DIR = path.join(process.cwd(), "eval");
export const SUMMARY = path.join(EVAL_DIR, "summary.json");
export const BASELINE_SUMMARY = path.join(EVAL_DIR, "baseline-summary.json");

export function readSummary(file: string): EvalSummary | null {
  return fs.existsSync(file) ? EvalSummarySchema.parse(JSON.parse(fs.readFileSync(file, "utf8"))) : null;
}

export function writeSummary(file: string, s: EvalSummary): void {
  fs.writeFileSync(file, `${JSON.stringify(s, null, 2)}\n`);
}

/** Rewrites report.md and slide.md; returns what it wrote. */
export function writeReports(): string[] {
  const sleuth = readSummary(SUMMARY);
  if (!sleuth) return [];
  const baseline = readSummary(BASELINE_SUMMARY);
  fs.writeFileSync(path.join(EVAL_DIR, "report.md"), reportMarkdown(sleuth, readLabels(path.join(EVAL_DIR, "listings")), baseline));
  fs.writeFileSync(path.join(EVAL_DIR, "slide.md"), slideMarkdown(sleuth, baseline));
  return ["eval/report.md", "eval/slide.md"];
}
