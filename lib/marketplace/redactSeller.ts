import type { ListingData } from "@/schemas/domain";

/**
 * Remove known identifiers (the seller's usernames, display names, ids and avatar ids from the page data, and the
 * signed-in user's own name and id) from text and URLs, before anything is stored or sent to Gemini. The identifiers
 * themselves never leave the extension.
 */

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * The identifiers to remove, with safe variants: a display name's first word ("Sampleshop" of "Sampleshop Shoes") is
 * added only when it isn't part of the listing's own title, brand or model (a shop called "Nike Outlet" must not erase
 * "Nike").
 */
export function identifierVariants(ids: string[], own: { title?: string; brand?: string; model?: string } = {}): string[] {
  const ownText = ` ${norm([own.title, own.brand, own.model].filter(Boolean).join(" "))} `;
  const out = new Set<string>();
  for (const raw of ids) {
    const id = raw.trim();
    if (id.length < 3) continue;
    out.add(id);
    const words = id.split(/\s+/);
    if (words.length > 1 && words[0].length >= 5 && !ownText.includes(` ${norm(words[0])} `)) out.add(words[0]);
  }
  // Longest first, so "Sampleshop Shoes" goes before "Sampleshop".
  return [...out].sort((a, b) => b.length - a.length);
}

/** True for a line that is only a count or a "(count)" (the feedback number under a seller's name). */
const COUNT_LINE = /^\s*\(?\d[\d,.]*k?\)?\s*$/i;

/** Remove lines that are an identifier (and the count line after them); mask identifiers anywhere else. */
export function scrubIdentifiers(text: string, ids: string[]): string {
  if (!ids.length || !text) return text;
  const isId = (line: string) => ids.some((id) => line.trim().toLowerCase() === id.toLowerCase());
  const lines = text.split("\n");
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (isId(lines[i])) {
      if (i + 1 < lines.length && COUNT_LINE.test(lines[i + 1])) i++;
      continue;
    }
    kept.push(lines[i]);
  }
  let out = kept.join("\n");
  for (const id of ids) {
    // Not inside a longer word ("Alex" must not touch "Alexander"), case-insensitive.
    out = out.replace(new RegExp(`(^|[^\\p{L}\\p{N}_])${escapeRe(id)}(?![\\p{L}\\p{N}_])`, "giu"), "$1[redacted]");
  }
  return out;
}

/** Query parameters that name a seller or a user. */
const IDENTITY_PARAM = /^(seller|sellerid|seller_id|_ssn|ssn|username|user|userid|user_id|store_name|sid|_sid|member|profile|offender_id)$/i;

/** A URL without identity parameters or path segments naming an identifier; null when it can't be parsed. */
export function scrubUrl(url: string, ids: string[] = []): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  for (const k of [...u.searchParams.keys()]) if (IDENTITY_PARAM.test(k)) u.searchParams.delete(k);
  const lower = ids.map((i) => i.toLowerCase());
  if (u.pathname.split("/").some((seg) => lower.includes(decodeURIComponent(seg).toLowerCase()))) return null;
  for (const [k, v] of [...u.searchParams.entries()]) if (lower.includes(v.toLowerCase())) u.searchParams.delete(k);
  return u.toString();
}

/** The listing page's own URL as sent: origin and path only (no tracking, search or seller parameters). */
export function pageUrlForCapture(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? `${u.origin}${u.pathname}` : null;
  } catch {
    return null;
  }
}

/** Every text field of the listing data with identifiers masked. */
export function scrubListingData(listing: ListingData, ids: string[]): ListingData {
  if (!ids.length) return listing;
  const out: ListingData = { ...listing };
  for (const k of ["title", "brand", "model", "condition", "colour", "material", "category", "description", "uploadDate", "styleCode", "size"] as const) {
    const f = out[k];
    if (f) out[k] = { ...f, value: scrubIdentifiers(f.value, ids) };
  }
  if (out.itemSpecifics) out.itemSpecifics = out.itemSpecifics.map((s) => ({ label: s.label, value: scrubIdentifiers(s.value, ids) }));
  if (out.sizeSystem?.quote) out.sizeSystem = { ...out.sizeSystem, quote: scrubIdentifiers(out.sizeSystem.quote, ids) };
  return out;
}
