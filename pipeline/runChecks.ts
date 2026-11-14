import type { CheckName, CheckResult, ConditionGrade, IdentifyResult, ListingFacts, UserNeeds } from "@/schemas/domain";
import type { SizeChart } from "@/schemas/seed";
import type { ReferenceData } from "@/lib/seedData";
import { makeToolExecutors, type ToolExecutor } from "@/gemini/tools";
import type { Tier } from "@/gemini/client";
import type { Deps } from "./deps";
import type { Emit } from "./events";
import type { CaseImage } from "./intake";
import { identifyCheck, identifyProduct, subjectOf, type Subject } from "./identify";
import { applyReviewSizingNote, checkFit, type SizingAdvice } from "./checks/fit";
import { checkPrice } from "./checks/price";
import type { NewPrices } from "@/lib/newPrices";
import { checkComfort } from "./checks/comfort";
import { checkCondition } from "./checks/condition";
import { plainError, runStage, today, unknownCheck } from "./util";

export type DownstreamCheck = Exclude<CheckName, "identify">;
export const DOWNSTREAM: DownstreamCheck[] = ["fit", "price", "comfort", "condition"];

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
};

const priceKey = (modelName: string, brand: string) => `${brand} ${modelName}`.toLowerCase().replace(/\s+/g, " ").trim();

export function buildCtx(base: Omit<RunCtx, "executors" | "today" | "newPrices" | "newPricesViaTool">): RunCtx {
  const memo = new Map<string, Promise<NewPrices>>();
  const newPrices = (modelName: string, brand: string) => {
    const k = priceKey(modelName, brand);
    let p = memo.get(k);
    if (!p) {
      p = base.deps.newPrices.getNewPrices(modelName, brand);
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
  return { ...base, executors, newPrices, newPricesViaTool, today: today(base.deps.now()) };
}

/** What identify established, by tier (brand / model name / catalogue match). */
export function subjectFor(ctx: RunCtx): Subject {
  return subjectOf(ctx.identify, ctx.deps.config.identifyConfidenceMin, ctx.ref.catalogue);
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
    const result: IdentifyResult = { brand: null, brandConfidence: 0, modelName: null, catalogueModelId: null, inCatalogue: false, confidence: 0, reasons: "Identification failed", evidence: [] };
    return { result, check: unknownCheck("identify", plainError("identify", err), { details: { tier: "none", catalogueModelId: null, inCatalogue: false, gatePassed: false } }) };
  }
}

export type CheckOpts = { priceCondition?: ConditionGrade; forceSourceB?: boolean };

export function toIdentifyCheck(ctx: RunCtx, result: IdentifyResult): CheckResult {
  return identifyCheck(result, { min: ctx.deps.config.identifyConfidenceMin, catalogue: ctx.ref.catalogue, hadImages: ctx.images.length > 0 });
}

/** Run one downstream check as a stage. Errors and timeouts become `unknown` with a plain explanation. */
export async function runCheck(ctx: RunCtx, name: DownstreamCheck, opts: CheckOpts = {}): Promise<CheckResult> {
  const subject = subjectFor(ctx);
  // Tiers: brand -> fit; model name -> comfort + new-price search; catalogue match -> sampled prices too; photos -> condition always.
  if (name === "fit" && !subject.brand) return unknownCheck("fit", "I couldn't tell the brand, so I can't check the fit.");
  if ((name === "price" || name === "comfort") && !subject.modelName) {
    const what = name === "price" ? "compare the price" : "check reviews for comfort";
    return unknownCheck(name, `I couldn't tell the exact model from this listing, so I can't ${what}.`);
  }
  const { deps } = ctx;
  const timeoutMs = deps.config.stageTimeoutMs;
  const features = {
    fit: [],
    price: [],
    comfort: ["structured_output"],
    condition: ["vision", "object_detection", "structured_output"],
  } as const;
  try {
    return await runStage(name, { emit: ctx.emit, timeoutMs, geminiFeatures: [...features[name]] }, async () => {
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
          });
        case "comfort":
          return checkComfort({
            gemini: deps.gemini,
            webSearch: deps.webSearch,
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
      }
    });
  } catch (err) {
    ctx.emit("error", { stage: name, message: plainError(name, err) });
    const searchFailed = name === "price" || name === "comfort";
    return unknownCheck(name, plainError(name, err), searchFailed ? { details: { searchFailed: true } } : {});
  }
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
export async function runDownstream(ctx: RunCtx, names: DownstreamCheck[] = DOWNSTREAM, previous: CheckResult[] = []): Promise<CheckResult[]> {
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

/** The catalogue model's own chart, else any chart for the brand. */
export function chartFor(subject: Subject, charts: SizeChart[]): SizeChart | undefined {
  if (subject.catalogue) return charts.find((c) => c.id === subject.catalogue!.sizeChartId);
  const brand = subject.brand?.trim().toLowerCase();
  return brand ? charts.find((c) => c.brand.trim().toLowerCase() === brand) : undefined;
}
