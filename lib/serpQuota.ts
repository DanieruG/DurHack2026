/**
 * Live SerpApi calls made by this process, per kind. Shopping, web search and Lens all spend the same monthly quota, so
 * every live (non-cached) call is counted and its running total goes in the log line. Cached answers aren't counted.
 */
export type SerpKind = "shopping" | "web" | "lens";

const used: Record<SerpKind, number> = { shopping: 0, web: 0, lens: 0 };

/** Count one live call; returns the running totals, e.g. for a log line. */
export function recordSerpCall(kind: SerpKind): string {
  used[kind]++;
  return serpUsage();
}

export function serpUsage(): string {
  return `serpapi_calls shopping=${used.shopping} web=${used.web} lens=${used.lens} total=${used.shopping + used.web + used.lens}`;
}

export function serpCallCounts(): Readonly<Record<SerpKind, number>> {
  return { ...used };
}

/** Tests: start from zero. */
export function resetSerpCounts(): void {
  used.shopping = used.web = used.lens = 0;
}
