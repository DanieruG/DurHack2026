/**
 * Second-layer seller-identity redaction (the extension redacts first).
 * Removes profile / rating blocks and the line following a seller header (usually the username),
 * and masks @handles, emails and phone numbers anywhere in the text. Contact details use distinct
 * placeholders so downstream checks can notice that a listing asked to move off-platform without
 * retaining the contact detail itself.
 */

const DROP_LINE = [
  /\bmember since\b/i,
  /\bjoined (in )?([a-z]{3,9} )?\d{4}\b/i,
  /\bregistered as a (private|business) seller\b/i,
  /\bseller'?s other items\b/i,
  /^\s*save seller\s*$/i,
  /\bfeedback left by (buyer|seller)\b/i,
  /^\s*see all feedback\s*$/i,
  /^\s*\w\*{2,}\w\s*\(\d[\d,]*\)\s*$/, // masked feedback handles: "t***n (1058)"
  /^\s*(hi|hello|welcome( back)?),?\s+[^\s!]{1,30}!?\s*$/i, // the viewer's own name in the site header: "Hi Daniel!"
  /^\s*hi\s+[^\s!]{1,30}!/i, // ...also when the header runs on: "Hi Daniel!Hello. Sign in"
  /^\s*(frequent uploads|speedy shipping|active lister|regularly lists \d+ or more items\.?|ships (quickly|fast))\s*$/i, // seller badges (Vinted)
  /\bfeedback (left by buyer|replied to by seller)\b/i,
  /^\s*reply from:/i,
  /^\s*located in:/i, // the seller's town
  /^\s*(vat number|crn|epr numbers?)\b/i, // business seller registration details
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
// UK postcodes ("sample_identity_15", "SW1A 1AA"): the buyer's delivery postcode appears in eBay's postage line.
const POSTCODE = /\b(GIR 0AA|[A-PR-UWYZ][A-HK-Y]?\d[A-Z\d]? ?\d[ABD-HJLNP-UW-Z]{2})\b/g;
const PHONE = /(?:\+\d{1,3}[\s.-]?(?:\(0\)[\s.-]?)?\d{2,4}[\s.-]?\d{3,4}[\s.-]?\d{3,4}\b|\b0\d{2,4}[\s.-]?\d{3,4}[\s.-]?\d{3,4}\b)/g;

// eBay seller card: avatar initial, username, feedback count, then optional "Private"/"Business".
const AVATAR = /^\s*[A-Za-z0-9]\s*$/;
const USERNAME = /^\s*[A-Za-z0-9][\w.\-]{2,39}\s*$/;
const FEEDBACK_COUNT = /^\s*\(\d[\d,]*\)\s*$/;
const SELLER_TYPE = /^\s*(private|business)\s*$/i;
const COUNT_WORDS = /^(reviews?|ratings?|feedback|sold|items?|photos?|watchers?|bids?|offers?|questions?|answers?|likes?|views?|sizes?)$/i;

/** Usernames shown in seller cards ("pako8242" above "(75)"), so they can be removed wherever else they appear. */
export function sellerUsernames(lines: string[]): string[] {
  const names = new Set<string>();
  const next = (i: number) => {
    for (let j = i + 1; j < lines.length; j++) if (lines[j].trim()) return j;
    return -1;
  };
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    // Handles look like "pako8242", "jane_doe", "sneakerqueen"; not "Reviews" / "Watchers" above a count.
    if (!USERNAME.test(t) || COUNT_WORDS.test(t) || !(/[\d_.\-]/.test(t) || t === t.toLowerCase())) continue;
    const j = next(i);
    if (j !== -1 && FEEDBACK_COUNT.test(lines[j])) names.add(lines[i].trim());
  }
  return [...names];
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export type RedactResult = { text: string; removedLines: number };

export function redact(input: string | undefined | null): RedactResult {
  if (!input) return { text: "", removedLines: 0 };
  const lines = input.replace(/\r\n?/g, "\n").split("\n");
  const usernames = sellerUsernames(lines);
  const isUsername = (l: string) => usernames.includes(l.trim());
  const out: string[] = [];
  let removed = 0;
  let skipNext = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trimEnd();
    // Seller card: drop the avatar initial before a username, the username, its feedback count and seller type.
    const nextLine = lines.slice(i + 1).find((l) => l.trim()) ?? "";
    const prevLine = lines.slice(0, i).reverse().find((l) => l.trim()) ?? "";
    if (
      (AVATAR.test(line) && isUsername(nextLine)) ||
      isUsername(line) ||
      (FEEDBACK_COUNT.test(line) && isUsername(prevLine)) ||
      (SELLER_TYPE.test(line) && FEEDBACK_COUNT.test(prevLine))
    ) {
      removed++;
      continue;
    }
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

  let joined = out.join("\n");
  // Anywhere else the username appears (descriptions, replies, feedback), mask it.
  for (const name of usernames) joined = joined.replace(new RegExp(`(^|[^\\w])${escapeRe(name)}(?![\\w])`, "gi"), "$1[redacted]");
  const text = joined
    .replace(EMAIL, "[email removed]")
    .replace(INLINE_LABEL, (_, label) => `${label}: [redacted]`)
    .replace(HANDLE, (_, pre) => `${pre}[redacted]`)
    .replace(PHONE, "[phone number removed]")
    .replace(POSTCODE, "[postcode removed]")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text, removedLines: removed };
}
