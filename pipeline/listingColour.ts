import type { ListingColour, ListingFacts } from "@/schemas/domain";
import { analyseColours, colourName, describeColours, rgbToLab, type BroadColour, type ColourAnalysis } from "@/lib/colour";
import { colourFieldNames, colourWordsIn } from "@/lib/colourWords";
import type { CaseImage } from "./intake";

type Evidence = ListingColour["evidence"][number];
export type Analyse = (bytes: Uint8Array, opts?: { crop?: [number, number, number, number] }) => Promise<ColourAnalysis>;

const CONFIDENCE: Record<ListingColour["source"], number> = { style_code: 0.95, colour_field: 0.85, title: 0.75, photo: 0.45 };
/** Photo colours that count as the shoe's colours (share of the shoe). */
const PHOTO_MIN_SHARE = 0.15;

/** Photo analysis -> up to two broad colours, or none when the shoe is multi-coloured. */
export function photoNames(a: ColourAnalysis): BroadColour[] {
  if (a.multi) return [];
  return a.colours.filter((c) => c.share >= PHOTO_MIN_SHARE).slice(0, 2).map((c) => c.name);
}

const hexLab = (hex: string) => rgbToLab(parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16));

/**
 * The clicked listing's colour, strongest source first: style code -> colour field (unless generic) -> title colour
 * words -> photo analysis of the main photo (cropped to the shoe when its box is known). Every source is recorded as
 * evidence; sources that disagree with the one kept are recorded as conflicts. Undefined when nothing says.
 */
export async function determineListingColour(args: { facts: ListingFacts; mainPhoto?: CaseImage; analyse?: Analyse }): Promise<ListingColour | undefined> {
  const { facts } = args;
  const analyse = args.analyse ?? analyseColours;
  const evidence: Evidence[] = [];

  if (facts.styleCode) evidence.push({ source: "style_code", names: [], note: `Style code ${facts.styleCode} identifies the exact colourway` });
  if (facts.colourText) {
    const names = colourFieldNames(facts.colourText);
    evidence.push({ source: "colour_field", names: names ?? [], note: names ? `Colour field: "${facts.colourText}"` : `Colour field says "${facts.colourText}": too generic to use` });
  }
  const titleNames = colourWordsIn(facts.title);
  if (titleNames.length) evidence.push({ source: "title", names: titleNames, note: `Title colour words: ${titleNames.join(", ")}` });
  if (args.mainPhoto) {
    try {
      const a = await analyse(args.mainPhoto.bytes, facts.shoeBox ? { crop: facts.shoeBox } : {});
      evidence.push({ source: "photo", names: photoNames(a), note: `Main photo${facts.shoeBox ? " (shoe cropped)" : ""} looks ${describeColours(a) || "unclear"}` });
    } catch {
      /* unreadable image: no photo evidence */
    }
  }
  if (facts.dominantColourHint && /^#[0-9a-f]{6}$/i.test(facts.dominantColourHint)) {
    const name = colourName(hexLab(facts.dominantColourHint));
    evidence.push({ source: "photo_hint", names: [name], note: `The page's dominant photo colour ${facts.dominantColourHint} (${name}) is mostly the backdrop, so it isn't used` });
  }

  const naming = evidence.filter((e) => e.source !== "style_code" && e.source !== "photo_hint" && e.names.length);
  const chosen = naming[0];
  if (!chosen && !facts.styleCode) return evidence.length ? { names: [], source: "photo", confidence: 0, evidence, conflicts: [] } : undefined;
  const names = chosen?.names ?? [];
  const source: ListingColour["source"] = facts.styleCode ? "style_code" : (chosen!.source as ListingColour["source"]);
  const conflicts = naming
    .filter((e) => e !== chosen && names.length && !names.includes(e.names[0]))
    .map((e) => ({ source: e.source, names: e.names }));
  const confidence = Math.max(0, CONFIDENCE[source] - (conflicts.length && source !== "style_code" ? 0.1 : 0));
  return { names, source, confidence, ...(facts.styleCode ? { styleCode: facts.styleCode } : {}), evidence, conflicts };
}

/** "black and white (from the title)" */
export function listingColourLabel(c: ListingColour): string {
  const words = c.names.length ? c.names.join(" and ") : "unknown";
  const from = { style_code: `style code ${c.styleCode}`, colour_field: "the listing's colour field", title: "the title", photo: "photo analysis" }[c.source];
  return `${words} (from ${from})`;
}
