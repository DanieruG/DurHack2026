import type { ObservedAlternative, ObservedAlternatives } from "@/schemas/domain";
import { gbp, PLATFORM_NAMES, shortDate } from "./format";
import { differenceText, safeHref } from "./offers";

/**
 * "Worth looking at": cheaper listings from the user's own search survey, shown under the Price exhibit with the same
 * card as the new-price offers. None of them has been investigated.
 */

export const ALTERNATIVES_TITLE = "Worth looking at";
export const NOT_INVESTIGATED = "Not investigated yet";
export const NO_SURVEY_LINE = "Survey a search results page to compare with other listings.";
export const NOTHING_CHEAPER_LINE = "Nothing cheaper in your size from your search.";

/** "UK 9", or "Size not stated" (flagged). */
export function sizeLabel(a: Pick<ObservedAlternative, "size">): { text: string; flag: boolean } {
  return a.size ? { text: a.size, flag: false } : { text: "Size not stated", flag: true };
}

/** The card's labels after the difference: version and colour where they need saying, then "Not investigated yet". */
export function alternativeTags(a: ObservedAlternative): { text: string; flag: boolean }[] {
  return [
    ...(a.matchLevel === "version_unknown" ? [{ text: "Version not stated", flag: true }] : []),
    a.colourMatch === "same" ? { text: "Same colour", flag: false } : { text: "Colour unclear", flag: true },
    { text: NOT_INVESTIGATED, flag: false },
  ];
}

/** Under the price: prices are compared without postage. */
export const POSTAGE_LABEL = "Postage not included";

/** The card's accessible name: "Nike Pegasus 40 on Vinted, £28, £14 cheaper than this listing, UK 9, same colour, not investigated yet, opens in a new tab". */
export function alternativeLabel(a: ObservedAlternative): string {
  return [
    `${a.title} on ${PLATFORM_NAMES[a.platform]}`,
    gbp(a.priceGBP),
    differenceText(a.differenceGBP),
    POSTAGE_LABEL.toLowerCase(),
    sizeLabel(a).text,
    ...alternativeTags(a).map((t) => t.text.toLowerCase()),
    "opens in a new tab",
  ].join(", ");
}

/** "From your Vinted search on 14 Nov. Only listings you surveyed." */
export function alternativesFootnote(data: Pick<ObservedAlternatives, "platform" | "surveyedOn">): string | null {
  if (!data.platform || !data.surveyedOn) return null;
  return `From your ${PLATFORM_NAMES[data.platform]} search on ${shortDate(data.surveyedOn)}. Only listings you surveyed.`;
}

/** What the section shows: cards, or one quiet line (no survey; or a survey with nothing cheaper in the user's size). */
export function alternativesView(
  data: ObservedAlternatives | null | undefined,
): { kind: "cards"; alternatives: ObservedAlternative[]; footnote: string | null } | { kind: "empty"; line: string } {
  if (!data?.surveyUsed) return { kind: "empty", line: NO_SURVEY_LINE };
  const alternatives = data.alternatives.filter((a) => safeHref(a.url));
  if (!alternatives.length) return { kind: "empty", line: NOTHING_CHEAPER_LINE };
  return { kind: "cards", alternatives, footnote: alternativesFootnote(data) };
}
