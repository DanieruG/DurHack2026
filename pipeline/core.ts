import type { CheckName, CheckResult, IdentifyResult, Lead, LeadsReport, Verdict } from "@/schemas/domain";
import { withCallLog, type CallLogEntry } from "@/gemini/client";
import type { CaseRow, RunTotals } from "@/lib/store";
import type { Deps } from "./deps";
import type { Emit } from "./events";
import { brandKnown } from "./identify";
import { inputHashFor, toCaseImages, type CaseImage } from "./intake";
import { generateNextMoves } from "./nextMoves";
import type { RunCtx } from "./runChecks";
import { decideAndWordVerdict } from "./verdict/wording";
import { decideVerdict } from "./verdict/rules";
import { detectWarningSignals } from "./signals";
import { runStage } from "./util";
import { fromStoredSurvey, matchSurvey, toStoredSurvey, type StoredSurvey, type Survey } from "@/lib/observed";
import { chartFor, subjectFor, tokensFor } from "./runChecks";

export async function loadImages(deps: Deps, caseId: string): Promise<CaseImage[]> {
  return toCaseImages(await deps.store.getInputs(caseId, { kinds: ["image"] }));
}

export async function loadPageText(deps: Deps, caseId: string): Promise<string> {
  const rows = await deps.store.getInputs(caseId, { kinds: ["page_text"], withData: false });
  return rows.map((r) => r.text ?? "").filter(Boolean).join("\n\n");
}

/** Wraps an investigation run: call log, timing, fatal-error handling, investigation_done. */
export async function instrumented(
  deps: Deps,
  caseId: string,
  revision: number,
  body: (emit: Emit) => Promise<void>,
): Promise<void> {
  const started = Date.now();
  const emit = deps.hub.emitter(caseId);
  const { log, run } = withCallLog(caseId, () => body(emit));
  try {
    await run;
  } catch (err) {
    console.error(`[sleuth] investigation ${caseId} failed`, err);
    await deps.store.updateCase(caseId, { status: "error" }).catch(() => undefined);
    emit("error", { message: "The investigation hit an unexpected problem and stopped. Please try again." });
  }
  const totals = { durationMs: Date.now() - started, geminiCalls: log.length, cachedCalls: log.filter((l) => l.cached).length };
  await saveRunTotals(deps, caseId, revision, totals).catch(() => undefined);
  emit("investigation_done", { caseId, revision, ...totals });
  logTotals(caseId, log, Date.now() - started);
}

async function saveRunTotals(deps: Deps, caseId: string, revision: number, run: RunTotals) {
  const c = await deps.store.getCase(caseId);
  if (!c || !c.history.some((h) => h.revision === revision)) return;
  await deps.store.updateCase(caseId, { history: c.history.map((h) => (h.revision === revision ? { ...h, run } : h)) });
}

function logTotals(caseId: string, log: CallLogEntry[], ms: number) {
  if (process.env.VITEST) return;
  const tokens = log.reduce((s, e) => s + (e.promptTokens ?? 0) + (e.outputTokens ?? 0), 0);
  console.info(`[sleuth] case=${caseId} done in ${ms}ms, ${log.length} Gemini calls (${log.filter((l) => l.cached).length} cached), ${tokens} tokens`);
}

/**
 * Store the survey's matched subset with the case (Feature A7), matched to the final identification: id, title, price,
 * URL, thumbnail, size and match level per card, plus counts per level. Unmatched cards are never stored.
 */
export async function saveSurvey(ctx: RunCtx): Promise<void> {
  if (!ctx.survey) return;
  const subject = subjectFor(ctx);
  const matched = matchSurvey(ctx.survey, tokensFor(subject), chartFor(subject, ctx.ref.sizeCharts));
  const stored: StoredSurvey = toStoredSurvey(ctx.survey, matched);
  await ctx.deps.store.addInputs(ctx.caseId, [{ revision: ctx.revision, kind: "observed_listings", text: JSON.stringify(stored) }]);
}

