import { SseEventSchemas, type IdentityOption, type SseEventData, type SseEventName } from "@/schemas/api";
import { NewOffersSchema, type CaseDiff, type CheckName, type CheckResult, type Lead, type NewOffers, type NextMove, type ObservedAlternatives, type Verdict, type WarningSignal } from "@/schemas/domain";
import { openableOffers } from "./offers";
import { checkTags, stepTags } from "./tags";

export type LogLine = {
  key: string;
  text: string;
  note?: string;
  state: "active" | "done" | "problem";
  kind: "step" | "followup" | "warning";
  at: number;
  /** What the step actually used, e.g. "Gemini vision · object detection", "Web search", "cached". */
  tags?: string[];
};

/** The identity_check_needed event: what the "Is this the right item?" card shows. */
export type IdentityCheck = SseEventData<"identity_check_needed">;
export type { IdentityOption };

export type Investigation = {
  /** Set while the investigation waits for the buyer to confirm the model. */
  identityCheck: IdentityCheck | null;
  revision: number;
  startedAt: number;
  log: LogLine[];
  checks: Partial<Record<CheckName, CheckResult>>;
  /** Checks this revision is expected to (re)run; drives the progress strip. */
  expected: CheckName[];
  leads: Lead[];
  /** Why follow-up leads were skipped, when they were. */
  leadsSkipped: string | null;
  verdict: Verdict | null;
  nextMoves: NextMove[];
  warningSignals: WarningSignal[];
  /** New-price offers: from new_offers as soon as the Shopping lookup finishes, then from the price check itself. */
  newOffers: NewOffers | null;
  /** Cheaper listings from the user's survey: from observed_alternatives as soon as the price check has them. */
  observedAlternatives: ObservedAlternatives | null;
  /** The price check has started and not reported yet: the offers slot is reserved. */
  priceRunning: boolean;
  diff: CaseDiff | null;
  done: boolean;
  fatal: string | null;
  /** From investigation_done. */
  totals: { durationMs: number; geminiCalls: number; cachedCalls?: number } | null;
};

export type IncomingEvent = { name: SseEventName; data: unknown; revision: number; at: number };

export const ALL_CHECKS: CheckName[] = ["identify", "fit", "price", "comfort", "condition"];

export function newInvestigation(revision: number, at: number): Investigation {
  return {
    identityCheck: null,
    revision,
    startedAt: at,
    log: [],
    checks: {},
    expected: revision <= 1 ? [...ALL_CHECKS] : [],
    leads: [],
    leadsSkipped: null,
    verdict: null,
    nextMoves: [],
    warningSignals: [],
    newOffers: null,
    observedAlternatives: null,
    priceRunning: false,
    diff: null,
    done: false,
    fatal: null,
    totals: null,
  };
}

/** "3:12" -> 3. Event ids are "<revision>:<seq>". */
export function revisionOf(eventId: string | null | undefined): number | null {
  const m = eventId?.match(/^(\d+):\d+$/);
  return m ? Number(m[1]) : null;
}

export function parseEvent(name: string, raw: string): { name: SseEventName; data: unknown } | null {
  if (!(name in SseEventSchemas)) return null;
  const n = name as SseEventName;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = SseEventSchemas[n].safeParse(json);
  return parsed.success ? { name: n, data: parsed.data } : null;
}

const STAGE_TEXT: Partial<Record<string, string>> = {
  extract: "Reading the listing",
  identify: "Identifying the model",
  fit: "Checking size",
  price: "Comparing prices",
  comfort: "Reading reviews",
  condition: "Inspecting photos",
  colour: "Checking the colour",
  version_check: "Checking the exact version",
  lens: "Checking visual matches",
  leads: "Deciding what to follow up",
  verdict: "Weighing the evidence",
  reopen: "Reading the new evidence",
};

function sourceCount(c: CheckResult): number {
  return c.evidence.filter((e) => e.kind === "source" || !!e.url).length;
}

