import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { CaseDetail } from "@/schemas/api";
import type { Capture, CaseDiff, Profile } from "@/schemas/domain";
import { ApiError, createApi } from "../chrome/api";
import {
  caseForUrl,
  DEFAULT_API_BASE,
  loadCases,
  loadProfile,
  loadSettings,
  saveCase,
  saveProfile,
  saveSettings,
  takeCaseNumber,
  updateCase,
  type StoredCase,
} from "../chrome/storage";
import { captureActiveTab, onActiveListingChange, requestSiteAccess } from "../chrome/tab";
import { prepareCapture, type ListingPreview } from "../lib/capture";
import { applyEvent, newInvestigation, type IncomingEvent, type Investigation } from "../lib/progress";
import { CaseFile, type EvidenceDraft } from "./screens/CaseFile";
import { CaseReady, type ReadyState } from "./screens/CaseReady";
import { Investigating } from "./screens/Investigating";
import { ProfileScreen } from "./screens/Profile";
import { WhatChanged } from "./screens/WhatChanged";
import { NavLink, Shell } from "./ui";

type View =
  | { name: "boot" }
  | { name: "profile"; firstRun: boolean }
  | { name: "ready" }
  | { name: "investigating" }
  | { name: "file" }
  | { name: "changed"; diff: CaseDiff };

type Captured = { capture: Capture; preview: ListingPreview; screenshot: Blob | null };
type Active = { stored: StoredCase; detail: CaseDetail | null };

type InvAction = { type: "reset"; revision: number; at: number } | { type: "event"; e: IncomingEvent };
const invReducer = (s: Investigation, a: InvAction) => (a.type === "reset" ? newInvestigation(a.revision, a.at) : applyEvent(s, a.e));

const message = (err: unknown) =>
  err instanceof ApiError ? (err.status === 403 ? "The server doesn't accept requests from this extension yet. Add its origin to ALLOWED_EXTENSION_ORIGINS." : err.message) : "Something went wrong. Try again.";

