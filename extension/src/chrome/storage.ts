import { ProfileSchema, type Profile } from "@/schemas/domain";
import { addEntry, normaliseHistory, removeEntry, type HistoryEntry } from "../lib/history";
import { mergeSurvey, pruneSurveys, SURVEY_TTL_MS, type SearchPage, type SurveyCard, type SurveyRecord } from "../lib/survey";
import { pruneThumbCache, type ThumbCache } from "../lib/thumbColour";

export const DEFAULT_API_BASE = "http://localhost:3000";

export type Settings = { apiBase: string };

type Shape = {
  profile?: unknown;
  settings?: Settings;
  /** { caseId, createdAt } only, newest first, max 50. */
  history?: HistoryEntry[];
  /** Older versions only: migrated into `history`, then removed. */
  cases?: unknown;
  nextCaseNumber?: number;
  /** Search surveys (Feature A): on this device only, 24 hours, 300 cards in total. */
  surveys?: SurveyRecord[];
  /** The "Colour or look" typed on a search results page, per search (kept apart from `surveys`, which the background worker writes). */
  colourWishes?: Record<string, { w: string; t: number }>;
  /** Colours read from card thumbnails, per card id (see lib/thumbColour.ts). */
  thumbColours?: ThumbCache;
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

export async function loadHistory(): Promise<HistoryEntry[]> {
  const r = await chrome.storage.local.get(["history", "cases"]);
  const list = normaliseHistory(r.history, r.cases);
  if (r.cases !== undefined) {
    await set("history", list);
    await chrome.storage.local.remove(["cases", "nextCaseNumber"]);
  }
  return list;
}

export async function saveHistory(list: HistoryEntry[]): Promise<HistoryEntry[]> {
  await set("history", list);
  return list;
}

export async function rememberCase(entry: HistoryEntry): Promise<HistoryEntry[]> {
  return saveHistory(addEntry(await loadHistory(), entry));
}

/** Removes the entry from this device only; nothing is deleted on the server. */
export async function forgetCase(caseId: string): Promise<HistoryEntry[]> {
  return saveHistory(removeEntry(await loadHistory(), caseId));
}

/** Unexpired surveys (expired ones are dropped from storage as they're found). */
export async function loadSurveys(now = Date.now()): Promise<SurveyRecord[]> {
  const raw = (await get("surveys")) ?? [];
  const list = Array.isArray(raw) ? raw : [];
  const live = pruneSurveys(list, now);
  if (live.length !== list.length || live.some((s, i) => s.cards.length !== list[i]?.cards?.length)) await set("surveys", live);
  return live;
}

/** Merge freshly surveyed cards into the same search's survey and save. */
export async function saveSurveyCards(page: SearchPage, cards: SurveyCard[], now = Date.now(), scanUrl?: string): Promise<{ survey: SurveyRecord | null; added: number }> {
  const { surveys, survey, added } = mergeSurvey(await loadSurveys(now), page, cards, now, scanUrl);
  await set("surveys", surveys);
  return { survey, added };
}

/** The colour or look typed for each search, newest per key; entries older than the survey TTL are dropped. */
export async function loadColourWishes(now = Date.now()): Promise<Record<string, string>> {
  const raw = (await get("colourWishes")) ?? {};
  return Object.fromEntries(Object.entries(raw).filter(([, v]) => v && typeof v.w === "string" && now - v.t <= SURVEY_TTL_MS).map(([k, v]) => [k, v.w]));
}

export async function saveColourWish(searchKey: string, wish: string, now = Date.now()): Promise<void> {
  const raw = (await get("colourWishes")) ?? {};
  const next = Object.fromEntries(Object.entries(raw).filter(([, v]) => v && now - v.t <= SURVEY_TTL_MS));
  if (wish.trim()) next[searchKey] = { w: wish.trim().slice(0, 100), t: now };
  else delete next[searchKey];
  await set("colourWishes", next);
}

/** Colours read from thumbnails, pruned to cards still in a survey. */
export async function loadThumbColours(now = Date.now()): Promise<ThumbCache> {
  const [cache, surveys] = [(await get("thumbColours")) ?? {}, await loadSurveys(now)];
  return pruneThumbCache(cache, new Set(surveys.flatMap((s) => s.cards.map((c) => c.id))), now, SURVEY_TTL_MS);
}

export async function saveThumbColours(cache: ThumbCache): Promise<void> {
  await set("thumbColours", cache);
}
