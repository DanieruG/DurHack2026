/**
 * Evaluation: runs every labelled capture in eval/listings/<id>/ through the pipeline (respecting CACHE_MODE)
 * and writes eval/report.md. Numbers are reported exactly as counts plus a truncated percentage (never rounded up).
 *   npm run eval            (CACHE_MODE=record to build a replayable demo cache, CACHE_MODE=replay to run offline)
 *
 * Listing folder layout (folders starting with "_" are skipped):
 *   capture.json   { "capture": Capture, "profile"?: Profile, "caseNote"?: string }
 *   *.jpg|png|webp  optional screenshots / photos, sent as screenshots
 *   label.json     { "catalogueModelId": string | null, "sizeUK"?: number, "priceGBP": number,
 *                    "conditionGrade": "new_with_tags"|"like_new"|"good"|"worn", "expectedVerdict"?: VerdictLabel }
 */
import "../lib/loadEnv";
import { useTestDatabase } from "../lib/testDb";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { CaptureSchema, ConditionGradeSchema, ProfileSchema, VerdictLabelSchema, type CheckResult, type Verdict } from "../schemas";
import { getDeps } from "../pipeline/deps";
import { createCase } from "../pipeline";
import { MemoryStore } from "../lib/store";
import { EventHub } from "../pipeline/events";
import { sniffImageMime } from "../lib/images";
import { gradeFromClaims } from "../pipeline/checks/condition";

const DIR = path.join(process.cwd(), "eval", "listings");

const LabelSchema = z.object({
  catalogueModelId: z.string().nullable(),
  sizeUK: z.number().optional(),
  priceGBP: z.number(),
  conditionGrade: ConditionGradeSchema,
  expectedVerdict: VerdictLabelSchema.optional(),
});
const CaptureFileSchema = z.object({ capture: CaptureSchema, profile: ProfileSchema.optional(), caseNote: z.string().optional() });

const DEFAULT_PROFILE = ProfileSchema.parse({ sizes: [{ brand: "Nike", size: 9, system: "UK" }], priorities: ["all-day comfort"], wearTolerance: "light" });

type Row = {
  id: string;
  label: z.infer<typeof LabelSchema>;
  predictedModel: string | null;
  gatePassed: boolean;
  listedUK?: number;
  priceGBP?: number;
  grade?: string;
  verdict?: Verdict["label"];
  durationMs: number;
  geminiCalls: number;
  error?: string;
};

/** Truncated (never rounded up) percentage. */
function pct(n: number, d: number): string {
  if (d === 0) return "n/a (0 cases)";
  return `${n}/${d} (${(Math.floor((n / d) * 1000) / 10).toFixed(1)}%)`;
}