export function App() {
  const [view, setView] = useState<View>({ name: "boot" });
  const [apiBase, setApiBase] = useState(DEFAULT_API_BASE);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [cases, setCases] = useState<Record<string, StoredCase>>({});
  const [ready, setReady] = useState<ReadyState>({ kind: "loading" });
  const [captured, setCaptured] = useState<Captured | null>(null);
  const [active, setActive] = useState<Active | null>(null);
  const [inv, dispatch] = useReducer(invReducer, newInvestigation(1, Date.now()));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lost, setLost] = useState(false);
  const unsub = useRef<(() => void) | null>(null);
  const finished = useRef<string | null>(null);
  const evidenceCapture = useRef<Capture | null>(null);

  const api = useMemo(() => createApi(apiBase), [apiBase]);

  // ---------- boot ----------
  useEffect(() => {
    void (async () => {
      const [settings, p, c] = await Promise.all([loadSettings(), loadProfile(), loadCases()]);
      setApiBase(settings.apiBase);
      setProfile(p);
      setCases(c);
      setView(p ? { name: "ready" } : { name: "profile", firstRun: true });
    })();
    return () => unsub.current?.();
  }, []);

  // ---------- capture the active tab while on Case ready ----------
  const refreshCapture = useCallback(async () => {
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
    setReady({ kind: "listing", preview: p.preview });
  }, []);

  useEffect(() => {
    if (view.name !== "ready") return;
    void refreshCapture();
    return onActiveListingChange(() => void refreshCapture());
  }, [view.name, refreshCapture]);

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
    const key = `${active.stored.id}:${inv.revision}`;
    if (finished.current === key) return;
    finished.current = key;
    unsub.current?.();
    unsub.current = null;
    void (async () => {
      try {
        const detail = await api.getCase(active.stored.id);
        const diff = inv.revision > 1 ? inv.diff : null;
        const stored =
          (await updateCase(active.stored.id, {
            revision: detail.revision,
            verdictLabel: detail.verdict?.label,
            diffs: diff ? { [String(diff.toRevision)]: diff } : {},
          })) ?? active.stored;
        setCases(await loadCases());
        setActive({ stored, detail });
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
    try {
      // Re-read at the moment of asking: lazy-loaded photos may have appeared, and the screenshot is a fallback image.
      const fresh = await captureActiveTab({ withScreenshot: true });
      const now = fresh.ok ? { ...prepareCapture(fresh.raw), screenshot: fresh.screenshot } : captured;
      const { caseId } = await api.createCase({
        capture: now.capture,
        profile,
        caseNote: note,
        screenshots: now.screenshot ? [now.screenshot] : [],
      });
      const p = now.preview;
      const stored: StoredCase = {
        id: caseId,
        number: await takeCaseNumber(),
        pageUrl: p.pageUrl,
        title: p.title,
        priceGBP: p.priceGBP,
        platform: p.platform,
        photoCount: p.photoCount,
        thumbnail: p.thumbnail,
        createdAt: new Date().toISOString(),
        revision: 1,
        diffs: {},
      };
      await saveCase(stored);
      setCases(await loadCases());
      setActive({ stored, detail: null });
      follow(caseId, 1);
      setView({ name: "investigating" });
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };

  const openCase = async (stored: StoredCase) => {
    setBusy(true);
    setError(null);
    try {
      const detail = await api.getCase(stored.id);
      setActive({ stored, detail });
      if (detail.status === "investigating") {
        follow(stored.id, detail.revision);
        setView({ name: "investigating" });
      } else {
        setView({ name: "file" });
      }
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
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
      const { revision } = await api.reopen(active.stored.id, {
        sellerReply: d.sellerReply,
        screenshots: d.files,
        ...(d.tabTitle && evidenceCapture.current ? { capture: evidenceCapture.current } : {}),
      });
      evidenceCapture.current = null;
      follow(active.stored.id, revision);
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
    setView({ name: "ready" });
  };

  // ---------- render ----------
  const toProfile = () => {
    setError(null);
    setView({ name: "profile", firstRun: false });
  };

  let nav = null;
  let body = null;
  switch (view.name) {
    case "boot":
      body = <div className="screen" />;
      break;
    case "profile":
      nav = !view.firstRun && <NavLink onClick={goNew}>Back</NavLink>;
      body = <ProfileScreen profile={profile} apiBase={apiBase} firstRun={view.firstRun} onSave={saveAll} />;
      break;
    case "ready": {
      const onFile = ready.kind === "listing" ? caseForUrl(cases, ready.preview.pageUrl) : null;
      nav = <NavLink onClick={toProfile}>Profile</NavLink>;
      body = profile && (
        <CaseReady
          key={ready.kind === "listing" ? ready.preview.pageUrl : ready.kind}
          state={ready}
          profile={profile}
          onFile={onFile}
          busy={busy}
          error={error}
          onInvestigate={investigate}
          onOpenCase={openCase}
          onEditProfile={toProfile}
          onAllow={async (origin) => {
            if (await requestSiteAccess(origin)) void refreshCapture();
          }}
        />
      );
      break;
    }
    case "investigating":
      nav = <NavLink onClick={goNew}>New case</NavLink>;
      body = active && (
        <Investigating
          number={active.stored.number}
          title={active.stored.title}
          inv={inv}
          lost={lost}
          onRetry={() => follow(active.stored.id, inv.revision)}
        />
      );
      break;
    case "file":
      nav = <NavLink onClick={goNew}>New case</NavLink>;
      body = active?.detail && (
        <CaseFile
          key={`${active.stored.id}:${active.detail.revision}`}
          number={active.stored.number}
          detail={active.detail}
          listing={{ title: active.stored.title, priceGBP: active.stored.priceGBP }}
          addEvidence={{ busy, error, onCaptureTab: captureForEvidence, onSubmit: submitEvidence }}
        />
      );
      break;
    case "changed":
      nav = <NavLink onClick={goNew}>New case</NavLink>;
      body = active && <WhatChanged number={active.stored.number} diff={view.diff} onOpenFile={() => setView({ name: "file" })} />;
      break;
  }

  return <Shell nav={nav}>{body}</Shell>;
}
