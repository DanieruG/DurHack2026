import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { CaseDetail, IdentityChoice } from "@/schemas/api";
import type { Capture, CaseDiff, CaseSummary, Profile } from "@/schemas/domain";
import { ApiError, createApi } from "../chrome/api";
import { DEFAULT_API_BASE, forgetCase, loadHistory, loadProfile, loadSettings, loadSurveys, rememberCase, saveHistory, saveProfile, saveSettings, saveSurveyCards } from "../chrome/storage";
import { caseForUrl, historyRows, keepFound, type HistoryEntry } from "../lib/history";
import { activeTabUrl, captureActiveTab, onActiveListingChange, openListingTab, requestSiteAccess, surveyActiveTab } from "../chrome/tab";
import { cardsFromCapture, searchPageOf, summariseSurvey, summaryLine, surveyForCase, type SearchPage } from "../lib/survey";
import { listingItemId } from "@/lib/listingScope";
import { detectPlatform } from "@/lib/platform";
import { SearchSurvey } from "./screens/SearchSurvey";
import { prepareCapture, type ListingPreview } from "../lib/capture";
import { applyEvent, newInvestigation, type IncomingEvent, type Investigation } from "../lib/progress";
import { CaseFile, type EvidenceDraft } from "./screens/CaseFile";
import { CaseReady, type ReadyState } from "./screens/CaseReady";
import { History } from "./screens/History";
import { Investigating } from "./screens/Investigating";
import { ProfileScreen } from "./screens/Profile";
import { WhatChanged } from "./screens/WhatChanged";
import { Accuracy } from "./screens/Accuracy";
import { NavLink, Shell } from "./ui";

type View =
  | { name: "boot" }
  | { name: "profile"; firstRun: boolean }
  | { name: "ready" }
  | { name: "history" }
  | { name: "investigating" }
  | { name: "file" }
  | { name: "changed"; diff: CaseDiff }
  | { name: "accuracy"; back: "profile" | "file" };

type Captured = { capture: Capture; preview: ListingPreview; screenshot: Blob | null };
/** The case on screen. Title and price come from the capture (new case) or the server, never from local storage. */
type Active = { caseId: string; title: string; priceGBP: number | null; detail: CaseDetail | null };

type InvAction = { type: "reset"; revision: number; at: number } | { type: "event"; e: IncomingEvent };
const invReducer = (s: Investigation, a: InvAction) => (a.type === "reset" ? newInvestigation(a.revision, a.at) : applyEvent(s, a.e));

const message = (err: unknown) =>
  err instanceof ApiError ? (err.status === 403 ? "The server doesn't accept requests from this extension yet. Add its origin to ALLOWED_EXTENSION_ORIGINS." : err.message) : "Something went wrong. Try again.";

