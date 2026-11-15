import type { BroadColour } from "./colour";

/** Colour words (and common trainer colourway names) mapped to the broad colour names the photo helper uses. */
const WORDS: [RegExp, BroadColour][] = [
  [/\b(black|blk|jet black|triple black|onyx)\b/i, "black"],
  [/\b(white|wht|triple white|summit white)\b/i, "white"],
  [/\b(gr[ae]y|grey fog|anthracite|charcoal|silver|smoke|wolf grey|cool grey|pewter|graphite|ash)\b/i, "grey"],
  [/\b(navy|midnight navy|obsidian)\b/i, "navy"],
  [/\b(blue|royal|cobalt|sky|teal|turquoise|aqua)\b/i, "blue"],
  [/\b(red|burgundy|maroon|crimson|bordeaux|wine)\b/i, "red"],
  [/\b(green|olive|khaki green|forest|mint|sage)\b/i, "green"],
  [/\b(brown|tan|chocolate|mocha|coffee|cognac)\b/i, "brown"],
  [/\b(beige|cream|sand|stone|ivory|oatmeal|bone|khaki|off[- ]white|ecru|taupe)\b/i, "beige"],
  [/\b(pink|rose|blush|fuchsia|magenta)\b/i, "pink"],
  [/\b(purple|lilac|violet|lavender|plum)\b/i, "purple"],
  [/\b(orange|coral|peach|rust)\b/i, "orange"],
  [/\b(yellow|volt|lemon|mustard|gold)\b/i, "yellow"],
];

/** Colour fields too generic to be evidence of the colour. */
export const GENERIC_COLOUR = /^\s*(multi[- ]?colou?r(ed)?|multi|multicolou?r(ed)?|assorted|various|mixed|see (description|photos?)|n\/?a|other)\s*$/i;

/** Broad colours named in free text, in the order they first appear (e.g. "black white" -> black, white). */
export function colourWordsIn(text: string | undefined | null): BroadColour[] {
  if (!text) return [];
  // "Off-White" is a brand as well as a colour: only treat it as a colour after a slash or next to another colour.
  const hits: { name: BroadColour; at: number }[] = [];
  for (const [re, name] of WORDS) {
    const g = new RegExp(re.source, "gi");
    for (let m = g.exec(text); m; m = g.exec(text)) {
      // "off-white" also contains "white": let the longer, earlier-starting match win by position.
      if (name === "white" && /off[- ]$/i.test(text.slice(Math.max(0, m.index - 4), m.index))) continue;
      hits.push({ name, at: m.index });
    }
  }
  hits.sort((a, b) => a.at - b.at);
  return [...new Set(hits.map((h) => h.name))];
}

/** A structured colour field's broad colours ("Grey, White" -> grey, white), or null when the field is generic. */
export function colourFieldNames(value: string | undefined): BroadColour[] | null {
  if (!value || GENERIC_COLOUR.test(value)) return null;
  const names = colourWordsIn(value);
  return names.length ? names : null;
}

/** Normalise a style code for matching ("DC3728 003" ~ "dc3728-003"). */
export const styleKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** True when `text` contains the style code (ignoring spaces and dashes). */
export function hasStyleCode(text: string, styleCode: string | undefined): boolean {
  const key = styleCode ? styleKey(styleCode) : "";
  return key.length >= 5 && styleKey(text).includes(key);
}
