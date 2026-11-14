import type { CheckName, CheckResult, IdentifyResult, Lead, Verdict } from "@/schemas/domain";
import { withCallLog, type CallLogEntry } from "@/gemini/client";
import type { CaseRow } from "@/lib/store";
import type { Deps } from "./deps";
import type { Emit } from "./events";
import { passesGate } from "./identify";
import { inputHashFor, toCaseImages, type CaseImage } from "./intake";
import { generateNextMoves } from "./nextMoves";
import type { RunCtx } from "./runChecks";
import { decideAndWordVerdict } from "./verdict/wording";
import { runStage } from "./util";

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
  emit("investigation_done", { caseId, revision, durationMs: Date.now() - started, geminiCalls: log.length });
  logTotals(caseId, log, Date.now() - started);
}

function logTotals(caseId: string, log: CallLogEntry[], ms: number) {
  if (process.env.VITEST) return;
  const tokens = log.reduce((s, e) => s + (e.promptTokens ?? 0) + (e.outputTokens ?? 0), 0);
  console.info(`[sleuth] case=${caseId} done in ${ms}ms, ${log.length} Gemini calls (${log.filter((l) => l.cached).length} cached), ${tokens} tokens`);
}

export type FinaliseResult = { verdict: Verdict; checks: CheckResult[] };

/** Verdict (rules + wording), next moves, persist, emit. Shared by investigations and reopen. */
export async function finalise(
  ctx: RunCtx,
  args: {
    checks: CheckResult[];
    leads: Lead[];
    row: CaseRow;
    inputHashImages: CaseImage[];
    answered?: CheckName[];
    beforeDone?: (verdict: Verdict) => void;
  },
): Promise<FinaliseResult> {
  const { deps, emit, caseId, revision } = ctx;
  const timeoutMs = deps.config.stageTimeoutMs;
  const identifyPassed = passesGate(ctx.identify, deps.config.identifyConfidenceMin);

  const { verdict } = await runStage("verdict", { emit, timeoutMs, geminiFeatures: ["structured_output"] }, () =>
    decideAndWordVerdict(deps.gemini, { checks: args.checks, identifyPassed, extraEvidence: ctx.facts.evidence }),
  ).catch(() => decideAndWordVerdict(null, { checks: args.checks, identifyPassed, extraEvidence: ctx.facts.evidence }));

  const nextMoves = await runStage("next_moves", { emit, timeoutMs, geminiFeatures: ["structured_output"] }, () =>
    generateNextMoves(deps.gemini, { checks: args.checks, leads: args.leads, label: verdict.label, answered: args.answered }),
  ).catch(() => generateNextMoves(null, { checks: args.checks, leads: args.leads, label: verdict.label, answered: args.answered }));

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
    history: [...args.row.history.filter((h) => h.revision !== revision), { revision, verdictLabel: verdict.label, at: deps.now().toISOString() }],
    inputHash: inputHashFor(args.inputHashImages, ctx.pageText, ctx.needs, deps.config.pipelineVersion),
    ...(args.answered ? { answered: args.answered } : {}),
  });

  emit("verdict", verdict);
  emit("next_moves", nextMoves);
  args.beforeDone?.(verdict);
  return { verdict, checks: args.checks };
}