export function App() {
  const [view, setView] = useState<View>({ name: "boot" });
  const [apiBase, setApiBase] = useState(DEFAULT_API_BASE);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [summaries, setSummaries] = useState<Record<string, CaseSummary>>({});
  const [historyState, setHistoryState] = useState<{ loading: boolean; error: string | null }>({ loading: false, error: null });
  const [ready, setReady] = useState<ReadyState>({ kind: "loading" });
  const [captured, setCaptured] = useState<Captured | null>(null);
  const [active, setActive] = useState<Active | null>(null);
  const [inv, dispatch] = useReducer(invReducer, newInvestigation(1, Date.now()));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lost, setLost] = useState(false);
  /** The answer sent to "Is this the right item?": the card locks and the investigation continues below it. */
  const [answered, setAnswered] = useState<IdentityChoice | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const unsub = useRef<(() => void) | null>(null);
  const finished = useRef<string | null>(null);
  const evidenceCapture = useRef<Capture | null>(null);
  /** The search survey screen's state. */
  const [survey, setSurvey] = useState<{ summary: string | null; added: number | null; busy: boolean; error: string | null }>({ summary: null, added: null, busy: false, error: null });
  /** A suggested listing opened from a case file: investigate it as soon as its page is read. */
  const pendingInvestigate = useRef<{ url: string; loaded: boolean } | null>(null);
  /** "Compared with your survey of “nike pegasus 40” (38 listings)" on the Investigate screen. */
  const [surveyNote, setSurveyNote] = useState<string | null>(null);

  const api = useMemo(() => createApi(apiBase), [apiBase]);
  const loadEvalSummary = useCallback(() => api.getEvalSummary(), [api]);

  // ---------- boot ----------
  useEffect(() => {
    void (async () => {
      const [settings, p, h] = await Promise.all([loadSettings(), loadProfile(), loadHistory()]);
      setApiBase(settings.apiBase);
      setProfile(p);
      setHistory(h);
      setView(p ? { name: "ready" } : { name: "profile", firstRun: true });
    })();
    return () => unsub.current?.();
  }, []);

  // ---------- history: summaries come from the server; cases it can't find are dropped silently ----------
  const refreshSummaries = useCallback(
    async (list: HistoryEntry[]) => {
      if (!list.length) {
        setSummaries({});
        setHistoryState({ loading: false, error: null });
        return;
      }
      setHistoryState((s) => ({ ...s, loading: true }));
      try {
        const found = await api.getSummaries(list.map((e) => e.caseId));
        setSummaries(Object.fromEntries(found.map((s) => [s.id, s])));
        const kept = keepFound(list, found);
        if (kept.length !== list.length) setHistory(await saveHistory(kept));
        setHistoryState({ loading: false, error: null });
      } catch (err) {
        // Server unreachable: keep local history as it is.
        setHistoryState({ loading: false, error: message(err) });
      }
    },
    [api],
  );

  // Refresh when the History or Case ready screen opens (or the server changes), not on every local history edit.
  const wantsSummaries = view.name === "history" || view.name === "ready";
  const historyRef = useRef(history);
  historyRef.current = history;
  useEffect(() => {
    if (wantsSummaries) void refreshSummaries(historyRef.current);
  }, [wantsSummaries, refreshSummaries]);

  const profileRef = useRef(profile);
  profileRef.current = profile;

  // ---------- capture the active tab while on Case ready ----------
  const refreshCapture = useCallback(async () => {
    // A search results page: offer the survey instead of an investigation.
    const page = searchPageOf(await activeTabUrl().catch(() => null));
    if (page) {
      setCaptured(null);
      const existing = (await loadSurveys()).find((x) => x.key === page.key);
      setSurvey({ summary: existing ? summaryLine(summariseSurvey(existing, profileRef.current)) : null, added: null, busy: false, error: null });
      setReady({ kind: "search", page });
      return;
    }
    const r = await captureActiveTab();
    if (!r.ok) {
      setCaptured(null);
      setReady(r.reason === "no_access" ? { kind: "no_access", host: r.host, origin: r.origin } : { kind: "no_listing" });
      return;
    }
    const p = prepareCapture(r.raw);
    if (!p.capture.pageText && !p.capture.imageUrls) {
      setCaptured(null);
      setReady({ kind: "no_listing" });
      return;
    }
    setCaptured({ ...p, screenshot: null });
    const s = surveyForCase(await loadSurveys(), { platform: p.preview.platform, pageUrl: p.preview.pageUrl, now: Date.now() });
    setSurveyNote(s ? `Compared with your survey${s.searchQuery ? ` of “${s.searchQuery}”` : ""} (${s.observedListings.length} listing${s.observedListings.length === 1 ? "" : "s"})` : null);
    setReady({ kind: "listing", preview: p.preview });
  }, []);

  useEffect(() => {
    if (view.name !== "ready") return;
    void refreshCapture();
    return onActiveListingChange(() => void refreshCapture());
  }, [view.name, refreshCapture]);

  // A suggested listing has loaded and been read: start its investigation (the normal capture flow).
  useEffect(() => {
    const want = pendingInvestigate.current;
    // Only once its tab has loaded (the panel may first read the tab it was opened from).
    if (!want?.loaded || view.name !== "ready" || busy || ready.kind === "loading") return;
    pendingInvestigate.current = null;
    if (ready.kind !== "listing") return; // can't capture it automatically: the normal screen (e.g. Allow) stays up
    const id = listingItemId(want.url, detectPlatform(want.url));
    if (id && id === listingItemId(ready.preview.pageUrl, ready.preview.platform)) void investigate("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, view.name, busy]);

  // ---------- live investigation ----------
  const follow = useCallback(
    (caseId: string, revision: number) => {
      unsub.current?.();
      finished.current = null;
      setLost(false);
      dispatch({ type: "reset", revision, at: Date.now() });
      unsub.current = api.stream(caseId, (e) => dispatch({ type: "event", e }), () => setLost(true));
    },
    [api],
  );

  useEffect(() => {
    if (view.name !== "investigating" || !inv.done || !active) return;
    const key = `${active.caseId}:${inv.revision}`;
    if (finished.current === key) return;
    finished.current = key;
    unsub.current?.();
    unsub.current = null;
    void (async () => {
      try {
        const detail = await api.getCase(active.caseId);
        const diff = inv.revision > 1 ? inv.diff : null;
        setActive({ ...active, detail });
        setView(diff ? { name: "changed", diff } : { name: "file" });
      } catch (err) {
        setError(message(err));
        setLost(true);
      }
    })();
  }, [view.name, inv.done, inv.revision, inv.diff, active, api]);

  // ---------- actions ----------
  const investigate = async (note: string) => {
    if (!profile || !captured) return;
    setBusy(true);
    setError(null);
    setAnswered(null);
    setConfirmError(null);
    try {
      // Re-read at the moment of asking: lazy-loaded photos may have appeared, and the screenshot is a fallback image.
      const fresh = await captureActiveTab({ withScreenshot: true });
      const now = fresh.ok ? { ...prepareCapture(fresh.raw), screenshot: fresh.screenshot } : captured;
      // The most recent survey on this platform goes with the case (without this listing).
      const s = surveyForCase(await loadSurveys(), { platform: now.preview.platform, pageUrl: now.preview.pageUrl, now: Date.now() });
      const { caseId } = await api.createCase({
        capture: s ? { ...now.capture, observedListings: s.observedListings, ...(s.searchQuery ? { searchQuery: s.searchQuery } : {}) } : now.capture,
        profile,
        caseNote: note,
        screenshots: now.screenshot ? [now.screenshot] : [],
      });
      const p = now.preview;
      setHistory(await rememberCase({ caseId, createdAt: new Date().toISOString() }));
      setActive({ caseId, title: p.title, priceGBP: p.priceGBP, detail: null });
      follow(caseId, 1);
      setView({ name: "investigating" });
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };

  const surveyNow = async (page: SearchPage) => {
    setSurvey((x) => ({ ...x, busy: true, error: null }));
    const r = await surveyActiveTab();
    if (!r.ok) {
      if (r.reason === "no_access") {
        setReady({ kind: "no_access", host: r.host, origin: r.origin });
        setSurvey((x) => ({ ...x, busy: false }));
      } else setSurvey((x) => ({ ...x, busy: false, error: "Couldn't read this page. Reload it and try again." }));
      return;
    }
    // The tab may have moved on to another search since the screen was drawn.
    const now = searchPageOf(r.raw.pageUrl) ?? page;
    const cards = cardsFromCapture(r.raw, now.platform, new Date().toISOString());
    if (!cards.length) {
      setSurvey((x) => ({ ...x, busy: false, error: "No listings found on this page yet. Wait for the results to load, then try again." }));
      return;
    }
    const { survey: saved, added } = await saveSurveyCards(now, cards);
    setSurvey({ summary: saved ? summaryLine(summariseSurvey(saved, profile)) : null, added: saved && saved.cards.length > added ? added : null, busy: false, error: null });
  };

  /** Investigate a suggested listing: open it, and investigate as soon as it's read (else the normal Investigate button). */
  const investigateListing = async (url: string) => {
    const pending = { url, loaded: false };
    pendingInvestigate.current = pending;
    setError(null);
    unsub.current?.();
    unsub.current = null;
    setView({ name: "ready" });
    setReady({ kind: "loading" });
    const loaded = await openListingTab(url).catch(() => false);
    if (pendingInvestigate.current !== pending) return;
    if (loaded) pending.loaded = true;
    else pendingInvestigate.current = null; // didn't finish loading: the normal Investigate button will be there
    void refreshCapture();
  };

  const openCase = async (caseId: string) => {
    setBusy(true);
    setError(null);
    try {
      const detail = await api.getCase(caseId);
      const s = summaries[caseId];
      setActive({ caseId, title: detail.listingFacts?.title ?? s?.title ?? "Untitled listing", priceGBP: detail.listingFacts?.priceGBP ?? s?.priceGBP ?? null, detail });
      setAnswered(null);
      setConfirmError(null);
      // "Waiting for you": the stream re-asks the question from the stored case.
      if (detail.status === "investigating" || detail.status === "awaiting_confirmation") {
        follow(caseId, detail.revision);
        setView({ name: "investigating" });
      } else {
        setView({ name: "file" });
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        // The server no longer has this case: drop it from local history silently.
        setHistory(await forgetCase(caseId));
      } else {
        setError(message(err));
        setHistoryState((h) => ({ ...h, error: message(err) }));
      }
    } finally {
      setBusy(false);
    }
  };

  /** Answer the card (or correct a finished case) and follow the rest of the investigation on a fresh stream. */
  const confirmIdentity = async (choice: IdentityChoice, from: "card" | "file") => {
    if (!active) return;
    setConfirmError(null);
    if (from === "card") setAnswered(choice);
    try {
      const { revision } = await api.confirmIdentity(active.caseId, choice);
      if (from === "file") setAnswered(null);
      follow(active.caseId, revision);
      setView({ name: "investigating" });
    } catch (err) {
      setAnswered(null);
      setConfirmError(err instanceof ApiError && err.status === 409 ? "This case is no longer waiting for an answer." : message(err));
    }
  };

  const removeFromHistory = async (caseId: string) => {
    setHistory(await forgetCase(caseId));
  };

  const captureForEvidence = async (): Promise<string | null> => {
    const r = await captureActiveTab();
    if (!r.ok) {
      setError(r.reason === "no_access" ? `Sleuth can't read ${r.host} yet. Open the case there and allow it.` : "Nothing to capture on this tab.");
      return null;
    }
    const p = prepareCapture(r.raw);
    evidenceCapture.current = p.capture;
    setError(null);
    return p.preview.title;
  };

  const submitEvidence = async (d: EvidenceDraft) => {
    if (!active) return;
    setBusy(true);
    setError(null);
    try {
      const { revision } = await api.reopen(active.caseId, {
        sellerReply: d.sellerReply,
        screenshots: d.files,
        ...(d.tabTitle && evidenceCapture.current ? { capture: evidenceCapture.current } : {}),
      });
      evidenceCapture.current = null;
      follow(active.caseId, revision);
      setView({ name: "investigating" });
    } catch (err) {
      setError(err instanceof ApiError && err.status === 409 ? "This case is still being investigated." : message(err));
    } finally {
      setBusy(false);
    }
  };

  const saveAll = async (p: Profile, base: string) => {
    const clean = await saveProfile(p);
    await saveSettings({ apiBase: base || DEFAULT_API_BASE });
    setProfile(clean);
    setApiBase((await loadSettings()).apiBase);
    setView({ name: "ready" });
  };

  const goNew = () => {
    unsub.current?.();
    unsub.current = null;
    setError(null);
    setAnswered(null);
    setConfirmError(null);
    setView({ name: "ready" });
  };

  // ---------- render ----------
  const toProfile = () => {
    setError(null);
    setView({ name: "profile", firstRun: false });
  };
  const toHistory = () => {
    unsub.current?.();
    unsub.current = null;
    setError(null);
    setView({ name: "history" });
  };
  const toAccuracy = (back: "profile" | "file") => {
    setError(null);
    setView({ name: "accuracy", back });
  };
  const mainNav = (
    <>
      <NavLink onClick={toHistory}>History</NavLink>
      <NavLink onClick={toProfile}>Profile</NavLink>
    </>
  );

  let nav = null;
  let body = null;
  switch (view.name) {
    case "boot":
      body = <div className="screen" />;
      break;
    case "profile":
      nav = !view.firstRun && <NavLink onClick={goNew}>Back</NavLink>;
      body = <ProfileScreen profile={profile} apiBase={apiBase} firstRun={view.firstRun} onSave={saveAll} onAccuracy={() => toAccuracy("profile")} />;
      break;
    case "ready": {
      const onFile = ready.kind === "listing" ? caseForUrl(history, summaries, ready.preview.pageUrl) : null;
      nav = mainNav;
      body = ready.kind === "search" ? (
        <SearchSurvey page={ready.page} summary={survey.summary} added={survey.added} busy={survey.busy} error={survey.error} onSurvey={() => void surveyNow(ready.page)} />
      ) : profile && (
        <CaseReady
          surveyNote={surveyNote}
          key={ready.kind === "listing" ? ready.preview.pageUrl : ready.kind}
          state={ready}
          profile={profile}
          onFile={onFile}
          busy={busy}
          error={error}
          onInvestigate={investigate}
          onOpenCase={(c) => void openCase(c.id)}
          onEditProfile={toProfile}
          onAllow={async (origin) => {
            if (await requestSiteAccess(origin)) void refreshCapture();
          }}
        />
      );
      break;
    }
    case "history":
      nav = (
        <>
          <NavLink onClick={goNew}>New case</NavLink>
          <NavLink onClick={toProfile}>Profile</NavLink>
        </>
      );
      body = (
        <History
          rows={historyRows(history, summaries)}
          loading={historyState.loading}
          error={historyState.error ?? error}
          onOpen={(id) => void openCase(id)}
          onRemove={(id) => void removeFromHistory(id)}
        />
      );
      break;
    case "investigating":
      nav = <NavLink onClick={goNew}>New case</NavLink>;
      body = active && (
        <Investigating
          caseId={active.caseId}
          title={active.title}
          inv={inv}
          lost={lost}
          onRetry={() => follow(active.caseId, inv.revision)}
          onConfirm={(c) => void confirmIdentity(c, "card")}
          answered={answered}
          confirmError={confirmError}
        />
      );
      break;
    case "file":
      nav = (
        <>
          <NavLink onClick={goNew}>New case</NavLink>
          <NavLink onClick={toHistory}>History</NavLink>
        </>
      );
      body = active?.detail && (
        <CaseFile
          key={`${active.caseId}:${active.detail.revision}`}
          caseId={active.caseId}
          detail={active.detail}
          listing={{ title: active.title, priceGBP: active.priceGBP }}
          addEvidence={{ busy, error, onCaptureTab: captureForEvidence, onSubmit: submitEvidence }}
          onInvestigateListing={(url) => void investigateListing(url)}
          onAccuracy={() => toAccuracy("file")}
          onCorrect={(c) => void confirmIdentity(c, "file")}
          correctError={confirmError}
        />
      );
      break;
    case "accuracy":
      nav = <NavLink onClick={() => (view.back === "file" && active?.detail ? setView({ name: "file" }) : toProfile())}>Back</NavLink>;
      body = <Accuracy load={loadEvalSummary} />;
      break;
    case "changed":
      nav = <NavLink onClick={goNew}>New case</NavLink>;
      body = active && <WhatChanged caseId={active.caseId} diff={view.diff} onOpenFile={() => setView({ name: "file" })} />;
      break;
  }

  return <Shell nav={nav}>{body}</Shell>;
}
