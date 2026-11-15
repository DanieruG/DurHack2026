import type { CheckName, CheckResult, ConditionGrade, IdentifyResult, ListingFacts, UserNeeds } from "@/schemas/domain";
import type { SizeChart } from "@/schemas/seed";
import type { ReferenceData } from "@/lib/seedData";
import { makeToolExecutors, type ToolExecutor } from "@/gemini/tools";
import type { Tier } from "@/gemini/client";
import type { Deps } from "./deps";
import type { Emit } from "./events";
import type { CaseImage } from "./intake";
import { identifyCheck, identifyProduct, subjectOf, type Subject } from "./identify";
import { normaliseIdentify } from "./identifyLevel";
import { candidateName, fullModelName } from "@/lib/identifyLabel";
import { applyReviewSizingNote, checkFit, type SizingAdvice } from "./checks/fit";
import { checkPrice } from "./checks/price";
import type { NewPrices } from "@/lib/newPrices";
import { checkComfort } from "./checks/comfort";
import { checkCondition } from "./checks/condition";
import { checkColour } from "./checks/colour";
import { plainError, runStage, today, unknownCheck, type StageStats } from "./util";
import { matchSurvey, modelUnknownComparison, noAlternatives, userSizeUK, type MatchedListing, type Survey } from "@/lib/observed";
import { catalogueTokens, deriveTokens, type ModelTokens } from "@/lib/titleMatch";
import { matchOfferColours } from "./offerColour";

const THUMBNAIL_TIMEOUT_MS = 4000;

/** An offer thumbnail's bytes (downloaded here: the browser can't read pixels from other sites), or null. */
async function fetchThumbnail(ctx: RunCtx, url: string): Promise<Uint8Array | null> {
  try {
    const img = await Promise.race([ctx.deps.fetchImage(url), new Promise<null>((r) => setTimeout(() => r(null), THUMBNAIL_TIMEOUT_MS))]);
    return img ? img.bytes : null;
  } catch {
    return null;
  }
}

export type DownstreamCheck = Exclude<CheckName, "identify">;
/** "colour" only runs when the buyer asked for a colour or look (runDownstream drops it otherwise). */
export const DOWNSTREAM: DownstreamCheck[] = ["fit", "price", "comfort", "condition", "colour"];

/** Everything a check needs; built once per investigation (and per reopen). */
export type RunCtx = {
  deps: Deps;
  caseId: string;
  revision: number;
  emit: Emit;
  ref: ReferenceData;
  images: CaseImage[];
  pageText: string;
  facts: ListingFacts;
  needs: UserNeeds;
  identify: IdentifyResult | null;
  executors: Partial<Record<string, ToolExecutor>>;
  today: string;
  /** Google Shopping new prices for a model, memoised per case (the price check and the Gemini tool share one request). */
  newPrices: (modelName: string, brand: string) => Promise<NewPrices>;
  /** Models ("brand model", lower case) whose new prices Gemini fetched via the getNewPrices tool. */
  newPricesViaTool: Set<string>;
  /** The Gemini Pro version check already ran: the recheck_identification lead would only repeat it. */
  versionChecked?: boolean;
  /** The user's survey of a search on this platform (Feature A), or null. Matched to the model when price runs. */
  survey?: Survey | null;
  /** The user's marketplace search: an identify hint only. */
  searchQuery?: string | null;
  /** Waiting for the buyer to confirm the model: no search (Shopping, web or Lens) may run. */
  paused?: boolean;
  /** The buyer skipped confirming: model-dependent checks are unknown and nothing searches. */
  modelSkipped?: boolean;
};

const PAUSED_MESSAGE = "A search was attempted while the investigation is waiting for the buyer to confirm the model";

const priceKey = (modelName: string, brand: string) => `${brand} ${modelName}`.toLowerCase().replace(/\s+/g, " ").trim();

export function buildCtx(base: Omit<RunCtx, "executors" | "today" | "newPrices" | "newPricesViaTool">): RunCtx {
  const memo = new Map<string, Promise<NewPrices>>();
  // The listing's colour targets the Shopping query: its style code first, else its main colour name.
  const colourOpts = () => ({ styleCode: ctx.facts.styleCode, colour: ctx.facts.listingColour?.names[0] });
  const newPrices = (modelName: string, brand: string) => {
    const o = colourOpts();
    const k = `${priceKey(modelName, brand)}|${o.styleCode ?? ""}|${o.colour ?? ""}`;
    let p = memo.get(k);
    if (ctx.paused) return Promise.reject(new Error(PAUSED_MESSAGE));
    if (!p) {
      p = base.deps.newPrices.getNewPrices(modelName, brand, { ...(o.styleCode ? { styleCode: o.styleCode } : {}), ...(o.colour ? { colour: o.colour } : {}) });
      p.catch(() => memo.delete(k)); // a failed lookup may be retried by a later lead
      memo.set(k, p);
    }
    return p;
  };
  const newPricesViaTool = new Set<string>();
  const executors = makeToolExecutors(base.ref, (modelName, brand) => {
    newPricesViaTool.add(priceKey(modelName, brand));
    return newPrices(modelName, brand);
  });
  const ctx: RunCtx = { ...base, executors, newPrices, newPricesViaTool, today: today(base.deps.now()) };
  return ctx;
}

