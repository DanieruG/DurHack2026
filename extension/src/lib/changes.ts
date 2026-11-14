import type { CaseDiff, CheckName } from "@/schemas/domain";
import { CHECK_NAMES, statusDirection } from "./format";

export type Change = {
  check: CheckName;
  name: string;
  before: string;
  after: string;
  direction: "upgraded" | "downgraded" | "updated";
  reason: string;
};

const withStop = (s: string) => (/[.!?]$/.test(s.trim()) ? s.trim() : `${s.trim()}.`);

export function describeDiff(diff: CaseDiff): { line: string; changes: Change[] } {
  const changes: Change[] = diff.checks.map((c) => ({
    check: c.check,
    name: CHECK_NAMES[c.check],
    before: c.before,
    after: c.after,
    direction: statusDirection(c.before, c.after),
    reason: c.reason,
  }));
  const lead = changes.find((c) => c.direction !== "updated") ?? changes[0];
  const line = lead
    ? `${withStop(lead.reason)} ${lead.name} ${lead.direction}.`
    : diff.verdict.before === diff.verdict.after
      ? "The new evidence didn't change any finding."
      : "The verdict was re-weighed with the new evidence.";
  return { line, changes };
}
