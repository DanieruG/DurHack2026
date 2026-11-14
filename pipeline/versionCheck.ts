import type { CheckResult, Evidence, IdentifyResult, ListingFacts } from "@/schemas/domain";
import type { CatalogueModel } from "@/schemas/seed";
import { titleMatchesModel } from "@/lib/newPrices";
import { identifyProduct, subjectOf, type Subject } from "./identify";
import { runCheck, runDownstream, toIdentifyCheck, type RunCtx } from "./runChecks";
import { runStage } from "./util";

/**
 * Version check: when the model name comes only from the photos (the listing's text never names it), Flash's reading of
 * a tongue label or sole is checked by Gemini Pro, in parallel with the other checks, within PRO_RECHECK_TIMEOUT_MS.
 * If Pro disagrees, declines or times out, the case reports the brand and model family with "version unclear (A or B)":
 * price becomes unknown, fit and condition stand, comfort runs on the family name, and the seller is asked which it is.
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

/**
 * "Pegasus 40" vs "Pegasus 41" -> family "Pegasus", options ["40", "41"]. With no second answer, the family drops the
 * version number(s) at the end: "Pegasus 40" -> "Pegasus", ["40", null]. Family "" when the two share nothing.
 */
export function modelFamily(a: string, b: string | null): { family: string; options: [string, string | null] } {
  const ta = a.trim().split(/\s+/);
  if (b) {
    const tb = b.trim().split(/\s+/);
    let i = 0;
    while (i < ta.length && i < tb.length && norm(ta[i]) === norm(tb[i])) i++;
    // Keep the family whole when one name is a prefix of the other ("Dunk Low" vs "Dunk Low Retro").
    const family = ta.slice(0, i).join(" ");
    const restA = ta.slice(i).join(" ") || a;
    const restB = tb.slice(i).join(" ") || b;
    return family ? { family, options: [restA, restB] } : { family: "", options: [a, b] };
  }
  let end = ta.length;
  while (end > 1 && /\d/.test(ta[end - 1])) end--;
  if (end === ta.length) return { family: a, options: [a, null] };
  return { family: ta.slice(0, end).join(" "), options: [ta.slice(end).join(" "), null] };
}

export function versionLabel(v: NonNullable<IdentifyResult["versionUnclear"]>): string {
  return `version unclear (${v.options[0]} or ${v.options[1] ?? "another version"})`;
}

/** "Is this the Nike Pegasus 40 or 41?" */
export function versionQuestion(brand: string | null, v: NonNullable<IdentifyResult["versionUnclear"]>): string {
  const name = [brand, v.family].filter(Boolean).join(" ");
  const [a, b] = v.options;
  return `Is this the ${name ? `${name} ` : ""}${a} or ${b ?? "another version"}?`;
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
  const min = ctx.deps.config.identifyConfidenceMin;
  const flash = subjectOf(ctx.identify, min, ctx.ref.catalogue);
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
    const pro = subjectOf(result, min, ctx.ref.catalogue);
    return { outcome: compareIdentifications(flash, pro), flash: flashName, pro: pro.modelName ? pro.displayName : null, result };
  } catch {
    return { outcome: "timeout", flash: flashName, pro: null, result: null };
  }
}

/** Flash's identification narrowed to the model family, with both candidate versions. */
export function versionUnclearResult(flash: IdentifyResult, vc: VersionCheck, min: number, catalogue: CatalogueModel[]): IdentifyResult {
  const proName = vc.outcome === "disagree" && vc.result ? subjectOf(vc.result, min, catalogue).modelName : null;
  const fam = modelFamily(flash.modelName!, proName);
  return {
    ...flash,
    modelName: fam.family || null,
    catalogueModelId: null,
    inCatalogue: false,
    confidence: fam.family ? flash.confidence : 0,
    versionUnclear: { family: fam.family, options: fam.options },
  };
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
 * Apply the version check once the first round of checks is done. Agree: record both answers. Otherwise: narrow the
 * identification to the family, make price unknown, keep fit and condition, rerun comfort on the family name.
 */
export async function applyVersionCheck(ctx: RunCtx, vc: VersionCheck, checks: CheckResult[]): Promise<CheckResult[]> {
  ctx.versionChecked = true;
  const identify = checks.find((c) => c.check === "identify")!;
  if (vc.outcome === "agree") {
    const next = withVersionEvidence(identify, vc, ctx.deps.config.proRecheckTimeoutMs);
    ctx.emit("check_done", next);
    return checks.map((c) => (c.check === "identify" ? next : c));
  }
  ctx.identify = versionUnclearResult(ctx.identify!, vc, ctx.deps.config.identifyConfidenceMin, ctx.ref.catalogue);
  const nextIdentify = withVersionEvidence(toIdentifyCheck(ctx, ctx.identify), vc, ctx.deps.config.proRecheckTimeoutMs);
  ctx.emit("check_done", nextIdentify);
  const price = await runCheck(ctx, "price"); // unknown: the version decides the price
  ctx.emit("check_done", price);
  const previous = checks.filter((c) => c.check !== "identify").map((c) => (c.check === "price" ? price : c));
  const downstream = ctx.identify.versionUnclear?.family ? await runDownstream(ctx, ["comfort"], previous) : previous;
  return [nextIdentify, ...downstream];
}
