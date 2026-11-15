import type { CheckResult, Evidence, IdentifyResult, ListingFacts } from "@/schemas/domain";
import type { CatalogueModel } from "@/schemas/seed";
import { titleMatchesModel } from "@/lib/newPrices";
import { identifyProduct, subjectOf, type Subject } from "./identify";
import { toIdentifyCheck, type RunCtx } from "./runChecks";
import { bestGuessOf, candidateName } from "@/lib/identifyLabel";
import { runStage } from "./util";

/**
 * Version check: when the model name comes only from the photos (the listing's text never names it), Flash's reading of
 * a tongue label or sole is checked by Gemini Pro, in parallel with fit and condition (the model-dependent checks wait for it).
 * Agree: both answers are recorded. Otherwise the identification is "possible": if Pro named a different model, the more
 * confident of the two is the best guess and the other an alternative; if Pro declined or timed out, Flash's answer stands
 * but unconfirmed.
 */

/** Default for PRO_RECHECK_TIMEOUT_MS. */
export const PRO_RECHECK_TIMEOUT_MS = 15_000;

export type VersionOutcome = "agree" | "disagree" | "declined" | "timeout";
export type VersionCheck = { outcome: VersionOutcome; flash: string; pro: string | null; result: IdentifyResult | null };

/** The model the listing's own words name, if any: the model name (or a catalogue alias) appears in its title/model/text. */
export function modelFromPhotosOnly(result: IdentifyResult | null, facts: ListingFacts, pageText: string, catalogue: CatalogueModel[]): boolean {
  if (!result?.modelName) return false;
  const text = [facts.title, facts.modelText, pageText].filter(Boolean).join("\n");
  const cat = result.catalogueModelId ? catalogue.find((m) => m.id === result.catalogueModelId) : undefined;
  const names = [result.modelName, ...(cat ? [cat.name, ...cat.aliases] : [])];
  // titleMatchesModel requires every word and number of the name, versions adjacent ("Pegasus 40", not "Pegasus ... 40").
  return !names.some((n) => titleMatchesModel(text, "", n));
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export function compareIdentifications(flash: Subject, pro: Subject): Exclude<VersionOutcome, "timeout"> {
  if (!pro.modelName) return "declined";
  if (flash.catalogue && pro.catalogue) return flash.catalogue.id === pro.catalogue.id ? "agree" : "disagree";
  const sameBrand = !flash.brand || !pro.brand || norm(flash.brand) === norm(pro.brand);
  return sameBrand && norm(flash.modelName ?? "") === norm(pro.modelName) ? "agree" : "disagree";
}

/** Both models' answers, as evidence on the identify check. */
export function versionEvidence(vc: VersionCheck, timeoutMs = PRO_RECHECK_TIMEOUT_MS): Evidence[] {
  const pro =
    vc.outcome === "timeout"
      ? `no answer within ${Math.round(timeoutMs / 1000)}s`
      : vc.outcome === "declined"
        ? "wouldn't name an exact model"
        : (vc.pro ?? "no answer");
  return [
    { id: "ev_id_flash", kind: "data_point", label: "Gemini Flash, from the photos", value: vc.flash },
    { id: "ev_id_pro", kind: "data_point", label: `Gemini Pro recheck${vc.outcome === "agree" ? " (agrees)" : ""}`, value: pro },
  ];
}

/** Start the Pro recheck (all photos, strong tier). Never throws: a timeout or failure is an outcome. */
export async function runVersionCheck(ctx: RunCtx): Promise<VersionCheck> {
  const flash = subjectOf(ctx.identify, ctx.ref.catalogue);
  const flashName = flash.displayName ?? "unknown";
  try {
    const result = await runStage("version_check", { emit: ctx.emit, timeoutMs: ctx.deps.config.proRecheckTimeoutMs, geminiFeatures: ["vision", "structured_output"] }, () =>
      identifyProduct(ctx.deps.gemini, {
        facts: ctx.facts,
        images: ctx.images,
        pageText: ctx.pageText,
        catalogue: ctx.ref.catalogue,
        readReferenceImage: ctx.deps.readReferenceImage,
        tier: "strong",
      }),
    );
    const pro = subjectOf(result, ctx.ref.catalogue);
    return { outcome: compareIdentifications(flash, pro), flash: flashName, pro: pro.modelName ? pro.displayName : null, result };
  } catch {
    return { outcome: "timeout", flash: flashName, pro: null, result: null };
  }
}

/** Flash's identification after a Pro recheck that didn't agree: level "possible", with Pro's model as best guess or alternative. */
export function possibleFrom(flash: IdentifyResult, vc: VersionCheck): IdentifyResult {
  const flashBest = { ...bestGuessOf(flash), confidence: flash.confidence };
  const pro = vc.outcome === "disagree" ? vc.result : null;
  if (!pro || !(pro.modelName || pro.catalogueModelId)) {
    // Declined or timed out: the photo reading stands, unconfirmed.
    return { ...flash, confidenceLevel: flash.confidenceLevel === "best_guess" ? "best_guess" : "possible" };
  }
  const proBest = { ...bestGuessOf(pro), confidence: pro.confidence };
  // Ordered by confidence; Pro wins a tie.
  const proFirst = proBest.confidence >= flashBest.confidence;
  const [top, other] = proFirst ? [pro, flashBest] : [flash, proBest];
  const rest = [other, ...(flash.alternatives ?? []), ...(pro.alternatives ?? [])];
  const seen = new Set([candidateName(bestGuessOf(top))]);
  const alternatives = rest.filter((c) => {
    const n = candidateName(c);
    if (!n || seen.has(n)) return false;
    seen.add(n);
    return true;
  });
  return { ...top, bestGuess: { ...bestGuessOf(top), confidence: top.confidence }, alternatives: alternatives.slice(0, 2), lensMatches: flash.lensMatches, confidenceLevel: "possible" };
}

/** Attach both answers to the identify check (evidence and details.proRecheck). */
export function withVersionEvidence(check: CheckResult, vc: VersionCheck, timeoutMs?: number): CheckResult {
  return {
    ...check,
    evidence: [...check.evidence.filter((e) => e.id !== "ev_id_flash" && e.id !== "ev_id_pro"), ...versionEvidence(vc, timeoutMs)],
    details: { ...(check.details ?? {}), proRecheck: { outcome: vc.outcome, flash: vc.flash, pro: vc.pro } },
  };
}

/**
 * Apply the version check: records both answers and, unless Pro agreed, makes the identification "possible".
 * Emits the updated identify check. Model-dependent checks haven't run yet, so none need rerunning.
 */
export function applyVersionCheck(ctx: RunCtx, vc: VersionCheck): CheckResult {
  ctx.versionChecked = true;
  if (vc.outcome !== "agree") ctx.identify = possibleFrom(ctx.identify!, vc);
  const check = withVersionEvidence(toIdentifyCheck(ctx, ctx.identify!), vc, ctx.deps.config.proRecheckTimeoutMs);
  ctx.emit("check_done", check);
  return check;
}
