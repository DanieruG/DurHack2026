import fs from "node:fs/promises";
import path from "node:path";
import { EvalSummarySchema, PublicEvalSummarySchema, type PublicEvalSummary } from "@/schemas/eval";

export const EVAL_SUMMARY_PATH = path.join(process.cwd(), "eval", "summary.json");

/**
 * The latest eval/summary.json, public part only (figures, dates, model names; no failure list). Null when the eval
 * hasn't been run or the file doesn't parse.
 */
export async function loadPublicEvalSummary(file = EVAL_SUMMARY_PATH): Promise<PublicEvalSummary | null> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    return null;
  }
  try {
    const { failures: _f, ...rest } = EvalSummarySchema.parse(JSON.parse(raw));
    return PublicEvalSummarySchema.parse(rest);
  } catch {
    return null;
  }
}