/** What identify established, by tier (brand / model name / catalogue match). */
export function subjectFor(ctx: RunCtx): Subject {
  return subjectOf(ctx.identify, ctx.ref.catalogue);
}

/** Identify on its own (Flash; the recheck lead passes tier "strong"). New investigations use the merged call instead. */
export async function runIdentify(ctx: RunCtx, opts: { onlyPhotoIndex?: number; tier?: Tier } = {}): Promise<{ result: IdentifyResult; check: CheckResult }> {
  const { config } = ctx.deps;
  try {
    const result = await runStage("identify", { emit: ctx.emit, timeoutMs: config.stageTimeoutMs, geminiFeatures: ["vision", "structured_output"] }, () =>
      identifyProduct(ctx.deps.gemini, {
        facts: ctx.facts,
        images: ctx.images,
        pageText: ctx.pageText,
        catalogue: ctx.ref.catalogue,
        readReferenceImage: ctx.deps.readReferenceImage,
        onlyPhotoIndex: opts.onlyPhotoIndex,
        tier: opts.tier,
      }),
    );
    return { result, check: toIdentifyCheck(ctx, result) };
  } catch (err) {
    const result: IdentifyResult = { brand: null, brandConfidence: 0, modelName: null, catalogueModelId: null, inCatalogue: false, confidence: 0, reasons: "Identification failed", evidence: [], alternatives: [], confidenceLevel: "best_guess" };
    return { result, check: unknownCheck("identify", plainError("identify", err), { details: { tier: "none", catalogueModelId: null, inCatalogue: false } }) };
  }
}

/** The identification is only a "possible" or "best_guess": model-dependent checks run on it, but say so. */
export function isUncertain(ctx: RunCtx): boolean {
  const level = normaliseIdentify(ctx.identify)?.confidenceLevel;
  return level === "possible" || level === "best_guess";
}

/** The best guess first, then its alternatives, each as something to look up. */
function priceCandidates(ctx: RunCtx, subject: Subject): { name: string; lookup: () => ReturnType<RunCtx["newPrices"]> }[] {
  const first = { name: subject.displayName!, lookup: () => ctx.newPrices(subject.modelName!, subject.brand!) };
  const rest = (ctx.identify?.alternatives ?? []).flatMap((a) => {
    const model = fullModelName(a.model, a.version);
    const brand = a.brand ?? subject.brand;
    return model && brand ? [{ name: candidateName(a)!, lookup: () => ctx.newPrices(model, brand) }] : [];
  });
  return [first, ...rest];
}

export type CheckOpts = { priceCondition?: ConditionGrade; forceSourceB?: boolean };

export function toIdentifyCheck(ctx: RunCtx, result: IdentifyResult): CheckResult {
  return identifyCheck(result, { catalogue: ctx.ref.catalogue, hadImages: ctx.images.length > 0 });
}

