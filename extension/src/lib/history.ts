import type { CaseSummary } from "@/schemas/domain";

/**
 * Local case history: only { caseId, createdAt } per case, newest first, at most HISTORY_LIMIT entries.
 * Everything shown (title, price, verdict, thumbnail, listing URL) comes from GET /api/cases/summaries.
 */
export type HistoryEntry = { caseId: string; createdAt: string };

export const HISTORY_LIMIT = 50;

const byNewest = (a: HistoryEntry, b: HistoryEntry) => b.createdAt.localeCompare(a.createdAt);

export function addEntry(list: HistoryEntry[], entry: HistoryEntry): HistoryEntry[] {
  return [entry, ...list.filter((e) => e.caseId !== entry.caseId)].sort(byNewest).slice(0, HISTORY_LIMIT);
}

export function removeEntry(list: HistoryEntry[], caseId: string): HistoryEntry[] {
  return list.filter((e) => e.caseId !== caseId);
}

/** Drop entries the server didn't return (it can't find them). Only call with a successful summaries response. */
export function keepFound(list: HistoryEntry[], found: Pick<CaseSummary, "id">[]): HistoryEntry[] {
  const ids = new Set(found.map((s) => s.id));
  return list.filter((e) => ids.has(e.caseId));
}

/** Clean whatever is stored (older versions kept a richer `cases` map: keep only id and date from it). */
export function normaliseHistory(raw: unknown, legacyCases?: unknown): HistoryEntry[] {
  const out: HistoryEntry[] = [];
  const push = (caseId: unknown, createdAt: unknown) => {
    if (typeof caseId === "string" && /^[a-z0-9]{8,40}$/i.test(caseId) && typeof createdAt === "string") out.push({ caseId, createdAt });
  };
  if (Array.isArray(raw)) for (const e of raw) push((e as HistoryEntry)?.caseId, (e as HistoryEntry)?.createdAt);
  if (legacyCases && typeof legacyCases === "object") for (const c of Object.values(legacyCases)) push((c as { id?: unknown })?.id, (c as { createdAt?: unknown })?.createdAt);
  const seen = new Set<string>();
  return out.sort(byNewest).filter((e) => !seen.has(e.caseId) && seen.add(e.caseId)).slice(0, HISTORY_LIMIT);
}

export type HistoryRow = { entry: HistoryEntry; summary: CaseSummary };

/** Rows to show, newest first; entries without a summary yet are left out. */
export function historyRows(list: HistoryEntry[], summaries: Record<string, CaseSummary>): HistoryRow[] {
  return list.filter((e) => summaries[e.caseId]).map((entry) => ({ entry, summary: summaries[entry.caseId] }));
}

/** The most recent case opened for this listing URL (ignoring query and hash). */
export function caseForUrl(list: HistoryEntry[], summaries: Record<string, CaseSummary>, url: string): CaseSummary | null {
  const key = normaliseUrl(url);
  for (const e of list) {
    const s = summaries[e.caseId];
    if (s?.pageUrl && normaliseUrl(s.pageUrl) === key) return s;
  }
  return null;
}

export function normaliseUrl(u: string): string {
  try {
    const x = new URL(u);
    return `${x.origin}${x.pathname.replace(/\/+$/, "")}`;
  } catch {
    return u;
  }
}

/** "Case 7F3KQ2": a short, stable label derived from the case id (nothing extra is stored to number cases). */
export function caseLabel(caseId: string): string {
  return `Case ${caseId.slice(-6).toUpperCase()}`;
}
