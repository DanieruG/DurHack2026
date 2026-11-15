import type { IdentifyCandidate, IdentifyResult } from "@/schemas/domain";

/** Pure wording for an identification (shared by the server's check summaries and the panel). */

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** "Air Max 95" + "Essential" -> "Air Max 95 Essential"; a version already in the name isn't repeated. */
export function fullModelName(model: string | null, version: string | null | undefined): string | null {
  if (!model) return null;
  if (!version || norm(model).includes(norm(version))) return model;
  return `${model} ${version}`;
}

/** "Nike Air Max 95 Essential", or just the brand when no model is known. */
export function candidateName(c: Pick<IdentifyCandidate, "brand" | "model" | "version">): string | null {
  const m = fullModelName(c.model, c.version);
  return m ? [c.brand, m].filter(Boolean).join(" ") : (c.brand ?? null);
}

/** The best guess as a candidate (from the flat fields for results stored before best guesses existed). */
export function bestGuessOf(r: IdentifyResult): IdentifyCandidate {
  return r.bestGuess ?? { brand: r.brand, model: r.modelName, version: null, colourway: null, confidence: r.confidence, evidence: [] };
}

/** What the first alternative adds to the best guess: " or OG" when it differs only by version, else " or Nike Pegasus 41". */
function orAlternative(best: IdentifyCandidate, alt: IdentifyCandidate | undefined): string {
  if (!alt) return "";
  if (alt.brand === best.brand && alt.model === best.model && alt.version && alt.version !== best.version) return ` or ${alt.version}`;
  const name = candidateName(alt);
  return name ? ` or ${name}` : "";
}

/** The identify line, by level: "Likely Nike Air Max 95 Essential", "Best guess: Nike Air Max 95 (version unclear)", ... */
export function identifyLabel(r: IdentifyResult): string {
  const best = bestGuessOf(r);
  const name = candidateName(best);
  if (!name) return "Couldn't identify the shoe";
  const level = r.confidenceLevel ?? "likely";
  switch (level) {
    case "confirmed":
      return name;
    case "likely":
      return `Likely ${name}`;
    case "possible":
      return `Possibly ${name}${orAlternative(best, r.alternatives?.[0])}`;
    case "best_guess": {
      const unclear = !best.version && !!r.alternatives?.length;
      return `Best guess: ${name}${unclear ? " (version unclear)" : ""}`;
    }
    case "user_confirmed":
      return `${name} (confirmed by you)`;
  }
}

/** "Could also be: Nike Pegasus 41, Nike Pegasus 39", or null when there are no alternatives. */
export function couldAlsoBe(r: IdentifyResult): string | null {
  const names = (r.alternatives ?? []).map(candidateName).filter((n): n is string => !!n);
  return names.length ? `Could also be: ${names.join(", ")}` : null;
}
