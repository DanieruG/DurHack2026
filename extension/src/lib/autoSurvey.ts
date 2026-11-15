import { cardsFromCapture, searchPageOf, type RawSearchCapture, type SearchPage, type SurveyCard } from "./survey";

/**
 * Read an eBay or Vinted search results page automatically when a search is submitted, and keep its cards on this device
 * (the same 24-hour survey the panel's "Survey again" button writes). Results render lazily and these sites navigate
 * without reloading, so the page is read a couple of times shortly after each change. Nothing is sent anywhere.
 * The chrome.* calls are injected so this is testable (see background.ts for the real ones).
 */

/** Delays after a tab changes before reading it (ms): results often render a moment after the URL changes. */
export const RESCAN_DELAYS_MS = [1500, 4500];

export type AutoSurveyDeps = {
  /** Read the cards in a tab, or null when it can't be read (no access, navigated away, closed). */
  read: (tabId: number) => Promise<RawSearchCapture | null>;
  save: (page: SearchPage, cards: SurveyCard[]) => Promise<void>;
  /** The tab's current URL (it may have moved on since the scan was scheduled). */
  urlOf: (tabId: number) => Promise<string | null>;
  schedule: (fn: () => void, ms: number) => unknown;
  cancel: (handle: unknown) => void;
  now?: () => Date;
};

export function createAutoSurvey(deps: AutoSurveyDeps) {
  const pending = new Map<number, unknown[]>();

  const clear = (tabId: number) => {
    for (const h of pending.get(tabId) ?? []) deps.cancel(h);
    pending.delete(tabId);
  };

  async function scan(tabId: number): Promise<number> {
    try {
      const page = searchPageOf(await deps.urlOf(tabId));
      if (!page) return 0; // moved to a listing or another site
      const raw = await deps.read(tabId);
      if (!raw) return 0;
      // The tab may have moved on to another search since it was scheduled.
      const current = searchPageOf(raw.pageUrl) ?? page;
      const cards = cardsFromCapture(raw, current.platform, (deps.now?.() ?? new Date()).toISOString());
      if (!cards.length) return 0;
      await deps.save(current, cards);
      return cards.length;
    } catch {
      return 0; // a page we can't read is simply not surveyed
    }
  }

  return {
    /** A tab loaded or changed URL: if it's a search results page, read it now-ish and again shortly after. Repeated events reset the timers. */
    onTabUpdated(tabId: number, url: string | null | undefined): void {
      clear(tabId);
      if (!searchPageOf(url)) return;
      pending.set(
        tabId,
        RESCAN_DELAYS_MS.map((ms) => deps.schedule(() => void scan(tabId), ms)),
      );
    },
    onTabRemoved(tabId: number): void {
      clear(tabId);
    },
    /** Read a tab right away (tests, and the extension starting with a search page already open). */
    scan,
    pendingTabs: () => [...pending.keys()],
  };
}
