import type { SizeSystem, UserNeeds } from "@/schemas/domain";

/**
 * Which of the user's saved sizes applies to a brand: their size for that brand, else their usual size (not tied to any
 * brand). Null when neither is saved; callers may then estimate from another brand's size by foot length.
 */
export type SavedSize = { size: number; system: SizeSystem; brand: string | null };

export const sameBrand = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

export function savedSizeFor(needs: Pick<UserNeeds, "sizes" | "defaultSize">, brand: string | null): SavedSize | null {
  const own = brand ? needs.sizes.find((s) => sameBrand(s.brand, brand)) : undefined;
  if (own) return own;
  return needs.defaultSize ? { ...needs.defaultSize, brand: null } : null;
}

export const hasAnySize = (needs: Pick<UserNeeds, "sizes" | "defaultSize">) => needs.sizes.length > 0 || !!needs.defaultSize;

/** "Your saved Nike size" / "Your usual size". */
export const savedSizeName = (s: SavedSize) => (s.brand ? `Your saved ${s.brand} size` : "Your usual size");