function checkLine(c: CheckResult): Pick<LogLine, "text" | "state"> {
  const ok = c.status === "pass";
  const d = (c.details ?? {}) as Record<string, unknown>;
  switch (c.check) {
    case "identify":
      // The server words it by confidence level ("Likely ...", "Best guess: ...").
      if (d.tier === "model" || d.tier === "catalogue" || (d.tier === undefined && ok)) {
        if (typeof d.label !== "string") return { text: ok ? `Identified ${(d.modelName as string) ?? "the model"}` : "Model not confirmed", state: ok ? "done" : "problem" };
        return { text: d.level === "confirmed" ? `Identified ${d.label}` : d.label, state: ok ? "done" : "problem" };
      }
      return { text: d.tier === "brand" && d.brand ? `${d.brand as string}, model not confirmed` : "Model not confirmed", state: "problem" };
    case "fit": {
      if (c.status === "unknown") return { text: "Size not stated", state: "problem" };
      const match = d.match as string | undefined;
      if (ok) return { text: "Size checked", state: "done" };
      if (match === "mismatch") return { text: "Size doesn't match", state: "problem" };
      if (match === "estimated") return { text: "Size estimated across brands", state: "problem" };
      return { text: "Size checked, not exact", state: "problem" };
    }
    case "price": {
      if (c.status === "unknown") return { text: "No reliable price comparison", state: "problem" };
      const n = (d.sample as { n?: number } | undefined)?.n;
      return { text: n ? `Prices compared, ${n} listings` : "Prices compared", state: ok ? "done" : "problem" };
    }
    case "comfort": {
      const n = sourceCount(c);
      return { text: n ? `Reviews read, ${n} source${n === 1 ? "" : "s"}` : "No reviews found", state: ok ? "done" : "problem" };
    }
    case "condition": {
      if (c.status === "unknown") return { text: "No usable photos", state: "problem" };
      const findings = ((d.findings as unknown[]) ?? []).length;
      if (!findings) return { text: "Photos inspected, no defects", state: ok ? "done" : "problem" };
      return { text: `Photos inspected, ${findings} finding${findings === 1 ? "" : "s"}`, state: ok ? "done" : "problem" };
    }
    case "colour":
      if (c.status === "unknown") return { text: "Colour unclear", state: "problem" };
      return ok ? { text: "Colour matches what you asked for", state: "done" } : { text: "Colour may not match", state: "problem" };
  }
}

export function leadText(lead: Lead, checks: Investigation["checks"]): string {
  switch (lead.type) {
    case "deeper_price_comparison": {
      const pos = (checks.price?.details as { position?: string } | undefined)?.position;
      if (pos === "suspiciously_low" || pos === "below") return "Price looked low. Comparing more carefully.";
      if (pos === "above" || pos === "at_or_above_new") return "Price looked high. Comparing more carefully.";
      return "Comparing the price more carefully.";
    }
    case "recheck_identification":
      return "Model uncertain. Taking a second look.";
    case "recheck_condition_photo":
      return "Something in the photos. Looking again.";
    case "flag_for_seller":
      return "Noted a question for the seller.";
  }
}

function upsert(log: LogLine[], line: LogLine): LogLine[] {
  const i = log.findIndex((l) => l.key === line.key);
  if (i === -1) return [...log, line];
  const next = [...log];
  next[i] = { ...line, at: log[i].at };
  return next;
}

function settle(log: LogLine[]): LogLine[] {
  return log.map((l) => (l.state === "active" ? { ...l, state: "done" } : l));
}

