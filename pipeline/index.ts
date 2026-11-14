import type { CheckResult, ListingFacts, UserNeeds } from "@/schemas/domain";
import type { Deps } from "./deps";
import { emptyFacts } from "./extract";
import { examineListing } from "./examine";
import { buildNeeds } from "./needs";
import { brandKnown } from "./identify";
import { inputHashFor, intakeImages, prepareText, type CaseRequest } from "./intake";
import { followLeads, NO_BRAND_SKIP, skipLeads } from "./leads";
import { buildCtx, runDownstream, runIdentify, toIdentifyCheck } from "./runChecks";
import { runStage } from "./util";
import { scopeListingImages } from "@/lib/listingScope";
import { finalise, instrumented, loadImages, loadPageText } from "./core";

export { reopenCase, startReopen, ReopenConflictError } from "./reopen";
export { finalise, instrumented, loadImages } from "./core";

/** Strip query and fragment from the listing URL before storing it (display + platform detection only). */
export function displayUrl(pageUrl: string | undefined): string | null {
  if (!pageUrl) return null;
  try {
    const u = new URL(pageUrl);
    return `${u.origin}${u.pathname}`;
  } catch {
    return null;
  }
}

/** POST /api/cases: store the case and its inputs, then start the investigation in the background. */
export async function createCase(deps: Deps, req: CaseRequest): Promise<{ caseId: string; done: Promise<void> }> {
  const { platform, pageText } = prepareText(req.capture);
  const needs = await buildNeeds(req.profile, req.caseNote, null);
  const row = await deps.store.createCase({
    status: "investigating",
    platform,
    pageUrl: displayUrl(req.capture.pageUrl),
    inputHash: inputHashFor(
      req.screenshots.map((s, index) => ({ ...s, index })),
      pageText + JSON.stringify(req.capture.imageUrls ?? []),
      needs,
      deps.config.pipelineVersion,
    ),
    needs,
  });
  await deps.store.addInputs(row.id, [
    ...(pageText ? [{ revision: 1, kind: "page_text" as const, text: pageText }] : []),
    ...req.screenshots.map((s, i) => ({ revision: 1, kind: "screenshot" as const, mimeType: s.mimeType, data: s.bytes, position: i })),
  ]);
  deps.hub.startRevision(row.id, 1);
  // Only this listing's own photos: drop other listings' thumbnails and size variants of the same photo.
  const done = runInvestigation(deps, row.id, { imageUrls: scopeListingImages(req.capture.imageUrls ?? [], platform) });
  return { caseId: row.id, done };
}

function profileFromNeeds(needs: UserNeeds) {
  return { sizes: needs.sizes, priorities: needs.priorities, budgetGBP: needs.budgetGBP, wearTolerance: needs.wearTolerance };
}

/** The investigation pipeline (spec 7.2). Always reaches a verdict unless something unexpected throws. */
export async function runInvestigation(deps: Deps, caseId: string, opts: { imageUrls: string[] }): Promise<void> {
  const c = await deps.store.getCase(caseId);
  if (!c) throw new Error(`Case ${caseId} not found`);
  if (!deps.hub.has(caseId)) deps.hub.startRevision(caseId, c.revision);
  const { config } = deps;

  await instrumented(deps, caseId, c.revision, async (emit) => {
    emit("investigation_started", { caseId, revision: c.revision });

    await runStage("intake", { emit, timeoutMs: config.stageTimeoutMs + 6000 }, () =>
      intakeImages(deps, { caseId, revision: c.revision, imageUrls: opts.imageUrls, emit, existingImageCount: 0 }),
    ).catch(() => emit("capture_warning", { message: "The listing photos couldn't be loaded" }));

    const [images, pageText, ref] = await Promise.all([loadImages(deps, caseId), loadPageText(deps, caseId), deps.store.getReference()]);
    if (images.length === 0) emit("capture_warning", { message: "No photos available, so condition can't be checked" });

    // One Flash call reads the listing and identifies the pair (extract + identify merged).
    const [examined, needs] = await Promise.all([
      runStage("extract", { emit, timeoutMs: config.stageTimeoutMs, geminiFeatures: ["vision", "structured_output"] }, () =>
        examineListing(deps.gemini, { pageText, images, platform: c.platform, catalogue: ref.catalogue, readReferenceImage: deps.readReferenceImage }),
      ).catch(() => null),
      c.needs.caseNote
        ? runStage("needs", { emit, timeoutMs: config.stageTimeoutMs }, () => buildNeeds(profileFromNeeds(c.needs), c.needs.caseNote, deps.gemini)).catch(() => c.needs)
        : Promise.resolve(c.needs),
    ]);
    if (!examined) emit("error", { stage: "extract", message: "I couldn't read the listing details, so some checks may be unknown." });
    const facts: ListingFacts = examined?.facts ?? emptyFacts(c.platform, images.length);

    const ctx = buildCtx({ deps, caseId, revision: c.revision, emit, ref, images, pageText, facts, needs, identify: null });
    let identifyCheck: CheckResult;
    if (examined) {
      ctx.identify = examined.identify;
      identifyCheck = toIdentifyCheck(ctx, examined.identify);
      // The identification came with the merged call; mark the stage so the progress log shows it.
      emit("stage_started", { stage: "identify", geminiFeatures: ["vision", "structured_output"] });
      emit("stage_done", { stage: "identify", geminiFeatures: ["vision", "structured_output"] });
    } else {
      // The merged call failed: identify on its own so the case still has a chance.
      const r = await runIdentify(ctx);
      ctx.identify = r.result;
      identifyCheck = r.check;
    }
    const identify = ctx.identify!;
    emit("check_done", identifyCheck);

    // Each check runs on whatever identify established (brand / model / catalogue); condition runs on photos alone.
    const downstream = await runDownstream(ctx);
    // Without a brand the verdict is R1 whatever the leads find, so don't spend calls on them.
    const all = [identifyCheck, ...downstream];
    const { checks, leads, report } = brandKnown(identify, config.identifyConfidenceMin, ref.catalogue) ? await followLeads(ctx, all) : skipLeads(ctx, all, NO_BRAND_SKIP);
    await finalise(ctx, { checks, leads, leadsReport: report, row: c, inputHashImages: images });
  });
}

/** Fire-and-forget wrapper used by the route handlers. */
export function startInBackground(p: Promise<unknown>): void {
  p.catch((err) => console.error("[sleuth] background investigation failed", err));
}
