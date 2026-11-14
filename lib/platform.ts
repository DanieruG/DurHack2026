import type { Platform } from "@/schemas/domain";

const RULES: [RegExp, Platform][] = [
  [/(^|\.)vinted\.(co\.uk|com|fr|de|es|it|nl|be|pl|lt|cz|at|pt|lu|se|dk|fi|sk|hu|ro|gr|hr|ie|si|ee|lv)$/, "vinted"],
  [/(^|\.)(facebook\.com|fb\.com|messenger\.com)$/, "facebook"],
  [/(^|\.)ebay\.(com|co\.uk|de|fr|it|es|ie|at|ch|ca|com\.au|nl|be|pl)$/, "ebay"],
  [/(^|\.)depop\.com$/, "depop"],
];

/** Platform from the listing URL hostname; defaults to "other". */
export function detectPlatform(pageUrl: string | undefined | null): Platform {
  if (!pageUrl) return "other";
  let host: string;
  try {
    host = new URL(pageUrl).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return "other";
  }
  for (const [re, platform] of RULES) if (re.test(host)) return platform;
  return "other";
}
