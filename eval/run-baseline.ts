/**
 * npm run eval:baseline: the same labelled cases through one plain Gemini call each (eval/baseline.ts), scored by the
 * same code against the same labels. Writes eval/baseline-summary.json and rewrites eval/report.md and eval/slide.md
 * with the side-by-side table (once npm run eval has written eval/summary.json).
 */
import "../lib/loadEnv";
import { useTestDatabase } from "../lib/testDb";
import path from "node:path";
import { getDeps } from "../pipeline/deps";
import { prepareText } from "../pipeline/intake";
import { redactListingData } from "../pipeline/listingData";
import { readLabels } from "./labels";
import { EVAL_PROFILE, readCase, type CaseRun } from "./collect";
import { askBaseline, baselineRun } from "./baseline";
import { missingPhotos } from "./photos";
import { summarise } from "./metrics";
import { BASELINE_SUMMARY, EVAL_DIR, writeReports, writeSummary } from "./write";

const DIR = path.join(EVAL_DIR, "listings");

async function main() {
  useTestDatabase(); // the response cache never touches the main database
  const base = await getDeps();
  const labels = readLabels(DIR);
  const absent = labels.filter((c) => missingPhotos(path.join(DIR, c.id)).length);
  if (absent.length) throw new Error(`Eval photos missing for ${absent.map((c) => c.id).join(", ")}. Run npm run eval:photos first.`);

  const runs: CaseRun[] = [];
  for (const c of labels) {
    const file = readCase(path.join(DIR, c.id));
    // Exactly what Sleuth receives: the page text redacted and scoped by prepareText, the same photos in the same order.
    const { pageText } = prepareText(file.capture);
    const listing = redactListingData(file.capture.listing);
    const r = await askBaseline(base.gemini, { pageText, images: file.screenshots, profile: EVAL_PROFILE, listing });
    const run = baselineRun(c.id, c.label, r, file.screenshots.length, listing);
    runs.push(run);
    console.log(`${c.id}: ${run.brand ?? "-"} ${run.modelName ?? "-"} · ${run.findings.length} defects · verdict ${run.verdict ?? "-"} · ${run.durationMs} ms · ${run.geminiCalls} calls${run.error ? ` · ERROR ${run.error}` : ""}`);
  }

  const summary = {
    ...summarise(runs, {
      runAt: new Date().toISOString(),
      pipelineVersion: "baseline",
      models: { fast: base.config.models.fast ?? null, strong: null },
      cacheMode: String(base.config.cacheMode),
    }),
    system: "baseline" as const,
  };
  writeSummary(BASELINE_SUMMARY, summary);
  const wrote = writeReports();
  console.log(`\nWrote eval/baseline-summary.json${wrote.length ? ` and ${wrote.join(", ")}` : " (run npm run eval for the side-by-side report)"} (${runs.length} cases).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
