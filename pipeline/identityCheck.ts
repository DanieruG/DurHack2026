import type { CheckName, Evidence, IdentifyCandidate, IdentifyResult, ListingFacts } from "@/schemas/domain";
import type { IdentityChoice, IdentityOption, SseEventData } from "@/schemas/api";
import type { CatalogueModel } from "@/schemas/seed";
import { bestGuessOf, candidateName, fullModelName, identifyLabel } from "@/lib/identifyLabel";
import { titleMatchesModel } from "@/lib/newPrices";
import { brandKnown, cleanModelName, matchCatalogue, norm } from "./identify";
import { normaliseIdentify } from "./identifyLevel";

/** Checks that need the exact model: held back while the buyer is asked (the observed comparison and alternatives belong to price). */
export const WAITING_CHECKS: CheckName[] = ["price", "comfort"];

/** Pause only for a possible or best guess where at least the brand is known (without a brand there's nothing to confirm: R1). */
export function shouldPause(identify: IdentifyResult | null, catalogue: CatalogueModel[]): boolean {
  const r = normaliseIdentify(identify);
  return !!r && (r.confidenceLevel === "possible" || r.confidenceLevel === "best_guess") && brandKnown(r, catalogue);
}

function summarise(e: Evidence): string {
  switch (e.kind) {
    case "photo_region":
      return `${e.label}${e.photoIndex !== undefined ? ` (photo ${e.photoIndex + 1})` : ""}`;
    case "quote":
      return `${e.label}${e.quote ? `: "${e.quote}"` : ""}`;
    default:
      return e.label;
  }
}

const MAX_EVIDENCE = 4;

function option(c: IdentifyCandidate, extra: string[] = []): IdentityOption {
  return {
    brand: c.brand,
    model: c.model,
    version: c.version ?? null,
    colourway: c.colourway ?? null,
    label: candidateName(c) ?? "Unknown model",
    confidence: c.confidence,
    evidence: [...c.evidence.map(summarise), ...extra].slice(0, MAX_EVIDENCE),
  };
}

/** The identity_check_needed payload: best guess and alternatives with confidence and an evidence summary each (Lens matches included). */
export function identityNeeded(identify: IdentifyResult): SseEventData<"identity_check_needed"> {
  const r = normaliseIdentify(identify)!;
  const lens = r.lensMatches ?? [];
  const best = bestGuessOf(r);
  return {
    level: r.confidenceLevel === "best_guess" ? "best_guess" : "possible",
    headline: identifyLabel(r),
    bestGuess: option(best, lens.length ? [`${lens.length} Google Lens visual match${lens.length === 1 ? "" : "es"}`] : []),
    alternatives: (r.alternatives ?? []).slice(0, 2).map((a) => option(a)),
    lensMatches: lens.map((m) => ({ title: m.title, source: m.source ?? null, ...(m.url ? { url: m.url } : {}) })),
    waiting: WAITING_CHECKS,
  };
}

// ---------- the buyer's answer ----------

export class InvalidChoiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidChoiceError";
  }
}

const clean = (s: string | undefined | null) => s?.replace(/\s+/g, " ").trim().slice(0, 80) || null;

/**
 * The buyer's choice as a candidate. A custom answer is normalised against the catalogue and its aliases (never searched):
 * a listed model takes the catalogue's brand and name.
 */
