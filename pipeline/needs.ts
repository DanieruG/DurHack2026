import { z } from "zod";
import { SizeSystemSchema, WearToleranceSchema, type Profile, type UserNeeds } from "@/schemas/domain";
import { generateStructured } from "@/gemini/structured";
import type { GeminiClient } from "@/gemini/client";
import { colourWordsIn } from "@/lib/colourWords";

export const NoteWireSchema = z.object({
  extraPriorities: z.array(z.string()).default([]),
  budgetGBP: z.number().positive().nullish(),
  wearTolerance: WearToleranceSchema.nullish(),
  sizes: z
    .array(z.object({ brand: z.string().nullish(), size: z.number().positive(), system: SizeSystemSchema.nullish() }))
    .default([]),
});

const NOTE_SYSTEM = `You turn a shopper's short note about one purchase into structured needs.
- extraPriorities: short phrases for anything they care about (e.g. "wide fit", "for running a marathon"). Never put colours or looks here ("all white", "retro"): those are asked for separately.
- budgetGBP: only if the note states a budget for this purchase.
- wearTolerance: only if they say how much wear they accept (none, light, moderate, any).
- sizes: only sizes stated in the note; brand null when the note gives a size without a brand. Leave anything not stated empty or null.`;

const FILLER = /\b(and|or|no|not|without|only|all|any|just|plain|solid|colou?rs?|colou?rway|look|shoes?|trainers?|sneakers?|pair|please|a|the|in|with|nothing|too|very)\b/gi;

/**
 * A comfort priority that is really a colour wish ("black", "no bright colours", "all white"): made only of colour words and
 * filler. Such phrases are judged by the colour check, not against web reviews of comfort.
 */
export function isColourPhrase(p: string): boolean {
  if (!colourWordsIn(p).length && !/\b(bright|neon|loud|colou?rful|muted|neutral)\b/i.test(p)) return false;
  const rest = p
    .replace(FILLER, " ")
    .replace(/\b(bright|neon|loud|colou?rful|muted|neutral)\b/gi, " ")
    .split(/[^a-z]+/i)
    .filter((w) => w && !colourWordsIn(w).length);
  return rest.length === 0;
}

/** Move colour-only phrases out of the comfort priorities, into the colour wish. */
export function splitColourPriorities(args: { priorities: string[]; extraPriorities: string[]; colourWish?: string }): { priorities: string[]; extraPriorities: string[]; colourWish?: string } {
  const moved: string[] = [];
  const keep = (list: string[]) => list.filter((p) => (isColourPhrase(p) ? (moved.push(p), false) : true));
  const priorities = keep(args.priorities);
  const extraPriorities = keep(args.extraPriorities);
  const wish = [args.colourWish, ...moved].filter((x): x is string => !!x?.trim());
  const colourWish = [...new Set(wish.map((w) => w.trim()))].join("; ").slice(0, 100);
  return { priorities, extraPriorities, ...(colourWish ? { colourWish } : {}) };
}

/** Profile -> UserNeeds. Missing size system -> assume UK (recorded in assumptions). Optional note parsed by Gemini. */
export async function buildNeeds(
  profile: Profile,
  caseNote: string | undefined,
  gemini: GeminiClient | null,
  /** The buyer's colour or look requirement for this pair (its own box; never a comfort priority). */
  colourWish?: string,
): Promise<UserNeeds> {
  const assumptions: string[] = [];
  const sizes = profile.sizes.map((s) => {
    if (!s.system) assumptions.push(`Size system not stated for your ${s.brand} size ${s.size}; assumed UK`);
    return { brand: s.brand, size: s.size, system: s.system ?? ("UK" as const) };
  });
  const d = profile.defaultSize;
  if (d && !d.system) assumptions.push(`Size system not stated for your usual size ${d.size}; assumed UK`);
  const needs: UserNeeds = {
    sizes,
    ...(d ? { defaultSize: { size: d.size, system: d.system ?? ("UK" as const) } } : {}),
    priorities: profile.priorities,
    budgetGBP: profile.budgetGBP,
    wearTolerance: profile.wearTolerance,
    caseNote,
    ...(colourWish?.trim() ? { colourWish: colourWish.trim() } : {}),
    extraPriorities: [],
    assumptions,
  };
  const finish = (n: UserNeeds): UserNeeds => {
    const split = splitColourPriorities({ priorities: n.priorities, extraPriorities: n.extraPriorities, colourWish: n.colourWish });
    return { ...n, priorities: split.priorities, extraPriorities: split.extraPriorities, ...(split.colourWish ? { colourWish: split.colourWish } : {}) };
  };
  if (!caseNote || !gemini) return finish(needs);

  try {
    const { data } = await generateStructured(gemini, NoteWireSchema, {
      stage: "needs",
      tier: "fast",
      system: NOTE_SYSTEM,
      parts: [{ text: `Note: """${caseNote}"""` }],
    });
    needs.extraPriorities = data.extraPriorities.map((p) => p.trim()).filter(Boolean).slice(0, 6);
    if (data.budgetGBP) {
      needs.budgetGBP = data.budgetGBP;
      assumptions.push(`Budget for this purchase taken from your note: £${data.budgetGBP}`);
    }
    if (data.wearTolerance) needs.wearTolerance = data.wearTolerance;
    for (const s of data.sizes) {
      const system = s.system ?? "UK";
      const brand = s.brand?.trim();
      if (!s.system) assumptions.push(`Size system not stated in your note for ${brand ? `${brand} ` : ""}${s.size}; assumed UK`);
      if (brand) needs.sizes = [{ brand, size: s.size, system }, ...needs.sizes.filter((x) => x.brand.toLowerCase() !== brand.toLowerCase())];
      else needs.defaultSize = { size: s.size, system };
    }
  } catch {
    // The note is optional context; keep it verbatim as a priority rather than fail.
    needs.extraPriorities = [caseNote.slice(0, 80)];
  }
  return finish(needs);
}

export function allPriorities(needs: UserNeeds): string[] {
  return [...new Set([...needs.priorities, ...needs.extraPriorities])];
}
