import { z } from "zod";
import type { CheckName, CheckResult, Lead, NextMove, VerdictLabel } from "@/schemas/domain";
import { generateStructured } from "@/gemini/structured";
import type { GeminiClient } from "@/gemini/client";
import { validateNextMoveText } from "./verdict/validate";
import { versionQuestion } from "./versionCheck";
import { gbp } from "./util";

export const MAX_QUESTIONS = 3;

/** `exact`: the fallback is the question, word for word (not rephrased by Gemini). */
export type Gap = { id: string; check: CheckName; priority: number; ask: string; fallback: string; exact?: boolean };

const PRIORITY: Record<CheckName, number> = { identify: 0, fit: 1, condition: 2, price: 3, comfort: 5 };

type Details = Record<string, unknown> | undefined;

function gapFor(c: CheckResult): Gap | null {
  const d = c.details as Details;
  switch (c.check) {
    case "identify": {
      const v = d?.versionUnclear as { family: string; options: [string, string | null] } | undefined;
      if (v) {
        const q = versionQuestion((d?.brand as string | null) ?? null, v);
        return { id: "gap_version", check: "identify", priority: PRIORITY.identify, ask: q, fallback: q, exact: true };
      }
      return {
        id: "gap_identify",
        check: "identify",
        priority: PRIORITY.identify,
        ask: "Ask for the exact model name, or a photo of the size label inside the tongue.",
        fallback: "Could you tell me the exact model name, or share a photo of the size label inside the tongue?",
      };
    }
    case "fit": {
      if (d?.match === null || d?.listed === null || d?.listed === undefined) {
        return { id: "gap_fit", check: "fit", priority: PRIORITY.fit, ask: "Ask which size these are, including UK, US or EU.", fallback: "Could you confirm the size, and whether it's UK, US or EU?" };
      }
      if (d?.listedSystemAssumed) {
        return { id: "gap_fit", check: "fit", priority: PRIORITY.fit, ask: `Ask whether size ${String(d.listed)} is UK, US or EU.`, fallback: `Is size ${String(d.listed)} UK, US or EU?` };
      }
      return { id: "gap_fit", check: "fit", priority: PRIORITY.fit, ask: "Ask for the insole length in cm to confirm the fit.", fallback: "Could you measure the insole length in cm for me?" };
    }
    case "condition": {
      const findings = (d?.findings as { label: string; photoIndex: number }[] | undefined) ?? [];
      if (!findings.length && (d?.photosChecked === 0 || d?.photosChecked === undefined)) {
        return { id: "gap_condition", check: "condition", priority: PRIORITY.condition, ask: "Ask for photos of the soles, heels and insides.", fallback: "Could you share a few photos of the soles, heels and insides?" };
      }
      const f = findings[0];
      const area = f ? f.label.replace(/_/g, " ") : "the worn areas";
      return {
        id: "gap_condition",
        check: "condition",
        priority: PRIORITY.condition,
        ask: `Ask for a close-up photo in good light of the ${area}${f ? ` seen in photo ${f.photoIndex + 1}` : ""}.`,
        fallback: `Could you share a close-up photo in daylight of the ${area}${f ? ` shown in photo ${f.photoIndex + 1}` : ""}?`,
      };
    }
    case "price": {
      if (d?.position === "suspiciously_low") {
        return { id: "gap_price", check: "price", priority: PRIORITY.price, ask: "Ask politely whether there are any faults or missing items, given the price.", fallback: "Are there any faults or missing items I should know about?" };
      }
      if (d?.listingPriceGBP === undefined) {
        return { id: "gap_price", check: "price", priority: PRIORITY.price, ask: "Ask for the price including postage.", fallback: "Could you confirm the price including postage?" };
      }
      if (d?.overBudget) return null; // nothing the seller can answer
      return { id: "gap_price", check: "price", priority: PRIORITY.price + 1, ask: "Ask where and when they were bought originally.", fallback: "Do you know roughly when and where these were bought originally?" };
    }
    case "comfort":
      return { id: "gap_comfort", check: "comfort", priority: PRIORITY.comfort, ask: "Ask how they found the fit and comfort, and how often they were worn.", fallback: "How did you find the fit and comfort, and roughly how often were they worn?" };
  }
}

