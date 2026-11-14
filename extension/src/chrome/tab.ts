import { collectListing, type RawCapture } from "../lib/capture";

export type TabCapture =
  | { ok: true; raw: RawCapture; screenshot: Blob | null }
  | { ok: false; reason: "no_listing" }
  | { ok: false; reason: "no_access"; origin: string; host: string };

async function activeTab(): Promise<chrome.tabs.Tab | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab ?? null;
}

function originPattern(url: string): { origin: string; host: string } | null {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return { origin: `${u.origin}/*`, host: u.hostname.replace(/^www\./, "") };
  } catch {
    return null;
  }
}

async function screenshot(windowId: number): Promise<Blob | null> {
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: "jpeg", quality: 82 });
    return await (await fetch(dataUrl)).blob();
  } catch {
    return null; // best effort: the backend only uses it when no listing image downloads
  }
}

/** Read the listing in the active tab. Nothing is sent anywhere until the user presses Investigate. */
export async function captureActiveTab(opts: { withScreenshot?: boolean } = {}): Promise<TabCapture> {
  const tab = await activeTab();
  const target = tab?.url ? originPattern(tab.url) : null;
  if (!tab?.id || !target) return { ok: false, reason: "no_listing" };
  try {
    const [result] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: collectListing });
    const raw = result?.result as RawCapture | undefined;
    if (!raw) return { ok: false, reason: "no_listing" };
    const shot = opts.withScreenshot ? await screenshot(tab.windowId) : null;
    return { ok: true, raw, screenshot: shot };
  } catch {
    const granted = await chrome.permissions.contains({ origins: [target.origin] }).catch(() => false);
    if (!granted) return { ok: false, reason: "no_access", ...target };
    return { ok: false, reason: "no_listing" };
  }
}

/** Must be called from a click handler (user gesture). */
export function requestSiteAccess(origin: string): Promise<boolean> {
  return chrome.permissions.request({ origins: [origin] });
}

/** Re-run `fn` when the user switches tab or the active tab finishes loading a new page. */
export function onActiveListingChange(fn: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const fire = () => {
    clearTimeout(timer);
    timer = setTimeout(fn, 250);
  };
  const onActivated = () => fire();
  const onUpdated = (_id: number, info: { status?: string; url?: string }, tab: chrome.tabs.Tab) => {
    if (tab.active && (info.status === "complete" || info.url)) fire();
  };
  chrome.tabs.onActivated.addListener(onActivated);
  chrome.tabs.onUpdated.addListener(onUpdated);
  return () => {
    clearTimeout(timer);
    chrome.tabs.onActivated.removeListener(onActivated);
    chrome.tabs.onUpdated.removeListener(onUpdated);
  };
}
