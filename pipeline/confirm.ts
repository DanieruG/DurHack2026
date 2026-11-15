import type { CheckName, CheckResult, IdentifyResult, ListingFacts } from "@/schemas/domain";
import type { CaseRow, RunTotals } from "@/lib/store";
import type { Deps } from "./deps";
import { emptyFacts } from "./extract";
import { brandKnown } from "./identify";
import { applyIdentityChoice, InvalidChoiceError, type IdentityChoice } from "./identityCheck";
import { normaliseIdentify } from "./identifyLevel";
import { RequestError } from "./intake";
import { finalise, instrumented, loadImages, loadPageText, loadSurvey, saveSurvey } from "./core";
import { followLeads, skipLeads } from "./leads";
import { diffCases } from "./reopen";
import { buildCtx, DOWNSTREAM, runDownstream, toIdentifyCheck } from "./runChecks";
import { synthesizeEvents } from "./views";

/** The case isn't waiting for an answer and can't be corrected right now (still running, or errored). */
export class ConfirmConflictError extends Error {
  constructor(message = "This case is still being investigated; try again when it finishes") {
    super(message);
    this.name = "ConfirmConflictError";
  }
}

export const SKIPPED_LEADS = "Skipped: you skipped confirming the model, so no follow-up searches were run.";

/** After a restart the in-memory event buffer is gone: rebuild it from the database so ids keep counting up on the same stream. */
async function ensureBuffer(deps: Deps, c: CaseRow): Promise<void> {
  if (deps.hub.has(c.id)) return;
  deps.hub.startRevision(c.id, c.revision);
  for (const e of await synthesizeEvents(deps, c)) deps.hub.emit(c.id, e.event, e.data as never);
}

async function pausedTotals(deps: Deps, caseId: string, revision: number): Promise<RunTotals | undefined> {
  const rows = await deps.store.getInputs(caseId, { kinds: ["pause_state"], revision, withData: false });
  try {
    return rows.length ? (JSON.parse(rows[rows.length - 1].text ?? "") as RunTotals) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * POST /api/cases/:id/confirm-identity. While the case is "awaiting_confirmation" the investigation resumes (same revision)
 * with the buyer's answer; on a closed case the same answer is a correction ("Not right?"): the model-dependent checks rerun
 * as a new revision. Returns null when the case doesn't exist.
 */
export async function startConfirm(deps: Deps, caseId: string, choice: IdentityChoice): Promise<{ revision: number; done: Promise<void> } | null> {
  const c = await deps.store.getCase(caseId);
  if (!c) return null;
  const waiting = c.status === "awaiting_confirmation";
  if (!waiting && c.status !== "closed") throw new ConfirmConflictError();
  if (!waiting && choice.choice === "skip") throw new RequestError("Skip only applies while the investigation is waiting for you", 409);
  const current = normaliseIdentify(c.identify);
  if (!current) throw new RequestError("This case has no identification to confirm", 409);

  const ref = await deps.store.getReference();
  const facts: ListingFacts = c.listingFacts ?? emptyFacts(c.platform, 0);
  let next: IdentifyResult;
  try {
    next = applyIdentityChoice(current, choice, { catalogue: ref.catalogue, facts, now: deps.now().toISOString() });
  } catch (err) {
    if (err instanceof InvalidChoiceError) throw new RequestError(err.message, 400);
    throw err;
  }
  return waiting ? resume(deps, c, next, choice, facts) : correct(deps, c, next, facts);
}

/** Continue the paused investigation with the confirmed (or skipped) model. */
async function resume(deps: Deps, c: CaseRow, identify: IdentifyResult, choice: IdentityChoice, facts: ListingFacts) {
  const caseId = c.id;
  const revision = c.revision;
  await ensureBuffer(deps, c);
  await deps.store.updateCase(caseId, { status: "investigating", identify });
  const carry = await pausedTotals(deps, caseId, revision);

  const done = instrumented(
    deps,
    caseId,
    revision,
    async (emit) => {
      const [images, pageText, ref, survey, stored] = await Promise.all([
        loadImages(deps, caseId),
        loadPageText(deps, caseId),
        deps.store.getReference(),
        loadSurvey(deps, caseId),
        deps.store.getChecks(caseId, revision),
      ]);
      const ctx = buildCtx({ deps, caseId, revision, emit, ref, images, pageText, facts, needs: c.needs, identify, survey });
      ctx.modelSkipped = choice.choice === "skip";
      emit("check_done", toIdentifyCheck(ctx, identify));
      if (identify.userChoice?.warning) emit("capture_warning", { message: identify.userChoice.warning });
      const identifyCheck = toIdentifyCheck(ctx, identify);
      const previous = (stored as CheckResult[]).filter((x) => x.check !== "identify");
      const all = [identifyCheck, ...(await runDownstream(ctx, ["price", "comfort"], previous))];
      const outcome = ctx.modelSkipped || !brandKnown(identify, ref.catalogue) ? skipLeads(ctx, all, SKIPPED_LEADS) : await followLeads(ctx, all);
      await saveSurvey(ctx);
      await finalise(ctx, { checks: outcome.checks, leads: outcome.leads, leadsReport: outcome.report, row: c, inputHashImages: images });
    },
    { carry },
  );
  return { revision, done };
}

/** "Not right?" on a finished case: the corrected model reruns every check as a new revision, with a diff against the last one. */
async function correct(deps: Deps, c: CaseRow, identify: IdentifyResult, facts: ListingFacts) {
  const caseId = c.id;
  const fromRevision = c.revision;
  const revision = fromRevision + 1;
  await deps.store.updateCase(caseId, { revision, status: "investigating", identify });
  deps.hub.startRevision(caseId, revision);

  const done = instrumented(deps, caseId, revision, async (emit) => {
    emit("case_reopened", { caseId, revision });
    const [before, prevLeads, images, pageText, ref, survey] = await Promise.all([
      deps.store.getChecks(caseId, fromRevision),
      deps.store.getLeads(caseId, fromRevision),
      loadImages(deps, caseId),
      loadPageText(deps, caseId),
      deps.store.getReference(),
      loadSurvey(deps, caseId),
    ]);
    const ctx = buildCtx({ deps, caseId, revision, emit, ref, images, pageText, facts, needs: c.needs, identify, survey });
    const identifyCheck = toIdentifyCheck(ctx, identify);
    emit("check_done", identifyCheck);
    if (identify.userChoice?.warning) emit("capture_warning", { message: identify.userChoice.warning });
    const checks = [identifyCheck, ...(await runDownstream(ctx, DOWNSTREAM, []))];
    await saveSurvey(ctx);
    const answered = c.answered;
    // Leads aren't rerun; questions for the seller that are still unanswered carry over, as on reopen.
    const leads = prevLeads.filter((l) => l.type === "flag_for_seller" && l.relatesTo && !answered.includes(l.relatesTo));
    const verdictBefore = c.verdict?.label ?? "not_enough_evidence";
    const rerun = new Set<CheckName>(["identify", ...DOWNSTREAM]);
    await finalise(ctx, {
      checks,
      leads,
      row: c,
      inputHashImages: images,
      answered,
      beforeDone: (verdict) =>
        emit("diff", diffCases({ fromRevision, toRevision: revision, before, after: checks, rerun, reasons: { identify: "You corrected the model" }, verdictBefore, verdictAfter: verdict.label })),
    });
  });
  return { revision, done };
}
