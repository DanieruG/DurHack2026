import type { Evidence, IdentifyResult, ListingFacts } from "@/schemas/domain";
import type { CatalogueModel } from "@/schemas/seed";
import { bestGuessOf, candidateName } from "@/lib/identifyLabel";
import type { LensMatch } from "@/lib/lens";
import { identifyProduct } from "./identify";
import { listingNamesModel } from "./identifyLevel";
import type { RunCtx } from "./runChecks";
import { evidenceIds, runStage } from "./util";

/**
 * Google Lens for vague listings. Runs only when the listing's title doesn't name the model, or identification is still
 * below "likely" after the first pass. It searches the main photo (and the clearest side profile) by URL, then identifies
 * again with the top visual matches as extra evidence, clearly marked as visual matches and not facts.
 * It runs before the pause for the buyer's confirmation: identification includes it, and nothing searches while paused.
 */

/** Matches handed to the second identify pass. */
export const MAX_LENS_MATCHES = 8;

export function shouldRunLens(identify: IdentifyResult | null, facts: ListingFacts, catalogue: CatalogueModel[]): boolean {
  if (!identify) return true;
  const level = identify.confidenceLevel;
  if (level === "user_confirmed") return false;
  return !listingNamesModel(identify, facts, catalogue) || level === "possible" || level === "best_guess";
}

/** Public URLs of the main photo and the clearest side profile (when it is a different photo). */
export function lensPhotoUrls(images: { index: number; sourceUrl?: string }[], identify: IdentifyResult | null): string[] {
  const urlOf = (index: number) => images.find((i) => i.index === index)?.sourceUrl;
  const wanted = [images.length ? urlOf(0) ?? images[0].sourceUrl : undefined, identify?.sideProfilePhotoIndex !== undefined ? urlOf(identify.sideProfilePhotoIndex) : undefined];
  return [...new Set(wanted.filter((u): u is string => !!u && /^https?:\/\//i.test(u)))];
}

/** Matches from every photo, one per link, interleaved so each photo contributes. */
function mergeMatches(perPhoto: LensMatch[][]): LensMatch[] {
  const out: LensMatch[] = [];
  const seen = new Set<string>();
  for (let i = 0; out.length < MAX_LENS_MATCHES && perPhoto.some((m) => i < m.length); i++) {
    for (const m of perPhoto) {
      if (i < m.length && !seen.has(m[i].link) && out.length < MAX_LENS_MATCHES) {
        seen.add(m[i].link);
        out.push(m[i]);
      }
    }
  }
  return out;
}

/** Search Lens and re-identify. Never throws: on any failure the first identification stands. */
export async function runLens(ctx: RunCtx, identify: IdentifyResult): Promise<IdentifyResult> {
  if (ctx.paused) return identify; // nothing searches while the buyer is being asked
  const urls = lensPhotoUrls(ctx.images, identify);
  if (!urls.length) return identify;
  const { deps } = ctx;
  let live = 0;
  const perPhoto: LensMatch[][] = [];
  try {
    await runStage("lens", { emit: ctx.emit, timeoutMs: deps.config.stageTimeoutMs, geminiFeatures: [] }, async () => {
      const settled = await Promise.allSettled(urls.map((u) => deps.lens.visualMatches(u)));
      for (const r of settled) {
        if (r.status !== "fulfilled") continue;
        perPhoto.push(r.value.matches);
        if (!r.value.fromCache) live++;
      }
    });
  } catch {
    // A timeout keeps whatever came back in time (nothing is added after the stage ends).
  }
  const matches = mergeMatches(perPhoto);
  const lens = { photos: urls.length, live, changedAnswer: false };
  if (!matches.length) return { ...identify, lens };

  // The second pass is part of the "lens" stage above in the progress log, so it emits no stage events of its own.
  let second: IdentifyResult | null = null;
  try {
    second = await runStage("identify", { emit: () => undefined, timeoutMs: deps.config.stageTimeoutMs, geminiFeatures: ["vision", "structured_output"] }, () =>
      identifyProduct(deps.gemini, {
        facts: ctx.facts,
        images: ctx.images,
        pageText: ctx.pageText,
        catalogue: ctx.ref.catalogue,
        readReferenceImage: deps.readReferenceImage,
        visualMatches: matches,
      }),
    );
  } catch {
    second = null;
  }
  // Adopt the second pass only if it names a model; otherwise the first stands (with the matches still recorded).
  const adopted = second && (second.modelName || second.catalogueModelId) ? second : identify;
  const nextId = evidenceIds("lens");
  const evidence: Evidence[] = matches.map((m) => ({ id: nextId(), kind: "source", label: `Visual match: ${m.title}`, title: m.title, url: m.link, ...(m.source ? { domain: m.source } : {}), sourceType: "other" }));
  const changedAnswer = candidateName(bestGuessOf(adopted)) !== candidateName(bestGuessOf(identify));
  return {
    ...adopted,
    evidence: [...adopted.evidence, ...evidence],
    lensMatches: matches.map((m) => ({ title: m.title, source: m.source, url: m.link })),
    ...(adopted.sideProfilePhotoIndex === undefined && identify.sideProfilePhotoIndex !== undefined ? { sideProfilePhotoIndex: identify.sideProfilePhotoIndex } : {}),
    lens: { ...lens, changedAnswer },
  };
}
