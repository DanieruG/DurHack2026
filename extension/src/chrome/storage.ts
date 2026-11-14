import { ProfileSchema, type CaseDiff, type Platform, type Profile, type VerdictLabel } from "@/schemas/domain";

export const DEFAULT_API_BASE = "http://localhost:3000";

export type Settings = { apiBase: string };

export type StoredCase = {
  id: string;
  number: number;
  pageUrl: string;
  title: string;
  priceGBP: number | null;
  platform: Platform;
  photoCount: number;
  thumbnail: string | null;
  createdAt: string;
  revision: number;
  verdictLabel?: VerdictLabel;
  /** Diffs by target revision, so "What changed" can be reopened later. */
  diffs: Record<string, CaseDiff>;
};

type Shape = {
  profile?: unknown;
  settings?: Settings;
  cases?: Record<string, StoredCase>;
  nextCaseNumber?: number;
};

async function get<K extends keyof Shape>(key: K): Promise<Shape[K]> {
  const r = await chrome.storage.local.get(key);
  return r[key] as Shape[K];
}

async function set<K extends keyof Shape>(key: K, value: Shape[K]): Promise<void> {
  await chrome.storage.local.set({ [key]: value });
}

export async function loadProfile(): Promise<Profile | null> {
  const raw = await get("profile");
  if (!raw) return null;
  const parsed = ProfileSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export async function saveProfile(p: Profile): Promise<Profile> {
  const clean = ProfileSchema.parse(p);
  await set("profile", clean);
  return clean;
}

export async function loadSettings(): Promise<Settings> {
  const s = await get("settings");
  return { apiBase: s?.apiBase || DEFAULT_API_BASE };
}

export async function saveSettings(s: Settings): Promise<void> {
  await set("settings", { apiBase: s.apiBase.replace(/\/+$/, "") || DEFAULT_API_BASE });
}

export async function loadCases(): Promise<Record<string, StoredCase>> {
  return (await get("cases")) ?? {};
}

export async function saveCase(c: StoredCase): Promise<void> {
  const all = await loadCases();
  all[c.id] = c;
  await set("cases", all);
}

export async function updateCase(id: string, patch: Partial<StoredCase>): Promise<StoredCase | null> {
  const all = await loadCases();
  if (!all[id]) return null;
  all[id] = { ...all[id], ...patch, diffs: { ...all[id].diffs, ...(patch.diffs ?? {}) } };
  await set("cases", all);
  return all[id];
}

export async function takeCaseNumber(): Promise<number> {
  const n = (await get("nextCaseNumber")) ?? 1;
  await set("nextCaseNumber", n + 1);
  return n;
}

/** The most recent case opened for this listing URL (ignoring query and hash). */
export function caseForUrl(cases: Record<string, StoredCase>, url: string): StoredCase | null {
  const key = normaliseUrl(url);
  return (
    Object.values(cases)
      .filter((c) => normaliseUrl(c.pageUrl) === key)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null
  );
}

function normaliseUrl(u: string): string {
  try {
    const x = new URL(u);
    return `${x.origin}${x.pathname.replace(/\/+$/, "")}`;
  } catch {
    return u;
  }
}