/** Pure reducer: fold one SSE event into the investigation state. Events from older revisions are ignored. */
export function applyEvent(s: Investigation, e: IncomingEvent): Investigation {
  if (e.revision < s.revision) return s;
  if (e.revision > s.revision) s = newInvestigation(e.revision, e.at);

  switch (e.name) {
    case "investigation_started":
      return s;
    case "case_reopened":
      return { ...s, log: upsert(s.log, { key: "reopen:start", text: "Reopened with new evidence", state: "done", kind: "step", at: e.at }) };
    case "stage_started": {
      const { stage } = e.data as SseEventData<"stage_started">;
      const text = STAGE_TEXT[stage];
      const expected = (ALL_CHECKS as string[]).includes(stage) && !s.expected.includes(stage as CheckName)
        ? [...s.expected, stage as CheckName]
        : s.expected;
      if (stage === "price") s = { ...s, priceRunning: true };
      if (!text || s.checks[stage as CheckName]) return { ...s, expected };
      return { ...s, expected, log: upsert(s.log, { key: stage, text, state: "active", kind: "step", at: e.at }) };
    }
    case "stage_done": {
      const data = e.data as SseEventData<"stage_done">;
      const line = s.log.find((l) => l.key === data.stage);
      if (!line) return s;
      // A check's own line keeps the check's tags; a plain step shows what the stage actually used.
      const tags = s.checks[data.stage as CheckName] ? line.tags : stepTags(data);
      return { ...s, log: upsert(s.log, { ...line, state: line.state === "active" ? "done" : line.state, tags }) };
    }
    case "identity_check_needed":
      return { ...s, identityCheck: e.data as IdentityCheck, log: upsert(s.log, { key: "identity:needed", text: "Needs your confirmation of the model", state: "problem", kind: "warning", at: e.at }) };
    case "check_done": {
      const c = e.data as CheckResult;
      // The buyer's answer (confirmed, corrected or skipped) is recorded on the identify check: the question is closed.
      if (c.check === "identify" && (c.details as { userChoice?: string } | undefined)?.userChoice) {
        s = { ...s, identityCheck: null, log: s.log.filter((l) => l.key !== "identity:needed") };
      }
      if (c.check === "price") {
        // The finished price check is the word on its offers (none at all if, say, the version turned out unclear).
        const offers = NewOffersSchema.safeParse((c.details as { newOffers?: unknown } | undefined)?.newOffers);
        s = { ...s, priceRunning: false, newOffers: offers.success ? offers.data : null };
      }
      const checks = { ...s.checks, [c.check]: c };
      const expected = s.expected.includes(c.check) ? s.expected : [...s.expected, c.check];
      return { ...s, checks, expected, log: upsert(s.log, { key: c.check, ...checkLine(c), kind: "step", at: e.at, tags: checkTags(c) }) };
    }
    case "lead_started":
    case "lead_done": {
      const lead = e.data as Lead;
      const leads = [...s.leads.filter((l) => l.id !== lead.id), lead];
      const done = e.name === "lead_done";
      const note = done ? (lead.status === "done" ? lead.outcome : lead.status === "failed" ? "Couldn't complete this." : undefined) : undefined;
      const existing = s.log.find((l) => l.key === `lead:${lead.id}`);
      return {
        ...s,
        leads,
        log: upsert(s.log, {
          key: `lead:${lead.id}`,
          text: existing?.text ?? leadText(lead, s.checks),
          ...(note ? { note } : {}),
          state: done ? "done" : "active",
          kind: "followup",
          at: e.at,
        }),
      };
    }
    case "leads_skipped": {
      const { reason } = e.data as SseEventData<"leads_skipped">;
      return {
        ...s,
        leadsSkipped: reason,
        log: upsert(s.log, { key: "leads:skipped", text: "No follow-ups", note: reason.replace(/^Skipped:\s*/, ""), state: "done", kind: "followup", at: e.at }),
      };
    }
    case "capture_warning": {
      const { message } = e.data as SseEventData<"capture_warning">;
      return { ...s, log: upsert(s.log, { key: `warn:${message}`, text: message, state: "problem", kind: "warning", at: e.at }) };
    }
    case "error": {
      const { stage, message } = e.data as SseEventData<"error">;
      if (!stage) return { ...s, fatal: message };
      return { ...s, log: upsert(s.log, { key: `error:${stage}`, text: message, state: "problem", kind: "warning", at: e.at }) };
    }
    case "new_offers":
      return { ...s, newOffers: e.data as NewOffers };
    case "observed_alternatives":
      return { ...s, observedAlternatives: e.data as ObservedAlternatives };
    case "verdict":
      return { ...s, verdict: e.data as Verdict };
    case "warning_signals":
      return { ...s, warningSignals: e.data as WarningSignal[] };
    case "next_moves":
      return { ...s, nextMoves: e.data as NextMove[] };
    case "diff":
      return { ...s, diff: e.data as CaseDiff };
    case "investigation_done": {
      const d = e.data as SseEventData<"investigation_done">;
      return { ...s, done: true, log: settle(s.log), totals: { durationMs: d.durationMs, geminiCalls: d.geminiCalls, cachedCalls: d.cachedCalls } };
    }
  }
}

/** The live offers slot: reserved while the price check runs, filled once offers that can be opened arrive. */
export function offersSlot(s: Investigation): { show: boolean; data: NewOffers | null } {
  const data = s.newOffers && openableOffers(s.newOffers).length ? s.newOffers : null;
  return { show: !!data || s.priceRunning, data };
}

/** Progress strip: one segment per expected check, filled when it reports. */
export function segments(s: Investigation): { check: CheckName; done: boolean }[] {
  return s.expected.map((check) => ({ check, done: !!s.checks[check] }));
}