function candidateFor(identify: IdentifyResult, choice: Exclude<IdentityChoice, { choice: "skip" }>, catalogue: CatalogueModel[]): { cand: IdentifyCandidate; catalogue: CatalogueModel | null } {
  if (choice.choice === "best_guess") return { cand: bestGuessOf(identify), catalogue: identify.catalogueModelId ? (catalogue.find((m) => m.id === identify.catalogueModelId) ?? null) : null };
  if (choice.choice === "alternative") {
    const alt = (identify.alternatives ?? [])[choice.index];
    if (!alt) throw new InvalidChoiceError("There is no such alternative.");
    const cat = matchCatalogue(alt.brand, fullModelName(alt.model, alt.version), catalogue) ?? matchCatalogue(alt.brand, alt.model, catalogue);
    return { cand: alt, catalogue: cat };
  }
  const rawBrand = clean(choice.brand)!;
  const brand = catalogue.find((m) => norm(m.brand) === norm(rawBrand))?.brand ?? rawBrand;
  const model = cleanModelName(brand, choice.model) ?? clean(choice.model)!;
  const version = clean(choice.version);
  const cat = matchCatalogue(brand, fullModelName(model, version), catalogue) ?? matchCatalogue(brand, model, catalogue);
  return { cand: { brand: cat?.brand ?? brand, model: cat?.name ?? model, version: cat ? null : version, colourway: clean(choice.colourway), confidence: 1, evidence: [] }, catalogue: cat };
}

/**
 * A clearly read label or style code, or the listing's own title/model field, that points to a different model than the one
 * the buyer chose: the choice stands, with a warning. Returns the warning, or null.
 */
export function contradiction(before: IdentifyResult, chosen: IdentifyCandidate, facts: ListingFacts, catalogue: CatalogueModel[]): string | null {
  const prev = bestGuessOf(before);
  const chosenName = fullModelName(chosen.model, chosen.version) ?? "";
  const prevName = fullModelName(prev.model, prev.version) ?? "";
  if (!chosenName || norm(chosenName) === norm(prevName)) return null;
  // A label or style code read in a photo supports the best guess; choosing something else contradicts it.
  const label = before.evidence.find((e) => e.kind === "photo_region" && e.photoIndex !== undefined && /style code|label|tag/i.test(e.label));
  if (label && prevName) return `Your choice differs from the label in photo ${label.photoIndex! + 1}.`;
  // The listing's own title/model field names a different catalogue model than the choice.
  const listingText = [facts.title, facts.modelText].filter(Boolean).join("\n");
  const names = (m: CatalogueModel) => [m.name, ...m.aliases];
  const namedByListing = catalogue.filter((m) => norm(m.brand) === norm(chosen.brand ?? "") && names(m).some((n) => titleMatchesModel(listingText, "", n)));
  const chosenInListing = titleMatchesModel(listingText, "", chosenName);
  if (namedByListing.length && !chosenInListing) return "Your choice differs from the listing's own title.";
  return null;
}

/** The identification after the buyer's answer: user_confirmed with "Confirmed by you" evidence (a skip changes nothing but records it). */
export function applyIdentityChoice(
  identify: IdentifyResult,
  choice: IdentityChoice,
  args: { catalogue: CatalogueModel[]; facts: ListingFacts; now: string },
): IdentifyResult {
  const base = normaliseIdentify(identify)!;
  if (choice.choice === "skip") return { ...base, userChoice: { choice: "skip", at: args.now } };
  const { cand, catalogue: cat } = candidateFor(base, choice, args.catalogue);
  const warning = contradiction(base, cand, args.facts, args.catalogue);
  const name = candidateName(cand)!;
  const confirmed: Evidence = { id: "ev_id_user", kind: "data_point", label: "Confirmed by you", value: name };
  return {
    ...base,
    brand: cat?.brand ?? cand.brand,
    brandConfidence: 1,
    modelName: cat?.name ?? cand.model,
    catalogueModelId: cat?.id ?? null,
    inCatalogue: !!cat,
    confidence: 1,
    reasons: `Confirmed by you: ${name}.`,
    evidence: [confirmed, ...base.evidence.filter((e) => e.id !== "ev_id_user")],
    bestGuess: { ...cand, confidence: 1, evidence: [confirmed] },
    alternatives: [],
    brandOnlyReason: undefined,
    confidenceLevel: "user_confirmed",
    userChoice: { choice: choice.choice, at: args.now, ...(warning ? { warning } : {}) },
  };
}
