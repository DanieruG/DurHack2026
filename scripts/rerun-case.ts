/**
 * Rerun a stored case's captured inputs through the current pipeline, on the test-runs branch (never main).
 *   npx tsx scripts/rerun-case.ts <caseId>
 * Prints per-call timings and tokens (from the Gemini/Shopping loggers), the identify result, every check, the
 * new-price offers and the verdict.
 */
import "../lib/loadEnv";
import { useTestDatabase } from "../lib/testDb";
import type { CheckResult } from "../schemas/domain";

useTestDatabase();
const [{ getDb }, { getDeps }, { createCase }] = await Promise.all([import("../lib/db"), import("../pipeline/deps"), import("../pipeline")]);

const sourceId = process.argv[2];
if (!sourceId) throw new Error("usage: npx tsx scripts/rerun-case.ts <caseId>");
const db = getDb();
const src = await db.case.findUnique({ where: { id: sourceId }, include: { inputs: { orderBy: { position: "asc" }, select: { kind: true, text: true, sourceUrl: true } } } });
if (!src) throw new Error(`case ${sourceId} not found on the test branch`);
const needs = src.needs as { sizes: never[]; defaultSize?: never; priorities: string[]; budgetGBP?: number; wearTolerance: "none" | "light" | "moderate" | "any" };
const pageText = src.inputs.find((i) => i.kind === "page_text")?.text ?? "";
const imageUrls = src.inputs.filter((i) => i.kind === "image" && i.sourceUrl).map((i) => i.sourceUrl!);

const deps = await getDeps();
const started = Date.now();
const { caseId, done } = await createCase(deps, {
  capture: { pageUrl: src.pageUrl ?? undefined, pageText, imageUrls },
  profile: { sizes: needs.sizes, ...(needs.defaultSize ? { defaultSize: needs.defaultSize } : {}), priorities: needs.priorities, budgetGBP: needs.budgetGBP, wearTolerance: needs.wearTolerance },
  screenshots: [],
});
await done;
const total = Date.now() - started;
const c = (await deps.store.getCase(caseId))!;
const checks = (await deps.store.getChecks(caseId, c.revision)) as CheckResult[];
const { evidence: _e, ...identify } = (c.identify ?? {}) as Record<string, unknown>;
console.log(`\n=== rerun of ${sourceId} -> ${caseId} (test-runs branch) in ${total}ms`);
console.log("identify:", JSON.stringify(identify));
for (const k of checks) {
  console.log(`check ${k.check}: ${k.status} (confidence ${k.confidence}) ${k.summary}`);
  if (k.check === "price") console.log("  price details:", JSON.stringify(k.details));
  if (k.check === "comfort") for (const e of k.evidence) console.log(`  source [${e.sourceType}] ${e.title}`);
}
console.log(`verdict: ${c.verdict?.label} (${c.verdict?.ruleId}) ${c.verdict?.headline}`);
console.log("next moves:", JSON.stringify(c.nextMoves));
process.exit(0);