/** Run one downstream check as a stage. Errors and timeouts become `unknown` with a plain explanation. */
export async function runCheck(ctx: RunCtx, name: DownstreamCheck, opts: CheckOpts = {}): Promise<CheckResult> {
  const subject = subjectFor(ctx);
  // Tiers: brand -> fit; model name -> comfort + new-price search; catalogue match -> sampled prices too; photos -> condition always.
  if (ctx.modelSkipped && (name === "price" || name === "comfort")) {
    const what = name === "price" ? "compare the price" : "check reviews for comfort";
    const observed = name === "price" ? { details: { skipped: true, ...(ctx.survey ? { observedComparison: modelUnknownComparison(ctx.survey) } : {}), observedAlternatives: emitNoAlternatives(ctx) } } : { details: { skipped: true } };
    return unknownCheck(name, `You skipped confirming the model, so I didn't search to ${what}.`, observed);
  }
  if (name === "fit" && !subject.brand) return unknownCheck("fit", "I couldn't tell the brand, so I can't check the fit.");
  if ((name === "price" || name === "comfort") && !subject.modelName) {
    const what = name === "price" ? "compare the price" : "check reviews for comfort";
    const observed =
      name === "price"
        ? { details: { ...(ctx.survey ? { observedComparison: modelUnknownComparison(ctx.survey) } : {}), observedAlternatives: emitNoAlternatives(ctx) } }
        : {};
    return unknownCheck(name, `I couldn't tell the exact model from this listing, so I can't ${what}.`, observed);
  }
  const { deps } = ctx;
  const uncertain = isUncertain(ctx);
  const timeoutMs = deps.config.stageTimeoutMs;
  const features = {
    fit: [],
    price: [],
    comfort: ["structured_output"],
    condition: ["vision", "object_detection", "structured_output"],
    colour: ["vision", "structured_output"],
  } as const;
  const stats: StageStats = { geminiCalls: 0, cachedCalls: 0, functionCalls: 0 };
  try {
    const result = await runStage(name, { emit: ctx.emit, timeoutMs, geminiFeatures: [...features[name]], stats }, async () => {
      switch (name) {
        case "fit":
          return checkFit({ facts: ctx.facts, needs: ctx.needs, brand: subject.brand!, chart: chartFor(subject, ctx.ref.sizeCharts), charts: ctx.ref.sizeCharts });
        case "price":
          return checkPrice({
            facts: ctx.facts,
            needs: ctx.needs,
            model: { id: subject.catalogue?.id ?? null, brand: subject.brand!, name: subject.modelName! },
            samples: ctx.ref.priceSamples,
            lookupNewPrices: () => ctx.newPrices(subject.modelName!, subject.brand!),
            calledViaTool: () => ctx.newPricesViaTool.has(priceKey(subject.modelName!, subject.brand!)),
            condition: opts.priceCondition,
            forceSourceB: opts.forceSourceB,
            onNewOffers: (offers) => ctx.emit("new_offers", offers),
            assessOfferColours: (offers) => matchOfferColours(offers, ctx.facts.listingColour, { fetchThumbnail: (url) => fetchThumbnail(ctx, url) }),
            observed: uncertain ? undefined : observedFor(ctx, subject),
            conditional: uncertain ? { candidates: priceCandidates(ctx, subject) } : undefined,
            assessListingColours: (candidates) => matchOfferColours(candidates, ctx.facts.listingColour, { fetchThumbnail: (url) => fetchThumbnail(ctx, url) }),
            onAlternatives: (alternatives) => ctx.emit("observed_alternatives", alternatives),
          });
        case "comfort":
          return checkComfort({
            gemini: deps.gemini,
            webSearch: ctx.paused ? { search: async () => Promise.reject(new Error(PAUSED_MESSAGE)) } : deps.webSearch,
            model: { brand: subject.brand!, name: subject.modelName! },
            needs: ctx.needs,
            today: ctx.today,
            combinedTools: deps.config.combinedTools,
            executors: ctx.executors,
            snippets: subject.catalogue ? ctx.ref.reviews.filter((r) => r.modelId === subject.catalogue!.id) : [],
            searchTimeoutMs: deps.config.searchTimeoutMs,
          });
        case "condition":
          return checkCondition({ gemini: deps.gemini, images: ctx.images, facts: ctx.facts, needs: ctx.needs });
        case "colour":
          return checkColour({ gemini: deps.gemini, images: ctx.images, facts: ctx.facts, needs: ctx.needs });
      }
    });
    return withUsage(uncertain ? labelAsGuess(ctx, name, result, subject) : result, stats);
  } catch (err) {
    ctx.emit("error", { stage: name, message: plainError(name, err) });
    const searchFailed = name === "price" || name === "comfort";
    return unknownCheck(name, plainError(name, err), searchFailed ? { details: { searchFailed: true } } : {});
  }
}

/** Comfort is "based on our best guess"; price is already conditional, but the survey comparison can't be made. */
function labelAsGuess(ctx: RunCtx, name: DownstreamCheck, result: CheckResult, subject: Subject): CheckResult {
  if (name === "comfort") {
    return { ...result, summary: `Based on our best guess: ${subject.displayName}. ${result.summary}`, details: { ...(result.details ?? {}), basedOnBestGuess: true } };
  }
  if (name === "price" && ctx.survey) {
    return { ...result, details: { ...(result.details ?? {}), observedComparison: { ...modelUnknownComparison(ctx.survey), note: "Couldn't compare: the exact model isn't confirmed." } } };
  }
  return result;
}

/** No alternatives (no survey, or nothing to compare against), sent as the observed_alternatives event too. */
function emitNoAlternatives(ctx: RunCtx) {
  const none = noAlternatives(ctx.survey);
  ctx.emit("observed_alternatives", none);
  return none;
}

