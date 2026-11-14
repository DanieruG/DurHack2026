import type { CheckName, CheckStatus, Platform, WearTolerance } from "@/schemas/domain";

export const PLATFORM_NAMES: Record<Platform, string> = {
  vinted: "Vinted",
  facebook: "Facebook Marketplace",
  ebay: "eBay",
  depop: "Depop",
  other: "Listing",
};

export const CHECK_NAMES: Record<CheckName, string> = {
  identify: "Identity",
  fit: "Fit",
  price: "Price",
  comfort: "Comfort",
  condition: "Condition",
};

export const WEAR_NAMES: Record<WearTolerance, { label: string; hint: string }> = {
  none: { label: "None", hint: "As new only." },
  light: { label: "Light", hint: "Small marks are fine." },
  moderate: { label: "Moderate", hint: "Visible wear is fine if it's sound." },
  any: { label: "Any", hint: "Only structural damage matters." },
};

/** "£42", "£42.50". */
export function gbp(n: number): string {
  return `£${Number.isInteger(n) ? n : n.toFixed(2)}`;
}

/** Local case numbers are shown as "Case 0042". */
export function caseNumber(n: number): string {
  return `Case ${String(n).padStart(4, "0")}`;
}

export function firstSentence(s: string): string {
  const m = s.match(/^.*?[.!?](?=\s|$)/);
  return (m ? m[0] : s).trim();
}

export function domainOf(url: string | undefined): string {
  if (!url) return "";
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-11-10" -> "10 Nov". Leaves anything else untouched. */
export function shortDate(iso: string): string {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return iso;
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]}`;
}

/** Elapsed time for the investigation log: "0:07". */
export function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

const STATUS_RANK: Record<CheckStatus, number> = { fail: 0, warn: 1, unknown: 1, pass: 2 };

export function statusDirection(before: string, after: string): "upgraded" | "downgraded" | "updated" {
  const b = STATUS_RANK[before as CheckStatus];
  const a = STATUS_RANK[after as CheckStatus];
  if (b === undefined || a === undefined || a === b) return "updated";
  return a > b ? "upgraded" : "downgraded";
}

export const STATUS_WORDS: Record<CheckStatus, string> = {
  pass: "Clear",
  warn: "Concern",
  fail: "Problem",
  unknown: "Unknown",
};
