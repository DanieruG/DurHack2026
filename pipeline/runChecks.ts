import type { CheckName, CheckResult, ConditionGrade, IdentifyResult, ListingFacts, UserNeeds } from "@/schemas/domain";
import type { CatalogueModel } from "@/schemas/seed";
import type { ReferenceData } from "@/lib/seedData";
import { makeToolExecutors, type ToolExecutor } from "@/gemini/tools";
import type { Deps } from "./deps";
import type { Emit } from "./events";
import type { CaseImage } from "./intake";
import { identifyCheck, identifyProduct, passesGate } from "./identify";
import { applyReviewSizingNote, checkFit, type SizingAdvice } from "./checks/fit";
import { checkPrice, type NewPrice } from "./checks/price";
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
  /** Source B result cached within the investigation (avoids repeat grounding calls). */
  newPrice?: NewPrice | null;
};

export function buildCtx(base: Omit<RunCtx, "executors" | "today">): RunCtx {
  return { ...base, executors: makeToolExecutors(base.ref), today: today(base.deps.now()) };
}

export function identifiedModel(ctx: RunCtx): CatalogueModel | null {
  if (!passesGate(ctx.identify, ctx.deps.config.identifyConfidenceMin)) return null;
  return ctx.ref.catalogue.find((m) => m.id === ctx.identify!.catalogueModelId) ?? null;
}

export async function runIdentify(ctx: RunCtx, opts: { onlyPhotoIndex?: number } = {}): Promise<{ result: IdentifyResult; check: CheckResult }> {
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
      }),
    );
    return { result, check: identifyCheck(result, { min: config.identifyConfidenceMin, catalogue: ctx.ref.catalogue, hadImages: ctx.images.length > 0 }) };
  } catch (err) {
    const result: IdentifyResult = { catalogueModelId: null, confidence: 0, reasons: "Identification failed", evidence: [] };
    return { result, check: unknownCheck("identify", plainError("identify", err), { details: { catalogueModelId: null, gatePassed: false } }) };
  }
}

export type CheckOpts = { priceCondition?: ConditionGrade; forceSourceB?: boolean };

/** Run one downstream check as a stage. Errors and timeouts become `unknown` with a plain explanation. */
export async function runCheck(ctx: RunCtx, name: DownstreamCheck, opts: CheckOpts = {}): Promise<CheckResult> {
  const model = identifiedModel(ctx);
  if (!model && name !== "condition") return unknownCheck(name, "Couldn't identify the exact model, so this check couldn't run.");
  const { deps } = ctx;
  const timeoutMs = deps.config.stageTimeoutMs;
  const features = {
    fit: [],
    price: ["search_grounding"],
    comfort: ["search_grounding"],
    condition: ["vision", "object_detection", "structured_output"],
  } as const;
  try {
    return await runStage(name, { emit: ctx.emit, timeoutMs, geminiFeatures: [...features[name]] }, async () => {
      switch (name) {
        case "fit":
          return checkFit({ facts: ctx.facts, needs: ctx.needs, model: model!, charts: ctx.ref.sizeCharts });
        case "price": {
          const res = await checkPrice({
            facts: ctx.facts,
            needs: ctx.needs,
            model: model!,
            samples: ctx.ref.priceSamples,
            today: ctx.today,
            gemini: deps.gemini,
            combinedTools: deps.config.combinedTools,
            executors: ctx.executors,
            condition: opts.priceCondition,
            forceSourceB: opts.forceSourceB,
            previousNewPrice: ctx.newPrice,
          });
          const { newPrice, ...check } = res;
          if (newPrice !== undefined && newPrice !== null) ctx.newPrice = newPrice;
          return check;
        }
        case "comfort":
          return checkComfort({
            gemini: deps.gemini,
            model: model!,
            needs: ctx.needs,
            today: ctx.today,
            combinedTools: deps.config.combinedTools,
            executors: ctx.executors,
            snippets: ctx.ref.reviews.filter((r) => r.modelId === model!.id),
          });
        case "condition":
          return checkCondition({ gemini: deps.gemini, images: ctx.images, facts: ctx.facts, needs: ctx.needs });
      }
    });
  } catch (err) {
    ctx.emit("error", { stage: name, message: plainError(name, err) });
    return unknownCheck(name, plainError(name, err));
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

export function gateFailedChecks(): CheckResult[] {
  return DOWNSTREAM.map((n) => unknownCheck(n, "Couldn't identify the exact model"));
}
