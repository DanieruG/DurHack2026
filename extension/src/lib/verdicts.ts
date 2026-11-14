import type { VerdictLabel } from "@/schemas/domain";

/**
 * Each verdict gets a distinct geometric treatment from the palette.
 * - block:   the whole verdict sits on a solid field
 * - bar:     a solid vertical rule to the left of the label
 * - broken:  the same rule, interrupted
 * - frame:   an outline around the verdict
 * - hollow:  an outlined rule, label in mid grey
 * Muted red is reserved for overpriced and wrong fit. It is only ever a fill or a stroke, never text colour:
 * on charcoal it is too dark to read (about 1.9:1), while light grey on red reads at about 6:1.
 */
export type VerdictTreatment = "block-light" | "bar-light" | "broken-light" | "block-red" | "frame-red" | "hollow";

export const VERDICTS: Record<VerdictLabel, { title: string; treatment: VerdictTreatment }> = {
  hidden_gem: { title: "Hidden gem", treatment: "block-light" },
  worth_a_look: { title: "Worth a look", treatment: "bar-light" },
  proceed_with_caution: { title: "Proceed with caution", treatment: "broken-light" },
  overpriced: { title: "Overpriced", treatment: "block-red" },
  wrong_fit: { title: "Wrong fit", treatment: "frame-red" },
  not_enough_evidence: { title: "Not enough evidence", treatment: "hollow" },
};

export const VERDICT_ORDER: VerdictLabel[] = [
  "hidden_gem",
  "worth_a_look",
  "proceed_with_caution",
  "overpriced",
  "wrong_fit",
  "not_enough_evidence",
];
