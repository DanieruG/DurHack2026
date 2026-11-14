import { z } from "zod";
import type { CheckName, CheckResult, Evidence, Verdict, VerdictLabel } from "@/schemas/domain";
import { generateStructured } from "@/gemini/structured";
import type { GeminiClient } from "@/gemini/client";
import { decideBadge, decideVerdict, verdictConfidence, type RuleDecision } from "./rules";
import { validateVerdictText, type GeneratedText } from "./validate";
import { indexEvidence } from "../util";

const WordingWireSchema = z.object({
  headline: z.string(),
  explanation: z.string(),
  citedEvidenceIds: z.array(z.string()),
});

const LABEL_MEANING: Record<VerdictLabel, string> = {
  hidden_gem: "a genuinely good find: fits, fairly or under-priced, condition as described",
  worth_a_look: "nothing wrong found; worth a closer look",
  proceed_with_caution: "loose ends or concerns to resolve before buying",
  overpriced: "the price doesn't stack up against the evidence",
  wrong_fit: "the size won't fit this buyer",
  not_enough_evidence: "the exact model couldn't be confirmed, so the other checks couldn't run",
};

const WORDING_SYSTEM = `You are Sleuth, a sceptical but fair detective giving a second opinion on a second-hand trainer listing.
You do NOT choose the verdict: it has already been decided by rules. Write:
- headline: one short line in a dry detective voice (max 12 words).
- explanation: 2 to 4 plain sentences explaining the verdict for this buyer.
- citedEvidenceIds: ids of the evidence items you relied on (only ids from the list given).
Rules: use only facts in the evidence and check summaries; never invent numbers. Mention every check whose status is fail or warn.
Any price claim must say its source ("compared with N listings sampled on <date>" or "the current new price from retailers").
Never accuse the seller. Never use these words: scam, fake, fraud, liar, rip-off, guaranteed.`;

const ORDER: CheckName[] = ["identify", "fit", "price", "condition", "comfort"];

function compactChecks(checks: CheckResult[]) {
  return checks.map((c) => ({
    check: c.check,
    status: c.status,
    summary: c.summary,
    confidence: c.confidence,
    evidence: c.evidence.map((e) => ({ id: e.id, label: e.label, ...(e.quote ? { quote: e.quote.slice(0, 160) } : {}), ...(e.observedOn ? { observedOn: e.observedOn } : {}) })),
  }));
}

const HEADLINES: Record<VerdictLabel, string> = {
  hidden_gem: "The evidence points one way: a proper find.",
  worth_a_look: "Nothing out of place. Worth a closer look.",
  proceed_with_caution: "A few loose ends before you buy.",
  overpriced: "The numbers don't add up on price.",
  wrong_fit: "Case closed on size: these won't fit you.",
  not_enough_evidence: "Not enough evidence to name the suspect.",
};

const CLOSERS: Record<VerdictLabel, string> = {
  hidden_gem: "Every check came back clean, so this one is worth moving on.",
  worth_a_look: "Nothing here rules it out; check the details below before you commit.",
  proceed_with_caution: "Ask the seller the questions below before you commit.",
  overpriced: "Unless the seller can explain it, you can likely do better elsewhere.",
  wrong_fit: "Unless the seller has the size wrong, this pair isn't for you.",
  not_enough_evidence: "Ask the seller for the model name or a photo of the size label inside the tongue.",
};

/** Deterministic fallback wording per label; always passes the validator. */
export function templateVerdictText(label: VerdictLabel, checks: CheckResult[]): GeneratedText {
  const byOrder = [...checks].sort((a, b) => ORDER.indexOf(a.check) - ORDER.indexOf(b.check));
  const flagged = byOrder.filter((c) => c.status === "fail" || c.status === "warn");
  let picks: CheckResult[];
  if (label === "not_enough_evidence") picks = byOrder.filter((c) => c.check === "identify");
  else if (flagged.length) picks = flagged.slice(0, 3);
  else picks = byOrder.filter((c) => c.status !== "unknown" && c.check !== "identify").slice(0, 2);
  const sentences = picks.map((c) => c.summary.trim().replace(/\s+/g, " "));
  sentences.push(CLOSERS[label]);
  // Keep within 4 sentences (summaries may contain more than one sentence each).
  let explanation = sentences.join(" ");
  const split = explanation.split(/(?<=[.!?])\s+/);
  if (split.length > 4) explanation = [...split.slice(0, 3), CLOSERS[label]].join(" ");
  const cited = picks.flatMap((c) => c.evidence.slice(0, 2).map((e) => e.id));
  return { headline: HEADLINES[label], explanation, citedEvidenceIds: [...new Set(cited)] };
}

export async function decideAndWordVerdict(
  gemini: GeminiClient | null,
  args: { checks: CheckResult[]; identifyPassed: boolean; extraEvidence?: Evidence[] },
): Promise<{ verdict: Verdict; usedTemplate: boolean }> {
  const decision: RuleDecision = decideVerdict(args.checks, args.identifyPassed);
  const evidence = indexEvidence(...args.checks.map((c) => c.evidence), args.extraEvidence);
  const ctx = { checks: args.checks, evidence };
  const base = {
    label: decision.label,
    ruleId: decision.ruleId,
    confidence: verdictConfidence(decision, args.checks),
    badge: decideBadge(decision.label, args.checks),
  };

  let text: GeneratedText | null = null;
  if (gemini) {
    const prompt = `Verdict (fixed by rules): ${decision.label} (${LABEL_MEANING[decision.label]}), rule ${decision.ruleId}.\nChecks:\n${JSON.stringify(compactChecks(args.checks))}`;
    let feedback = "";
    for (let attempt = 0; attempt < 2 && !text; attempt++) {
      try {
        const { data } = await generateStructured(gemini, WordingWireSchema, {
          stage: "verdict",
          tier: "fast",
          system: WORDING_SYSTEM,
          parts: [{ text: prompt + feedback }],
          temperature: 0.6,
        });
        const errors = validateVerdictText(data, ctx);
        if (errors.length === 0) text = data;
        else feedback = `\n\nYour previous attempt was rejected:\n- ${errors.join("\n- ")}\nFix these problems.`;
      } catch {
        break;
      }
    }
  }
  const usedTemplate = !text;
  const final = text ?? templateVerdictText(decision.label, args.checks);
  return { verdict: { ...base, ...final }, usedTemplate };
}