/**
 * Which questions to ask (code decides; Gemini only phrases):
 * one per unknown/warn check, one per flag_for_seller lead, one for not-visible areas that matter;
 * answered checks are dropped; ordered by importance; max 3.
 */
export function computeGaps(args: { checks: CheckResult[]; leads: Lead[]; label: VerdictLabel; answered: CheckName[] }): Gap[] {
  const gaps = new Map<string, Gap>();
  const identify = args.checks.find((c) => c.check === "identify");
  if (identify && identify.status !== "pass") gaps.set("identify", gapFor(identify)!);
  // Without even a brand, only the identity question is worth asking.
  if (args.label !== "not_enough_evidence") {
    for (const c of args.checks) {
      if (c.check === "identify") continue;
      if (c.status !== "warn" && c.status !== "unknown") continue;
      const g = gapFor(c);
      if (g) gaps.set(c.check, g);
    }
  }
  for (const lead of args.leads) {
    if (lead.type !== "flag_for_seller" || !lead.relatesTo || gaps.has(lead.relatesTo)) continue;
    const c = args.checks.find((x) => x.check === lead.relatesTo);
    const g = c ? gapFor(c) : null;
    if (g) gaps.set(lead.relatesTo, { ...g, id: `gap_lead_${lead.id}`, ask: `${g.ask} Context: ${lead.reason}` });
  }
  const condition = args.checks.find((c) => c.check === "condition");
  const soleHidden = ((condition?.details as Details)?.soleNotVisible as string[] | undefined) ?? [];
  const notVisible = (((condition?.details as Details)?.notVisible as string[] | undefined) ?? []).filter((a) => !soleHidden.includes(a));
  // Trainers: always ask for the outsole/heel when no photo shows them, whatever the verdict.
  const soleGap: Gap | null = soleHidden.length
    ? {
        id: "gap_sole_photos",
        check: "condition",
        priority: PRIORITY.condition - 0.5,
        ask: `Ask for clear photos of the ${soleHidden.slice(0, 3).join(", ")}: the listing doesn't show them, and that's where trainers wear first.`,
        fallback: "Could you share clear photos of the soles and heels, please?",
      }
    : null;
  if (notVisible.length && !gaps.has("condition") && condition?.status !== "fail" && args.label !== "wrong_fit" && args.label !== "not_enough_evidence") {
    const areas = notVisible.slice(0, 3).join(", ");
    gaps.set("notVisible", {
      id: "gap_not_visible",
      check: "condition",
      priority: 4,
      ask: `Ask for photos of areas not shown: ${areas}.`,
      fallback: `Could you share photos of the ${areas}?`,
    });
  }
  if (soleGap && /\bsoles?\b/i.test(gaps.get("condition")?.ask ?? "")) gaps.delete("condition"); // same question twice
  const ordered = [...gaps.values()].filter((g) => !args.answered.includes(g.check));
  if (soleGap) ordered.push(soleGap); // not dropped by `answered`: it clears only when new photos show the sole
  ordered.sort((a, b) => a.priority - b.priority);
  const top = ordered.slice(0, MAX_QUESTIONS);
  if (soleGap && !top.includes(soleGap)) top[top.length - 1] = soleGap; // always asked
  return top;
}

const BEFORE_YOU_PAY = [
  { id: "byp_protection", ask: "Pay through the platform's own checkout so buyer protection applies; avoid bank transfers.", fallback: "Pay through the platform's checkout so you keep buyer protection (avoid bank transfers or paying outside the app)." },
  { id: "byp_returns", ask: "Check the returns or dispute policy before paying.", fallback: "Check the platform's returns and dispute policy before you pay." },
  { id: "byp_save", ask: "Save the listing and screenshots in case it changes.", fallback: "Save the listing and your screenshots in case the listing changes later." },
];

