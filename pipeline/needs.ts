import { z } from "zod";
import { SizeSystemSchema, WearToleranceSchema, type Profile, type UserNeeds } from "@/schemas/domain";
import { generateStructured } from "@/gemini/structured";
import type { GeminiClient } from "@/gemini/client";

export const NoteWireSchema = z.object({
  extraPriorities: z.array(z.string()).default([]),
  budgetGBP: z.number().positive().nullish(),
  wearTolerance: WearToleranceSchema.nullish(),
  sizes: z
    .array(z.object({ brand: z.string(), size: z.number().positive(), system: SizeSystemSchema.nullish() }))
    .default([]),
});

const NOTE_SYSTEM = `You turn a shopper's short note about one purchase into structured needs.
- extraPriorities: short phrases for anything they care about (e.g. "wide fit", "for running a marathon").
- budgetGBP: only if the note states a budget for this purchase.
- wearTolerance: only if they say how much wear they accept (none, light, moderate, any).
- sizes: only sizes stated in the note. Leave anything not stated empty or null.`;

/** Profile -> UserNeeds. Missing size system -> assume UK (recorded in assumptions). Optional note parsed by Gemini. */
export async function buildNeeds(
  profile: Profile,
  caseNote: string | undefined,
  gemini: GeminiClient | null,
): Promise<UserNeeds> {
  const assumptions: string[] = [];
  const sizes = profile.sizes.map((s) => {
    if (!s.system) assumptions.push(`Size system not stated for your ${s.brand} size ${s.size}; assumed UK`);
    return { brand: s.brand, size: s.size, system: s.system ?? ("UK" as const) };
  });
  const needs: UserNeeds = {
    sizes,
    priorities: profile.priorities,
    budgetGBP: profile.budgetGBP,
    wearTolerance: profile.wearTolerance,
    caseNote,
    extraPriorities: [],
    assumptions,
  };
  if (!caseNote || !gemini) return needs;

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
      if (!s.system) assumptions.push(`Size system not stated in your note for ${s.brand} ${s.size}; assumed UK`);
      needs.sizes = [{ brand: s.brand, size: s.size, system }, ...needs.sizes.filter((x) => x.brand.toLowerCase() !== s.brand.toLowerCase())];
    }
  } catch {
    // The note is optional context; keep it verbatim as a priority rather than fail.
    needs.extraPriorities = [caseNote.slice(0, 80)];
  }
  return needs;
}

export function allPriorities(needs: UserNeeds): string[] {
  return [...new Set([...needs.priorities, ...needs.extraPriorities])];
}
