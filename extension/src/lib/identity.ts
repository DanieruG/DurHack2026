import type { IdentityChoice, IdentityOption } from "@/schemas/api";
import type { IdentifyResult } from "@/schemas/domain";
import { bestGuessOf, candidateName, identifyLabel } from "@/lib/identifyLabel";

/** The question shown on the "Is this the right item?" card. */
export type IdentityQuestion = { headline: string; bestGuess: IdentityOption; alternatives: IdentityOption[] };

const MAX_EVIDENCE = 3;

function option(c: IdentifyResult["alternatives"] extends (infer T)[] | undefined ? T : never): IdentityOption {
  return {
    brand: c.brand,
    model: c.model,
    version: c.version ?? null,
    colourway: c.colourway ?? null,
    label: candidateName(c) ?? "Unknown model",
    confidence: c.confidence,
    evidence: c.evidence.map((e) => e.label).slice(0, MAX_EVIDENCE),
  };
}

/** The same question for an already finished case ("Not right?"), from what is stored with it. */
export function questionFromIdentify(r: IdentifyResult): IdentityQuestion {
  return { headline: identifyLabel(r), bestGuess: option(bestGuessOf(r)), alternatives: (r.alternatives ?? []).slice(0, 2).map(option) };
}

/** A short name for the answer, for "Continuing with ...". */
export function choiceLabel(q: IdentityQuestion, c: IdentityChoice): string {
  switch (c.choice) {
    case "best_guess":
      return q.bestGuess.label;
    case "alternative":
      return q.alternatives[c.index]?.label ?? "your choice";
    case "custom":
      return [c.brand, c.model, c.version].filter(Boolean).join(" ");
    case "skip":
      return "no confirmed model";
  }
}

export const confidenceText = (confidence: number) => `${Math.round(confidence * 100)}% sure`;

/** Cases stored before best guesses carry no level: the server maps them, but be safe if an older server answers. */
export function normaliseForDisplay(r: IdentifyResult): IdentifyResult {
  return r.confidenceLevel ? r : { ...r, confidenceLevel: r.confidence >= 0.75 ? "likely" : r.confidence >= 0.5 ? "possible" : "best_guess" };
}