/** The stored subset (latest revision), as a survey to re-match on reopen. */
export async function loadSurvey(deps: Deps, caseId: string): Promise<Survey | null> {
  const rows = await deps.store.getInputs(caseId, { kinds: ["observed_listings"], withData: false });
  const last = rows.at(-1)?.text;
  if (!last) return null;
  try {
    return fromStoredSurvey(JSON.parse(last) as StoredSurvey);
  } catch {
    return null;
  }
}

export type FinaliseResult = { verdict: Verdict; checks: CheckResult[] };

/** Verdict (rules + wording), next moves, persist, emit. Shared by investigations and reopen. */
export async function finalise(
  ctx: RunCtx,
  args: {
    checks: CheckResult[];
    leads: Lead[];
    /** Whether leads were considered for this revision and, if skipped, why. Defaults to "considered" when there are leads. */
    leadsReport?: LeadsReport;
    row: CaseRow;
    inputHashImages: CaseImage[];
    answered?: CheckName[];
    beforeDone?: (verdict: Verdict) => void;
  },
): Promise<FinaliseResult> {
  const { deps, emit, caseId, revision } = ctx;
  const timeoutMs = deps.config.stageTimeoutMs;
  const identifyPassed = brandKnown(ctx.identify, ctx.ref.catalogue);
  const sellerReplies = (await deps.store.getInputs(caseId, { kinds: ["seller_reply"], withData: false })).map((r) => r.text ?? "").filter(Boolean);
  const warningSignals = detectWarningSignals({ checks: args.checks, facts: ctx.facts, identify: ctx.identify, pageText: ctx.pageText, sellerReplies, platform: ctx.facts.platform });

  // The label is decided by code rules, so wording the verdict and phrasing next moves can run at the same time.
  const label = decideVerdict(args.checks, identifyPassed, warningSignals).label;
  const movesArgs = { checks: args.checks, leads: args.leads, label, answered: args.answered, signals: warningSignals, platform: ctx.facts.platform, verificationAvailable: ctx.facts.verificationAvailable };
  const [{ verdict }, nextMoves] = await Promise.all([
    runStage("verdict", { emit, timeoutMs, geminiFeatures: ["structured_output"] }, () =>
      decideAndWordVerdict(deps.gemini, { checks: args.checks, identifyPassed, signals: warningSignals, extraEvidence: ctx.facts.evidence }),
    ).catch(() => decideAndWordVerdict(null, { checks: args.checks, identifyPassed, signals: warningSignals, extraEvidence: ctx.facts.evidence })),
    runStage("next_moves", { emit, timeoutMs, geminiFeatures: ["structured_output"] }, () => generateNextMoves(deps.gemini, movesArgs)).catch(() =>
    generateNextMoves(null, movesArgs),
    ),
  ]);

  const identify: IdentifyResult | null = ctx.identify;
  await deps.store.saveChecks(caseId, revision, args.checks);
  await deps.store.saveLeads(caseId, revision, args.leads);
  await deps.store.updateCase(caseId, {
    status: "closed",
    listingFacts: ctx.facts,
    needs: ctx.needs,
    identify,
    verdict,
    nextMoves,
    history: [...args.row.history.filter((h) => h.revision !== revision), { revision, verdictLabel: verdict.label, at: deps.now().toISOString(), leads: args.leadsReport ?? { considered: args.leads.length > 0 }, warningSignals }],
    inputHash: inputHashFor(args.inputHashImages, ctx.pageText, ctx.needs, deps.config.pipelineVersion),
    ...(args.answered ? { answered: args.answered } : {}),
  });

  emit("warning_signals", warningSignals);
  emit("verdict", verdict);
  emit("next_moves", nextMoves);
  args.beforeDone?.(verdict);
  return { verdict, checks: args.checks };
}

