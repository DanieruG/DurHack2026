import { SseEventSchemas, type SseEventData, type SseEventName } from "@/schemas/api";
import type { CaseDiff, CheckName, CheckResult, Lead, NextMove, Verdict } from "@/schemas/domain";

export type LogLine = {
  key: string;
  text: string;
  note?: string;
  state: "active" | "done" | "problem";
  kind: "step" | "followup" | "warning";
  at: number;
};

export type Investigation = {
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
  diff: CaseDiff | null;
  done: boolean;
  fatal: string | null;
};

export type IncomingEvent = { name: SseEventName; data: unknown; revision: number; at: number };

export const ALL_CHECKS: CheckName[] = ["identify", "fit", "price", "comfort", "condition"];

export function newInvestigation(revision: number, at: number): Investigation {
  return {
    revision,
    startedAt: at,
    log: [],
    checks: {},
    expected: revision <= 1 ? [...ALL_CHECKS] : [],
    leads: [],
    leadsSkipped: null,
    verdict: null,
    nextMoves: [],
    diff: null,
    done: false,
    fatal: null,
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
  version_check: "Checking the exact version",
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
      if (d.tier === "family") return { text: `${(d.modelName as string) ?? "Model"}, version unclear`, state: "problem" };
      return ok
        ? { text: `Identified ${(d.modelName as string) ?? "the model"}`, state: "done" }
        : { text: d.tier === "brand" && d.brand ? `${d.brand as string}, model not confirmed` : "Model not confirmed", state: "problem" };
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
      if (!text || s.checks[stage as CheckName]) return { ...s, expected };
      return { ...s, expected, log: upsert(s.log, { key: stage, text, state: "active", kind: "step", at: e.at }) };
    }
    case "stage_done": {
      const { stage } = e.data as SseEventData<"stage_done">;
      const line = s.log.find((l) => l.key === stage);
      if (!line || line.state !== "active") return s;
      return { ...s, log: upsert(s.log, { ...line, state: "done" }) };
    }
    case "check_done": {
      const c = e.data as CheckResult;
      const checks = { ...s.checks, [c.check]: c };
      const expected = s.expected.includes(c.check) ? s.expected : [...s.expected, c.check];
      return { ...s, checks, expected, log: upsert(s.log, { key: c.check, ...checkLine(c), kind: "step", at: e.at }) };
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
    case "verdict":
      return { ...s, verdict: e.data as Verdict };
    case "next_moves":
      return { ...s, nextMoves: e.data as NextMove[] };
    case "diff":
      return { ...s, diff: e.data as CaseDiff };
    case "investigation_done":
      return { ...s, done: true, log: settle(s.log) };
  }
}

/** Progress strip: one segment per expected check, filled when it reports. */
export function segments(s: Investigation): { check: CheckName; done: boolean }[] {
  return s.expected.map((check) => ({ check, done: !!s.checks[check] }));
}
