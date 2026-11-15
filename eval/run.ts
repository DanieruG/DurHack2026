/**
 * Evaluation: runs every labelled case in eval/listings/<id>/ through the pipeline (respecting CACHE_MODE) and writes
 * eval/report.md (readable) and eval/summary.json (the same figures, machine-readable; served by GET /api/eval/summary).
 *   npm run eval            (CACHE_MODE=record to build a replayable cache, CACHE_MODE=replay to run offline)
 *   npm run eval:slide      eval/slide.md from the latest summary.json
 *   npm run eval:labels     list cases with missing labels in eval/LABELLING.md
 *
 * Case folders (folders starting with "_" are skipped): capture.json, photo-NN.* (sent in order), label.json.
 * How to label a case: eval/LABELLING.md. Metrics: eval/metrics.ts.
 */
import "../lib/loadEnv";
import { useTestDatabase } from "../lib/testDb";
import fs from "node:fs";
import path from "node:path";
import { getDeps } from "../pipeline/deps";
import { readLabels } from "./labels";
import { runCase } from "./collect";
import { summarise } from "./metrics";
import { reportMarkdown } from "./report";

const EVAL = path.join(process.cwd(), "eval");
const DIR = path.join(EVAL, "listings");

async function main() {
  useTestDatabase(); // never the main database
  const base = await getDeps();
  const labels = readLabels(DIR);
  if (!labels.length) console.warn("No cases in eval/listings (folders starting with _ are skipped).");

  const runs = [];
  for (const c of labels) {
    if (c.error) console.warn(`${c.id}: label.json doesn't parse (${c.error}); running with no labels`);
    const r = await runCase(base, path.join(DIR, c.id), c.id, c.label);
    runs.push(r);
    console.log(`${c.id}: ${r.tier} ${r.modelName ?? "-"} · verdict ${r.verdict ?? "-"} · ${r.durationMs} ms · ${r.geminiCalls} calls${r.error ? ` · ERROR ${r.error}` : ""}`);
  }

  const summary = summarise(runs, {
    runAt: new Date().toISOString(),
    pipelineVersion: String(base.config.pipelineVersion),
    models: { fast: base.config.models.fast ?? null, strong: base.config.models.strong ?? null },
    cacheMode: String(base.config.cacheMode),
  });
  fs.writeFileSync(path.join(EVAL, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  fs.writeFileSync(path.join(EVAL, "report.md"), reportMarkdown(summary, labels));
  console.log(`\nWrote eval/report.md and eval/summary.json (${runs.length} cases).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
