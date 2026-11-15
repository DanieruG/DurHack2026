import type { ListingData, SizeSystem, SizeSystemFound } from "@/schemas/domain";

/** Raw <script> contents gathered in the page (JSON-LD, JSON documents, inline scripts). */
export type EmbeddedScripts = { jsonLd: string[]; json: string[]; scripts: string[] };

/** Visible fields of the listing, read from the DOM by the extension's collectListing (plain data). */
export type PageFields = {
  /** eBay "About this item" item specifics: each label paired with the value after it. */
  specifics: { label: string; value: string }[];
  /** eBay gallery grid photos in order: `src`, or `data-src` for lazy-loaded ones. */
  grid: { src: string | null; dataSrc: string | null }[];
  /** N from the gallery's "Picture X of N" labels, or null. */
  pictureTotal: number | null;
  /** Vinted data-testid fields (item-attributes-size, item-price, ...): the value text after the field's own title. */
  testIds: Record<string, string>;
  /** Vinted gallery tiles data-testid="item-photo-N": the highest N. */
  photoTiles: number;
  /** eBay: the seller's description is in an itm.ebaydesc.com iframe, which this content script can't read. */
  descriptionFrame: boolean;
  /** The logged-in user's own name or id shown in the site header (removed from everything before sending). */
  account: string[];
};

/** What a platform extractor reads: the page URL, its embedded scripts and its visible fields. */
export type MarketplacePage = { pageUrl: string; embedded?: EmbeddedScripts; fields?: PageFields };

/** One extractor's result: this listing's fields, its photos (full size, gallery order) and the seller's identifiers. */
export type ExtractedListing = {
  listing: ListingData;
  photos: string[];
  /**
   * The seller's usernames, display names, ids and avatar ids found in the page data. Used only to remove them from the
   * page text and URLs before anything is sent; never sent themselves.
   */
  sellerIds: string[];
};

/** The JSON value (object or array) that starts at `text[start]`, bracket-matched with strings respected; or null. */
export function jsonAt(text: string, start: number, maxLen = 3_000_000): unknown {
  const open = text[start];
  if (open !== "{" && open !== "[") return null;
  let depth = 0;
  let inStr = false;
  for (let i = start; i < text.length && i - start < maxLen; i++) {
    const ch = text[i];
    if (inStr) {
      if (ch === "\\") i++;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") {
      if (--depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** The value after the first `"key":` in any of the texts, parsed (objects and arrays only). */
export function valueAfterKey(texts: string[], key: string, startsWith = ""): unknown {
  const needle = `"${key}":${startsWith}`;
  for (const t of texts) {
    const i = t.indexOf(needle);
    if (i === -1) continue;
    const v = jsonAt(t, i + key.length + 3);
    if (v !== null) return v;
  }
  return null;
}

export const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
export const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.replace(/\s+/g, " ").trim() : undefined);

/** Every JSON-LD node of @type Product. */
export function jsonLdProducts(texts: string[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const visit = (n: unknown, depth: number) => {
    if (depth > 6 || !n || typeof n !== "object") return;
    if (Array.isArray(n)) return n.forEach((x) => visit(x, depth + 1));
    const o = n as Record<string, unknown>;
    const t = o["@type"];
    if (t === "Product" || (Array.isArray(t) && t.includes("Product"))) out.push(o);
    if (o["@graph"]) visit(o["@graph"], depth + 1);
  };
  for (const t of texts) {
    try {
      visit(JSON.parse(t), 0);
    } catch {
      /* malformed JSON-LD */
    }
  }
  return out;
}

/** The first offer of a JSON-LD Product. */
export function firstOffer(p: Record<string, unknown>): Record<string, unknown> | undefined {
  const o = p.offers;
  const first = Array.isArray(o) ? o[0] : o;
  return isRecord(first) ? first : undefined;
}

/** "54.0" / 54 / "£54.00" -> 54 (finite and non-negative), else undefined. */
export function money(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v.replace(/[£$€,\s]|GBP|AUD|EUR|USD/gi, "")) : NaN;
  return Number.isFinite(n) && n >= 0 && n <= 1_000_000 ? Math.round(n * 100) / 100 : undefined;
}

/** "£8.69" anywhere in a string -> 8.69. */
export function poundsIn(s: string | undefined): number | undefined {
  const m = s ? /£\s?(\d{1,6}(?:[.,]\d{1,2})?)/.exec(s) : null;
  return m ? money(m[1].replace(",", ".")) : undefined;
}

/** schema.org condition URL -> plain words ("https://schema.org/NewCondition" -> "New"). */
export function schemaCondition(v: unknown): string | undefined {
  const s = str(v);
  if (!s) return undefined;
  const m = /([A-Za-z]+)Condition$/.exec(s);
  if (!m) return s;
  return { New: "New", Used: "Used", Refurbished: "Refurbished", Damaged: "Damaged" }[m[1]] ?? m[1];
}

const SYSTEM_WORD: Record<string, SizeSystem> = { uk: "UK", us: "US", usa: "US", eu: "EU", eur: "EU" };
// "US 14", "UK9", "EU 43.5", "Mens US 14", "size UK 9", and the reverse "9 UK".
const SYSTEM_BEFORE = /\b(UK|US|USA|EU|EUR)\s?(\d{1,2}(?:[.,]5)?)\b/i;
const SYSTEM_AFTER = /\b(\d{1,2}(?:[.,]5)?)\s?(UK|US|EU)\b/i;

/** A size system stated in free text, with the size it names and the words it was found in. */
export function sizeSystemIn(text: string | undefined): { system: SizeSystem; size: number; quote: string } | null {
  if (!text) return null;
  for (const re of [SYSTEM_BEFORE, SYSTEM_AFTER]) {
    const m = re.exec(text);
    if (!m) continue;
    const [sys, num] = re === SYSTEM_BEFORE ? [m[1], m[2]] : [m[2], m[1]];
    const size = Number(num.replace(",", "."));
    if (!Number.isFinite(size) || size < 1 || size > 20) continue;
    const from = Math.max(0, m.index - 20);
    const quote = text.slice(from, m.index + m[0].length).replace(/\s+/g, " ").trim().slice(-120);
    return { system: SYSTEM_WORD[sys.toLowerCase()], size, quote };
  }
  return null;
}

/**
 * The size system for a listed size that has none ("14"): searched in the title, then the description, and recorded
 * with where it was found. Only accepted when the text names the same size. Never assumed.
 */
export function findSizeSystem(size: string | undefined, title: string | undefined, description: string | undefined): SizeSystemFound | undefined {
  const listed = size ? Number(size.replace(",", ".").replace(/[^\d.]/g, "")) : NaN;
  for (const [foundIn, text] of [["title", title], ["description", description]] as const) {
    const hit = sizeSystemIn(text);
    if (!hit) continue;
    if (Number.isFinite(listed) && hit.size !== listed) continue;
    return { value: hit.system, source: "page_field", foundIn, quote: hit.quote };
  }
  return undefined;
}

/** A size menu's system from its label ("UK Shoe Size" -> UK). */
export function systemFromLabel(label: string): SizeSystem | "unknown" {
  const m = /\b(UK|US|EU)\b/i.exec(label);
  return m ? (m[1].toUpperCase() as SizeSystem) : "unknown";
}
