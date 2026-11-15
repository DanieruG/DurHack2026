import { maskContacts, redact, sellerUsernames } from "./redact";
import { scrubIdentifiers, scrubUrl } from "./marketplace/redactSeller";

/**
 * Redaction of data that is already stored (scripts/redact-stored.ts): cases captured before a redaction fix still hold
 * what the fix now removes. Page text gets the full line-based redact(); everything else (JSON columns, survey cards,
 * cached responses, URLs) only has known identifiers, contact details and identity URL parts masked, because redact()
 * on a short string drops legitimate text ("Ask the seller for…" matches its seller-contact rule).
 */

/** Lines that name a seller on eBay pages, with the name in group 1. */
const NAMING_LINES = [/^\s*reply from:\s*([\w.\-]{3,40})\s*$/i, /feedback replied to by seller\s+([\w.\-]{3,40})/i, /items provided by\s+([\w.\-]{3,40})/i];
/** eBay "Find similar items from" is followed by the seller's store name. */
const STORE_HEADER = /^\s*find similar items from\s*$/i;
/** Seller names in URLs: eBay /str/<store>, /usr/<user>; Vinted /member/<id>-<name>. */
const URL_PATH_NAME = [/\/(?:str|usr)\/([^/?#]{3,60})/i, /\/member(?:s)?\/\d+-([^/?#]{3,60})/i];
const URL_PARAM_NAME = /[?&](?:store_name|seller|_ssn|sid)=([^&#]{3,60})/gi;

/** Seller identifiers found in stored page text and URLs (seller cards, feedback replies, store links). */
export function collectIdentifiers(pageTexts: string[], urls: string[] = []): string[] {
  const out = new Set<string>();
  for (const text of pageTexts) {
    const lines = text.split(/\r?\n/);
    for (const n of sellerUsernames(lines)) out.add(n);
    lines.forEach((line, i) => {
      for (const re of NAMING_LINES) {
        const m = line.match(re);
        if (m) out.add(m[1]);
      }
      if (STORE_HEADER.test(line)) {
        const next = lines.slice(i + 1).find((l) => l.trim());
        if (next && next.trim().length <= 60) out.add(next.trim());
      }
    });
  }
  for (const u of urls) {
    for (const re of URL_PATH_NAME) {
      const m = u.match(re);
      if (m) out.add(decodeURIComponent(m[1]));
    }
    for (const m of u.matchAll(URL_PARAM_NAME)) out.add(decodeURIComponent(m[1]));
  }
  return [...new Set([...out].map((s) => s.trim().replace(/[.\-]+$/, "")))].filter((s) => s.length >= 3).sort((a, b) => b.length - a.length);
}

/** Stored page text through today's redaction, then any known identifier masked. */
export function redactPageText(text: string, ids: string[]): string {
  return scrubIdentifiers(redact(text).text, ids);
}

const isUrl = (s: string) => /^https?:\/\/\S+$/i.test(s);

/** One string field: URLs lose identity parameters and seller paths; text has identifiers and contacts masked. */
export function redactString(s: string, ids: string[]): string {
  if (isUrl(s)) return scrubUrl(s, ids) ?? "[link removed]";
  return maskContacts(scrubIdentifiers(s, ids));
}

/** Every string in a JSON value redacted with redactString (keys kept). */
export function redactJson<T>(value: T, ids: string[]): T {
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return redactString(v, ids);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(value) as T;
}

/** A text column that may hold JSON (observed_listings, listing_data): redacted as JSON when it parses. */
export function redactTextColumn(text: string, kind: string, ids: string[]): string {
  if (kind === "page_text") return redactPageText(text, ids);
  if (kind === "seller_reply") return scrubIdentifiers(redact(text).text, ids);
  try {
    const parsed: unknown = JSON.parse(text);
    const out = JSON.stringify(redactJson(parsed, ids));
    // Unchanged content keeps its original formatting, so only real changes count as changed records.
    return out === JSON.stringify(parsed) ? text : out;
  } catch {
    return redactString(text, ids);
  }
}

/** Case-insensitive occurrences of each name in a haystack (for the zero-matches check). */
export function countMatches(haystack: string, names: string[]): Record<string, number> {
  const lower = haystack.toLowerCase();
  const out: Record<string, number> = {};
  for (const n of names) {
    const needle = n.toLowerCase();
    let i = 0;
    let c = 0;
    while ((i = lower.indexOf(needle, i)) !== -1) {
      c++;
      i += needle.length;
    }
    if (c) out[n] = c;
  }
  return out;
}