/** Record what the check actually did (Gemini calls, cache hits, a live or cached search). */
export function withUsage(result: CheckResult, stats: StageStats): CheckResult {
  const d = (result.details ?? {}) as { search?: { fromCache?: boolean }; shoppingLive?: boolean };
  const search =
    result.check === "comfort" && d.search
      ? { kind: "web" as const, live: !d.search.fromCache }
      : result.check === "price" && d.shoppingLive !== undefined
        ? { kind: "shopping" as const, live: d.shoppingLive }
        : undefined;
  return { ...result, usage: { geminiCalls: stats.geminiCalls, cachedCalls: stats.cachedCalls, ...(search ? { search } : {}) } };
}

/** Comfort's review sizing advice can turn a fit pass into a warn. */
export function linkComfortToFit(checks: CheckResult[]): { checks: CheckResult[]; changedFit: CheckResult | null } {
  const fit = checks.find((c) => c.check === "fit");
  const comfort = checks.find((c) => c.check === "comfort");
  if (!fit || !comfort || fit.status === "unknown") return { checks, changedFit: null };
  const d = comfort.details as { reviewSizing?: SizingAdvice; reviewSizingNote?: string } | undefined;
  const next = applyReviewSizingNote(fit, d?.reviewSizing, d?.reviewSizingNote);
  if (next === fit) return { checks, changedFit: null };
  return { checks: checks.map((c) => (c.check === "fit" ? next : c)), changedFit: next };
}

/** Run checks in parallel; emit each as it resolves. A rejection becomes `unknown`. */
export async function settleAndEmit(
  ctx: RunCtx,
  names: DownstreamCheck[],
  opts: CheckOpts = {},
  adjust: (r: CheckResult) => CheckResult = (r) => r,
): Promise<CheckResult[]> {
  const results = await Promise.all(
    names.map(async (name) => {
      const r = adjust(await runCheck(ctx, name, opts).catch((err) => unknownCheck(name, plainError(name, err))));
      ctx.emit("check_done", r);
      return r;
    }),
  );
  return results;
}

/** Run the downstream checks and apply the comfort -> fit link (re-emitting fit if it changed). */
export async function runDownstream(ctx: RunCtx, wanted: DownstreamCheck[] = DOWNSTREAM, previous: CheckResult[] = []): Promise<CheckResult[]> {
  // The colour check exists only for a buyer who asked for a colour or look.
  const names = wanted.filter((n) => n !== "colour" || !!ctx.needs.colourWish?.trim());
  // If comfort isn't being rerun, its sizing advice is already known: apply it to fit before emitting.
  const knownComfort = names.includes("comfort") ? undefined : previous.find((c) => c.check === "comfort");
  const adjust = (r: CheckResult) => {
    if (r.check !== "fit" || !knownComfort) return r;
    return linkComfortToFit([r, knownComfort]).checks[0];
  };
  const fresh = await settleAndEmit(ctx, names, {}, adjust);
  const merged = DOWNSTREAM.map((n) => fresh.find((c) => c.check === n) ?? previous.find((c) => c.check === n)).filter((c): c is CheckResult => !!c);
  const linked = linkComfortToFit(merged);
  const fitBefore = merged.find((c) => c.check === "fit");
  const touched = names.includes("fit") || names.includes("comfort");
  if (touched && linked.changedFit && JSON.stringify(linked.changedFit) !== JSON.stringify(fitBefore)) {
    ctx.emit("check_done", linked.changedFit);
  }
  return linked.checks;
}

/** The identified model's title tokens: the catalogue entry's, else derived from identify's brand and model name. */
export function tokensFor(subject: Subject): ModelTokens | null {
  if (subject.catalogue) return catalogueTokens(subject.catalogue);
  return subject.brand && subject.modelName ? deriveTokens(subject.brand, subject.modelName) : null;
}

/** The survey matched to what identify established (null tokens: nothing matches), with the user's size on its chart. */
export function observedFor(ctx: RunCtx, subject: Subject = subjectFor(ctx)): { survey: Survey; matched: MatchedListing[]; userSizeUK: number | null } | undefined {
  if (!ctx.survey) return undefined;
  const chart = chartFor(subject, ctx.ref.sizeCharts);
  const matched = matchSurvey(ctx.survey, tokensFor(subject), chart);
  return { survey: ctx.survey, matched, userSizeUK: subject.brand ? userSizeUK(ctx.needs, subject.brand, chart, ctx.ref.sizeCharts) : null };
}

/** The catalogue model's own chart, else any chart for the brand. */
export function chartFor(subject: Subject, charts: SizeChart[]): SizeChart | undefined {
  if (subject.catalogue) return charts.find((c) => c.id === subject.catalogue!.sizeChartId);
  const brand = subject.brand?.trim().toLowerCase();
  return brand ? charts.find((c) => c.brand.trim().toLowerCase() === brand) : undefined;
}
