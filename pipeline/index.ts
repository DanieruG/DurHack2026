import type { CheckResult, IdentifyResult, ListingFacts, UserNeeds } from "@/schemas/domain";
import type { Deps } from "./deps";
import { emptyFacts } from "./extract";
import { examineListing } from "./examine";
import { buildNeeds } from "./needs";
import { brandKnown } from "./identify";
import { inputHashFor, intakeImages, prepareText, type CaseRequest } from "./intake";
import { followLeads, NO_BRAND_SKIP, skipLeads } from "./leads";
import { buildCtx, runDownstream, runIdentify, toIdentifyCheck } from "./runChecks";
import { runStage, type StageStats } from "./util";
import { scopeListingImages } from "@/lib/listingScope";
import { finalise, instrumented, loadImages, loadPageText, saveSurvey } from "./core";
import { guardSearchHint } from "./identify";
import { prepareSurvey, sanitiseQuery, type Survey } from "@/lib/observed";
import { applyVersionCheck, modelFromPhotosOnly, runVersionCheck } from "./versionCheck";
import { factsFromPageOnly, mergeListingFacts, redactListingData } from "./listingData";
import { determineListingColour } from "./listingColour";
import type { ListingData } from "@/schemas/domain";

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
  // The survey is held in memory for the run; only its matched subset is stored, once the model is known.
  const survey = prepareSurvey(req.capture.observedListings, { platform, pageUrl: req.capture.pageUrl, searchQuery: req.capture.searchQuery });
  // Only this listing's own photos: drop other listings' thumbnails and size variants of the same photo.
  const done = runInvestigation(deps, row.id, {
    imageUrls: scopeListingImages(req.capture.imageUrls ?? [], platform),
    listing: redactListingData(req.capture.listing),
    survey,
    searchQuery: sanitiseQuery(req.capture.searchQuery),
  });
  return { caseId: row.id, done };
}

function profileFromNeeds(needs: UserNeeds) {
  return { sizes: needs.sizes, ...(needs.defaultSize ? { defaultSize: needs.defaultSize } : {}), priorities: needs.priorities, budgetGBP: needs.budgetGBP, wearTolerance: needs.wearTolerance };
}

/** The investigation pipeline (spec 7.2). Always reaches a verdict unless something unexpected throws. */
export async function runInvestigation(
  deps: Deps,
  caseId: string,
  opts: { imageUrls: string[]; survey?: Survey | null; searchQuery?: string | null; listing?: ListingData },
): Promise<void> {
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
    const examineStats: StageStats = { geminiCalls: 0, cachedCalls: 0, functionCalls: 0 };
    const [examined, needs] = await Promise.all([
      runStage("extract", { emit, timeoutMs: config.stageTimeoutMs, geminiFeatures: ["vision", "structured_output"], stats: examineStats }, () =>
        examineListing(deps.gemini, { pageText, images, platform: c.platform, catalogue: ref.catalogue, readReferenceImage: deps.readReferenceImage, searchQuery: opts.searchQuery, listing: opts.listing }),
      ).catch(() => null),
      c.needs.caseNote
        ? runStage("needs", { emit, timeoutMs: config.stageTimeoutMs }, () => buildNeeds(profileFromNeeds(c.needs), c.needs.caseNote, deps.gemini)).catch(() => c.needs)
        : Promise.resolve(c.needs),
    ]);
    if (!examined) emit("error", { stage: "extract", message: "I couldn't read the listing details, so some checks may be unknown." });
    // The page's own data first; Gemini fills only what it doesn't give.
    const merged: ListingFacts = examined ? mergeListingFacts(examined.facts, opts.listing) : opts.listing ? factsFromPageOnly(c.platform, images.length, opts.listing) : emptyFacts(c.platform, images.length);
    // The listing's colour (style code, colour field, title words, then the main photo) targets the new-price search.
    const listingColour = await determineListingColour({ facts: merged, mainPhoto: images[0] }).catch(() => undefined);
    const facts: ListingFacts = listingColour ? { ...merged, listingColour } : merged;

    const ctx = buildCtx({ deps, caseId, revision: c.revision, emit, ref, images, pageText, facts, needs, identify: null, survey: opts.survey ?? null, searchQuery: opts.searchQuery ?? null });
    // The search hint never decides on its own: a model only the search names (no text, no photo) stays below the gate.
    const hintGuard = (r: IdentifyResult) =>
      guardSearchHint(r, { searchQuery: opts.searchQuery, listingText: [facts.title, facts.modelText, pageText].filter(Boolean).join("\n"), catalogue: ref.catalogue, min: config.identifyConfidenceMin });
    let identifyCheck: CheckResult;
    if (examined) {
      ctx.identify = hintGuard(examined.identify);
      identifyCheck = { ...toIdentifyCheck(ctx, ctx.identify), usage: { geminiCalls: examineStats.geminiCalls, cachedCalls: examineStats.cachedCalls } };
      // The identification came with the merged call; mark the stage so the progress log shows it.
      emit("stage_started", { stage: "identify", geminiFeatures: ["vision", "structured_output"] });
      emit("stage_done", { stage: "identify", geminiFeatures: ["vision", "structured_output"], geminiCalls: 0, cachedCalls: 0 });
    } else {
      // The merged call failed: identify on its own so the case still has a chance.
      const r = await runIdentify(ctx);
      ctx.identify = hintGuard(r.result);
      identifyCheck = ctx.identify === r.result ? r.check : toIdentifyCheck(ctx, ctx.identify);
    }
    const identify = ctx.identify!;
    emit("check_done", identifyCheck);

    // A model read only from the photos is checked by Gemini Pro, in parallel with the other checks (max 15s).
    const versionCheck = modelFromPhotosOnly(identify, ctx.facts, ctx.pageText, ref.catalogue) && ctx.images.length ? runVersionCheck(ctx) : null;
    // Each check runs on whatever identify established (brand / model / catalogue); condition runs on photos alone.
    const downstream = await runDownstream(ctx);
    let all = [identifyCheck, ...downstream];
    if (versionCheck) all = await applyVersionCheck(ctx, await versionCheck, all);
    // Without a brand the verdict is R1 whatever the leads find, so don't spend calls on them.
    const { checks, leads, report } = brandKnown(identify, config.identifyConfidenceMin, ref.catalogue) ? await followLeads(ctx, all) : skipLeads(ctx, all, NO_BRAND_SKIP);
    await saveSurvey(ctx);
    await finalise(ctx, { checks, leads, leadsReport: report, row: c, inputHashImages: images });
  });
}

/** Fire-and-forget wrapper used by the route handlers. */
export function startInBackground(p: Promise<unknown>): void {
  p.catch((err) => console.error("[sleuth] background investigation failed", err));
}