export const BUY_NEW_MOVE_ID = "nm_buy_new";

/**
 * "Consider buying new": only when the price check found the listing costs as much as new (that needs 3+ retailers).
 * Fixed wording (prices must be exact); the panel shows the retailer offer cards under it.
 */
export function buyNewMove(checks: CheckResult[]): NextMove | null {
  const d = checks.find((c) => c.check === "price")?.details as Details;
  const offers = (d?.newOffers as { offers?: { priceGBP: number }[] } | undefined)?.offers ?? [];
  if (d?.position !== "at_or_above_new" || !offers.length) return null;
  const lowest = Math.min(...offers.map((o) => o.priceGBP));
  return {
    id: BUY_NEW_MOVE_ID,
    kind: "before_you_pay",
    text: `Consider buying new: ${offers.length} UK retailer${offers.length === 1 ? "" : "s"} sell this model new, from ${gbp(lowest)}.`,
    relatesTo: ["price"],
  };
}

const PhrasingWireSchema = z.object({
  questions: z.array(z.object({ gapId: z.string(), text: z.string() })).default([]),
  beforeYouPay: z.array(z.object({ id: z.string(), text: z.string() })).default([]),
});

const PHRASING_SYSTEM = `You write short, copy-ready messages for a buyer on a second-hand marketplace.
- Seller questions: polite, specific, friendly, never accusatory, one question each, ending with "?". Max 2 sentences.
- Before-you-pay items: one short practical sentence each.
Never use: scam, fake, fraud, liar, rip-off, guaranteed, counterfeit, replica, rep or reps. Return one item for every id given.`;

export async function generateNextMoves(
  gemini: GeminiClient | null,
  args: { checks: CheckResult[]; leads: Lead[]; label: VerdictLabel; answered?: CheckName[] },
): Promise<NextMove[]> {
  const gaps = computeGaps({ ...args, answered: args.answered ?? [] });
  const byp = args.label === "hidden_gem" || args.label === "worth_a_look" ? BEFORE_YOU_PAY : [];
  const buyNew = buyNewMove(args.checks);
  if (!gaps.length && !byp.length) return buyNew ? [buyNew] : [];

  let phrased: z.infer<typeof PhrasingWireSchema> = { questions: [], beforeYouPay: [] };
  if (gemini) {
    try {
      const { data } = await generateStructured(gemini, PhrasingWireSchema, {
        stage: "next_moves",
        tier: "fast",
        thinking: "LOW",
        system: PHRASING_SYSTEM,
        parts: [
          {
            text:
              `Seller questions to write (gapId: what to ask):\n${gaps.map((g) => `- ${g.id}: ${g.ask}`).join("\n") || "(none)"}\n` +
              `Before-you-pay items to write (id: point):\n${byp.map((b) => `- ${b.id}: ${b.ask}`).join("\n") || "(none)"}`,
          },
        ],
        temperature: 0.4,
      });
      phrased = data;
    } catch {
      /* templates below */
    }
  }

  const moves: NextMove[] = [];
  gaps.forEach((g, i) => {
    const candidate = g.exact ? undefined : phrased.questions.find((q) => q.gapId === g.id)?.text.trim();
    const text = candidate && validateNextMoveText(candidate, "ask_seller").length === 0 ? candidate : g.fallback;
    moves.push({ id: `nm_ask_${i + 1}`, kind: "ask_seller", text, relatesTo: [g.check] });
  });
  byp.forEach((b, i) => {
    const candidate = phrased.beforeYouPay.find((x) => x.id === b.id)?.text.trim();
    const text = candidate && validateNextMoveText(candidate, "before_you_pay").length === 0 ? candidate : b.fallback;
    moves.push({ id: `nm_pay_${i + 1}`, kind: "before_you_pay", text, relatesTo: [] });
  });
  if (buyNew) moves.push(buyNew);
  return moves;
}
