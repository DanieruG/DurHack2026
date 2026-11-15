import { createAutoSurvey } from "./lib/autoSurvey";
import { collectSearchResults, searchPageOf, type RawSearchCapture } from "./lib/survey";
import { saveSurveyCards } from "./chrome/storage";

// Clicking the toolbar icon opens the side panel.
const openOnClick = () => chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

chrome.runtime.onInstalled.addListener(openOnClick);
chrome.runtime.onStartup.addListener(openOnClick);

// When a search is submitted on eBay or Vinted, read the results cards and keep them on this device (24 hours), so the
// panel can show the top results straight away. These sites are already in host_permissions; nothing is sent anywhere.
const auto = createAutoSurvey({
  read: async (tabId) => {
    try {
      const [r] = await chrome.scripting.executeScript({ target: { tabId }, func: collectSearchResults });
      return (r?.result as RawSearchCapture | undefined) ?? null;
    } catch {
      return null;
    }
  },
  save: async (page, cards, scanUrl) => {
    await saveSurveyCards(page, cards, Date.now(), scanUrl);
  },
  urlOf: async (tabId) => (await chrome.tabs.get(tabId).catch(() => null))?.url ?? null,
  schedule: (fn, ms) => setTimeout(fn, ms),
  cancel: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
});

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.url || info.status === "complete") auto.onTabUpdated(tabId, info.url ?? tab.url);
});
chrome.tabs.onRemoved.addListener((tabId) => auto.onTabRemoved(tabId));

// A search page that was already open when the extension started or updated.
const scanOpenTabs = async () => {
  const tabs = await chrome.tabs.query({}).catch(() => []);
  for (const t of tabs) if (t.id !== undefined && searchPageOf(t.url)) auto.onTabUpdated(t.id, t.url);
};
chrome.runtime.onInstalled.addListener(() => void scanOpenTabs());
chrome.runtime.onStartup.addListener(() => void scanOpenTabs());
