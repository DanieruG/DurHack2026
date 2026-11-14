import type { CheckName, CheckResult, ConditionFinding, VerdictLabel } from "@/schemas/domain";

export type RuleId = "R1" | "R2" | "R3" | "R4" | "R5" | "R6" | "R7";

export type RuleDecision = { label: VerdictLabel; ruleId: RuleId };

const get = (checks: CheckResult[], name: CheckName) => checks.find((c) => c.check === name);

/**
 * Deterministic decision table (spec 7.9). Evaluated in order; first match wins.
 * Gemini never chooses or changes the label. `brandKnown`: R1 fires only when identify couldn't even name the brand.
 */
export function decideVerdict(checks: CheckResult[], brandKnown: boolean): RuleDecision {
  if (!brandKnown) return { label: "not_enough_evidence", ruleId: "R1" };
  if (get(checks, "fit")?.status === "fail") return { label: "wrong_fit", ruleId: "R2" };
  if (get(checks, "price")?.status === "fail") return { label: "overpriced", ruleId: "R3" };
  if (get(checks, "condition")?.status === "fail") return { label: "proceed_with_caution", ruleId: "R4" };
  // R5: any warn or unknown. (A "fail" not caught above, e.g. a comfort fail, is treated the same way: never R6/R7.)
  const core: CheckName[] = ["identify", "fit", "price", "comfort", "condition"];
  const all = core.map((c) => get(checks, c));
  if (all.some((c) => !c || c.status !== "pass")) return { label: "proceed_with_caution", ruleId: "R5" };
  const position = (get(checks, "price")?.details as { position?: string } | undefined)?.position;
  const findings = ((get(checks, "condition")?.details as { findings?: ConditionFinding[] } | undefined)?.findings ?? []);
  const aboveMinor = findings.some((f) => f.severity !== "minor");
  if (position === "below" && !aboveMinor) return { label: "hidden_gem", ruleId: "R6" };
  return { label: "worth_a_look", ruleId: "R7" };
}

/** Badge: out_sleuthed when hidden_gem and every check's confidence >= 0.7, except price which may be >= 0.6. */
export function decideBadge(label: VerdictLabel, checks: CheckResult[]): "out_sleuthed" | null {
  if (label !== "hidden_gem") return null;
  const ok = checks.every((c) => c.confidence >= (c.check === "price" ? 0.6 : 0.7));
  return ok ? "out_sleuthed" : null;
}

/** Verdict confidence: the weakest link among the checks that decided it. */
export function verdictConfidence(decision: RuleDecision, checks: CheckResult[]): number {
  if (decision.ruleId === "R1") return get(checks, "identify")?.confidence ?? 0;
  const decisive: Record<RuleId, CheckName[] | null> = {
    R1: ["identify"],
    R2: ["fit"],
    R3: ["price"],
    R4: ["condition"],
    R5: null,
    R6: null,
    R7: null,
  };
  const names = decisive[decision.ruleId];
  const pool = names ? checks.filter((c) => names.includes(c.check)) : checks.filter((c) => c.status !== "unknown");
  if (!pool.length) return 0;
  return Math.round(Math.min(...pool.map((c) => c.confidence)) * 100) / 100;
}
