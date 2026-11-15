import { z } from "zod";
import type { CheckResult, CheckStatus, Evidence, ListingColour, ListingFacts, UserNeeds } from "@/schemas/domain";
import type { BroadColour } from "@/lib/colour";
import { colourWordsIn } from "@/lib/colourWords";
import { generateStructured } from "@/gemini/structured";
import { imagePart, type GeminiClient, type Part } from "@/gemini/client";
import type { CaseImage } from "../intake";
import { listingColourLabel } from "../listingColour";
import { clamp01, evidenceIds, round2, unknownCheck } from "../util";

/**
 * The buyer's colour or look requirement ("all white, nothing neon"), checked against the listing. Advisory: it never
 * fails and never changes the verdict label. Colour words are compared with the colour Sleuth already established for the
 * listing (style code, colour field, title, then the photo); everything else ("retro", "no logos") is judged from the photos
 * by one Gemini vision call. Absent entirely when the buyer didn't ask for anything.
 */

export type Verdict = "meets" | "partly" | "doesnt" | "cant_tell";

export type Requirement = { text: string; wanted: BroadColour[]; avoided: BroadColour[] };

const NEGATION = /\b(no|not|without|avoid|nothing|never|non)\b/i;
const MAX_REQUIREMENTS = 5;
/** A listing colour from a style code, colour field or title is trusted over a photo reading at this confidence. */
export const TRUST_LISTING_COLOUR = 0.7;

/** "all white, nothing neon; retro look" -> one requirement per clause, with its wanted and avoided colours. */
export function parseWish(wish: string): Requirement[] {
  return wish
    .split(/[;,\n]|\bbut\b|\band also\b/i)
    .map((c) => c.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, MAX_REQUIREMENTS)
    .map((text) => {
      const colours = colourWordsIn(text);
      return NEGATION.test(text) ? { text, wanted: [], avoided: colours } : { text, wanted: colours, avoided: [] };
    });
}

/** The verdict for a colour-only requirement against the listing's colours, or null when it isn't about colour or the listing's colour is unknown. */
export function compareColours(req: Requirement, listing: ListingColour | undefined): { verdict: Verdict; note: string } | null {
  if (!req.wanted.length && !req.avoided.length) return null;
  const names = listing?.names ?? [];
  if (!listing || !names.length) return null;
  const has = (c: BroadColour) => names.includes(c);
  const label = listingColourLabel(listing);
  if (req.avoided.length) {
    const hit = req.avoided.filter(has);
    return hit.length
      ? { verdict: "doesnt", note: `You didn't want ${hit.join(" or ")}, but the listing is ${label}.` }
      : { verdict: "meets", note: `The listing is ${label}, with none of ${req.avoided.join(", ")}.` };
  }
  const found = req.wanted.filter(has);
  if (found.length === req.wanted.length) return { verdict: "meets", note: `The listing is ${label}.` };
  if (found.length) return { verdict: "partly", note: `You wanted ${req.wanted.join(" and ")}; the listing is ${label}.` };
  return { verdict: "doesnt", note: `You wanted ${req.wanted.join(" and ")}; the listing is ${label}.` };
}

export const ColourWireSchema = z.object({
  requirements: z
    .array(
      z.object({
        index: z.number().int().nonnegative(),
        verdict: z.enum(["meets", "partly", "doesnt", "cant_tell"]),
        note: z.string(),
        photoIndex: z.number().int().nonnegative().nullish(),
        confidence: z.number().min(0).max(1).nullish(),
      }),
    )
    .default([]),
});

export const COLOUR_SYSTEM = `You check whether a second-hand trainer listing's photos meet the buyer's colour or look requirements.
- Judge each numbered requirement from the photos only. verdict: meets, partly, doesnt, or cant_tell (lighting, angle or filters stop you being sure).
- For colour, look at the shoe's upper, not the backdrop, laces or sole, unless the requirement names them.
- "Nothing neon" or "no bright colours" means the shoe must not use neon or very bright colours anywhere visible.
- note: one short plain sentence naming what you see. photoIndex: the photo that shows it best.
- Say nothing about comfort, condition or price.`;

function parts(reqs: { index: number; req: Requirement }[], images: CaseImage[], facts: ListingFacts): Part[] {
  const known = facts.listingColour?.names.length ? `The listing's own details suggest the colour is: ${facts.listingColour.names.join(", ")}.\n` : "";
  const out: Part[] = [
    { text: `Buyer's requirements:\n${reqs.map((r) => `${r.index}. ${r.req.text}`).join("\n")}\n${known}Photos follow, each preceded by its photoIndex.` },
  ];
  for (const img of images.slice(0, 4)) out.push({ text: `Photo ${img.index}:` }, imagePart(img));
  return out;
}

