/**
 * Second-layer seller-identity redaction (the extension redacts first).
 * Removes profile / rating blocks and the line following a seller header (usually the username),
 * and masks @handles, emails and phone numbers anywhere in the text.
 */

const DROP_LINE = [
  /\bmember since\b/i,
  /\bjoined (in )?\d{4}\b/i,
  /\blast seen\b/i,
  /\bactive (now|today|\d+ ?(min|hour|day)s? ago)\b/i,
  /\bresponds? (with)?in\b/i,
  /\busually responds\b/i,
  /\bfollowers?\b/i,
  /\bfollowing\b\s*\d/i,
  /\b\d+(\.\d+)?\s*%\s*positive\b/i,
  /\bpositive feedback\b/i,
  /\b(feedback|ratings?|reviews?)\s*\(?\d+\)?\s*$/i,
  /^\s*\(?\d+\)?\s*(reviews?|ratings?)\s*$/i,
  /[★⭐]{1,5}|\b\d(\.\d)?\s*(\/\s*5|stars?|★)/i,
  /\b(top|trusted|verified|frequent) seller\b/i,
  /\b(seller|vendor|shop) (info|information|details|profile|rating|reviews?)\b/i,
  /\b(view|visit) (profile|shop|store)\b/i,
  /\b(message|contact|ask|follow) (the )?seller\b/i,
  /\bitems? sold\b/i,
  /\bsee other items\b/i,
  /\bbadges?\b/i,
];

// Header lines whose *next* line is usually the seller's name/handle.
const HEADER_LINE = /^\s*(seller|sold by|listed by|posted by|meet the seller|about the seller|seller information|member)\s*:?\s*$/i;
// "Seller: jane_doe" / "Sold by janedoe" on a single line.
const INLINE_SELLER = /^\s*(seller|sold by|listed by|posted by)\s*[:\-]?\s+\S+/i;

// "... Seller: jane_doe ..." anywhere in a line (e.g. inside a pasted conversation).
const INLINE_LABEL = /\b(seller|sold by|listed by|posted by|username|user)\s*[:\-]\s*[^\s,.;!?]+/gi;
const HANDLE = /(^|[\s(])@[A-Za-z0-9_.-]{2,}/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE = /(?:\+44\s?7\d{3}|\b07\d{3})\s?\d{3}\s?\d{3}\b|\+\d{1,3}[\s-]?\(?\d{2,4}\)?[\s-]?\d{3,4}[\s-]?\d{3,4}\b/g;

export type RedactResult = { text: string; removedLines: number };

export function redact(input: string | undefined | null): RedactResult {
  if (!input) return { text: "", removedLines: 0 };
  const lines = input.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let removed = 0;
  let skipNext = 0;

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (skipNext > 0 && line.trim()) {
      skipNext--;
      removed++;
      continue;
    }
    if (HEADER_LINE.test(line)) {
      removed++;
      skipNext = 1;
      continue;
    }
    if (INLINE_SELLER.test(line) || DROP_LINE.some((re) => re.test(line))) {
      removed++;
      continue;
    }
    out.push(line);
  }

  const text = out
    .join("\n")
    .replace(EMAIL, "[redacted]")
    .replace(INLINE_LABEL, (_, label) => `${label}: [redacted]`)
    .replace(HANDLE, (_, pre) => `${pre}[redacted]`)
    .replace(PHONE, "[redacted]")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text, removedLines: removed };
}