async function main() {
  useTestDatabase(); // never the main database
  const base = await getDeps();
  const ref = await base.store.getReference();
  const ids = fs.existsSync(DIR) ? fs.readdirSync(DIR).filter((d) => !d.startsWith("_") && fs.statSync(path.join(DIR, d)).isDirectory()).sort() : [];
  if (!ids.length) console.warn("No labelled listings in eval/listings (folders starting with _ are skipped).");

  const rows: Row[] = [];
  for (const id of ids) {
    const dir = path.join(DIR, id);
    const label = LabelSchema.parse(JSON.parse(fs.readFileSync(path.join(dir, "label.json"), "utf8")));
    const file = CaptureFileSchema.parse(JSON.parse(fs.readFileSync(path.join(dir, "capture.json"), "utf8")));
    const screenshots = fs
      .readdirSync(dir)
      .filter((f) => /\.(jpe?g|png|webp)$/i.test(f))
      .sort()
      .map((f) => new Uint8Array(fs.readFileSync(path.join(dir, f))))
      .map((bytes) => ({ bytes, mimeType: sniffImageMime(bytes)! }))
      .filter((s) => s.mimeType);

    // Fresh in-memory case store per run, so eval cases never land in the shared database.
    const deps = { ...base, store: new MemoryStore(ref), hub: new EventHub() };
    const row: Row = { id, label, predictedModel: null, gatePassed: false, durationMs: 0, geminiCalls: 0 };
    try {
      const { caseId, done } = await createCase(deps, { capture: file.capture, profile: file.profile ?? DEFAULT_PROFILE, caseNote: file.caseNote, screenshots });
      await done;
      const events = deps.hub.events(caseId);
      const doneEv = events.find((e) => e.event === "investigation_done")?.data as { durationMs: number; geminiCalls: number } | undefined;
      const c = (await deps.store.getCase(caseId))!;
      const checks = await deps.store.getChecks(caseId, c.revision);
      const get = (n: string) => checks.find((x) => x.check === n) as CheckResult | undefined;
      const identify = get("identify");
      row.predictedModel = c.identify?.catalogueModelId ?? null;
      row.gatePassed = identify?.status === "pass";
      row.listedUK = (get("fit")?.details as { listedUK?: number } | undefined)?.listedUK;
      row.priceGBP = c.listingFacts?.priceGBP;
      row.grade = gradeFromClaims(c.listingFacts?.conditionClaims ?? []);
      row.verdict = c.verdict?.label;
      row.durationMs = doneEv?.durationMs ?? 0;
      row.geminiCalls = doneEv?.geminiCalls ?? 0;
      if (c.status === "error") row.error = "case status error";
    } catch (err) {
      row.error = err instanceof Error ? err.message : String(err);
    }
    rows.push(row);
    console.log(`${id}: model=${row.predictedModel ?? "null"} gate=${row.gatePassed} verdict=${row.verdict ?? "-"} ${row.durationMs}ms ${row.geminiCalls} calls${row.error ? ` ERROR ${row.error}` : ""}`);
  }

  const known = rows.filter((r) => r.label.catalogueModelId !== null);
  const unknown = rows.filter((r) => r.label.catalogueModelId === null);
  const idCorrect = known.filter((r) => r.gatePassed && r.predictedModel === r.label.catalogueModelId).length;
  const idWrong = known.filter((r) => r.gatePassed && r.predictedModel !== r.label.catalogueModelId).length;
  const idRefused = known.filter((r) => !r.gatePassed).length;
  const gateRefusedCorrectly = unknown.filter((r) => !r.gatePassed).length;
  const sized = rows.filter((r) => r.label.sizeUK !== undefined);
  const fitAgree = sized.filter((r) => r.listedUK === r.label.sizeUK).length;
  const priceAgree = rows.filter((r) => r.priceGBP !== undefined && Math.abs(r.priceGBP - r.label.priceGBP) < 0.005).length;
  const gradeAgree = rows.filter((r) => r.grade === r.label.conditionGrade).length;
  const withVerdict = rows.filter((r) => r.label.expectedVerdict);
  const verdictAgree = withVerdict.filter((r) => r.verdict === r.label.expectedVerdict).length;
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

  const report = `# Sleuth evaluation report

Generated ${new Date().toISOString()} · ${rows.length} labelled listing(s) · CACHE_MODE=${base.config.cacheMode} · PIPELINE_VERSION=${base.config.pipelineVersion}
Models: fast=${base.config.models.fast ?? "unset"}, strong=${base.config.models.strong ?? "unset"} · identify gate ≥ ${base.config.identifyConfidenceMin}

Percentages are truncated to one decimal place (never rounded up). Quote the counts alongside them.

## Identification

| Metric | Result |
| --- | --- |
| Correct model (labelled with a model, gate passed, right id) | ${pct(idCorrect, known.length)} |
| Wrong model passed the gate | ${pct(idWrong, known.length)} |
| Refused (gate) although a model was labelled | ${pct(idRefused, known.length)} |
| Gate correctly refused (label is null) | ${pct(gateRefusedCorrectly, unknown.length)} |

## Extraction agreement with labels

| Metric | Result |
| --- | --- |
| Fit: listed size (as UK) equals label sizeUK | ${pct(fitAgree, sized.length)} |
| Price: extracted GBP price equals label | ${pct(priceAgree, rows.length)} |
| Condition grade from seller's words equals label | ${pct(gradeAgree, rows.length)} |

## Verdict

| Metric | Result |
| --- | --- |
| Verdict equals expectedVerdict (where set) | ${pct(verdictAgree, withVerdict.length)} |

## Cost

| Metric | Result |
| --- | --- |
| Average duration per case | ${Math.round(avg(rows.map((r) => r.durationMs)))} ms |
| Average Gemini calls per case | ${avg(rows.map((r) => r.geminiCalls)).toFixed(2)} |
| Cases that errored | ${rows.filter((r) => r.error).length} |

## Per listing

| Listing | Label model | Predicted (gate) | Size UK label / got | Price label / got | Grade label / got | Verdict expected / got | ms | calls |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
${rows
  .map((r) => `| ${r.id} | ${r.label.catalogueModelId ?? "null"} | ${r.predictedModel ?? "null"} (${r.gatePassed ? "pass" : "refused"}) | ${r.label.sizeUK ?? "-"} / ${r.listedUK ?? "-"} | ${r.label.priceGBP} / ${r.priceGBP ?? "-"} | ${r.label.conditionGrade} / ${r.grade ?? "-"} | ${r.label.expectedVerdict ?? "-"} / ${r.verdict ?? "-"} | ${r.durationMs} | ${r.geminiCalls} |`)
  .join("\n")}
`;
  fs.writeFileSync(path.join(process.cwd(), "eval", "report.md"), report);
  console.log(`\nWrote eval/report.md (${rows.length} listings).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