export async function checkColour(args: { gemini: GeminiClient; images: CaseImage[]; facts: ListingFacts; needs: UserNeeds }): Promise<CheckResult> {
  const wish = args.needs.colourWish?.trim();
  if (!wish) return unknownCheck("colour", "You didn't ask for a particular colour or look.");
  const reqs = parseWish(wish);
  const listing = args.facts.listingColour;
  const trusted = !!listing && listing.confidence >= TRUST_LISTING_COLOUR && listing.names.length > 0;

  type Result = { text: string; verdict: Verdict; note: string; source: "listing" | "photos"; confidence: number; photoIndex?: number };
  const results: (Result | null)[] = reqs.map((req) => {
    const cmp = trusted ? compareColours(req, listing) : null;
    return cmp ? { text: req.text, ...cmp, source: "listing", confidence: listing!.confidence } : null;
  });

  // Everything the listing's own colour can't settle goes to one vision call.
  const pending = reqs.map((req, index) => ({ index, req })).filter(({ index }) => !results[index]);
  let usedGemini = false;
  if (pending.length) {
    if (args.images.length === 0) {
      for (const { index, req } of pending) results[index] = { text: req.text, verdict: "cant_tell", note: "There are no usable photos to judge this from.", source: "photos", confidence: 0 };
    } else {
      usedGemini = true;
      const { data } = await generateStructured(args.gemini, ColourWireSchema, {
        stage: "colour",
        tier: "fast",
        thinking: "LOW",
        system: COLOUR_SYSTEM,
        parts: parts(pending, args.images, args.facts),
        temperature: 0,
      });
      const photoIndices = args.images.map((i) => i.index);
      for (const { index, req } of pending) {
        const r = data.requirements.find((x) => x.index === index);
        results[index] = r
          ? {
              text: req.text,
              verdict: r.verdict,
              note: r.note.trim().slice(0, 200) || "Judged from the photos.",
              source: "photos",
              confidence: r.verdict === "cant_tell" ? 0.3 : clamp01(r.confidence ?? 0.6),
              ...(r.photoIndex != null && photoIndices.includes(r.photoIndex) ? { photoIndex: r.photoIndex } : {}),
            }
          : { text: req.text, verdict: "cant_tell", note: "The photos didn't settle this.", source: "photos", confidence: 0.3 };
      }
    }
  }

  const done = results as Result[];
  const verdicts = done.map((r) => r.verdict);
  // Advisory: a mismatch is a warn at most, never a fail.
  const status: CheckStatus = verdicts.includes("doesnt") || verdicts.includes("partly")
    ? "warn"
    : verdicts.every((v) => v === "meets")
      ? "pass"
      : verdicts.includes("meets")
        ? "warn"
        : "unknown";
  const worst = done.find((r) => r.verdict === "doesnt") ?? done.find((r) => r.verdict === "partly") ?? done.find((r) => r.verdict === "cant_tell") ?? done[0];
  const summary =
    status === "pass"
      ? `It meets what you asked for (${wish}). ${done[0].note}`
      : status === "unknown"
        ? `I couldn't tell whether it meets what you asked for (${wish}). ${worst.note}`
        : `It may not meet what you asked for (${wish}). ${worst.note}`;

  const nextId = evidenceIds("colour");
  const evidence: Evidence[] = [];
  if (listing?.evidence.length) {
    for (const e of listing.evidence) if (e.source !== "photo_hint") evidence.push({ id: nextId(), kind: "data_point", label: `Listing colour: ${e.note}`, ...(e.names.length ? { value: e.names.join(", ") } : {}) });
  }
  for (const r of done) {
    if (r.photoIndex !== undefined) evidence.push({ id: nextId(), kind: "photo_region", label: `${r.text}: ${r.note}`, photoIndex: r.photoIndex });
  }

  const confidence = round2(Math.min(...done.map((r) => r.confidence)));
  return {
    check: "colour",
    status,
    summary,
    evidence,
    confidence: status === "unknown" ? Math.min(confidence, 0.3) : confidence,
    geminiFeatures: usedGemini ? ["vision", "structured_output"] : [],
    details: {
      wish,
      requirements: done.map((r) => ({ text: r.text, verdict: r.verdict, note: r.note, source: r.source, ...(r.photoIndex !== undefined ? { photoIndex: r.photoIndex } : {}) })),
      ...(listing ? { listingColour: { names: listing.names, source: listing.source, confidence: listing.confidence, label: listing.names.length ? listingColourLabel(listing) : null } } : {}),
    },
  };
}
