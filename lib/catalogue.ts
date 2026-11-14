import type { CatalogueModel } from "@/schemas/seed";

export const MAX_CANDIDATES = 5;

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/**
 * Shortlist catalogue models by brand and alias text match.
 * If nothing matches, return the whole catalogue (spec 7.5: 15-20 models).
 */
export function getCatalogueCandidates(
  input: { brandText?: string; modelText?: string; title?: string },
  catalogue: CatalogueModel[],
): CatalogueModel[] {
  const hay = norm([input.brandText, input.modelText, input.title].filter(Boolean).join(" "));
  if (!hay) return catalogue;
  const padded = ` ${hay} `;

  const scored = catalogue
    .map((m) => {
      let score = 0;
      if (padded.includes(` ${norm(m.brand)} `)) score += 1;
      const names = [m.name, ...m.aliases].map(norm).filter(Boolean);
      for (const n of names) {
        if (padded.includes(` ${n} `)) score = Math.max(score, 1) + n.split(" ").length * 2;
      }
      // Partial model-number match, e.g. "pegasus 40" vs "pegasus"
      const tokens = norm(m.name).split(" ").filter((t) => t.length > 2 || /\d/.test(t));
      const hits = tokens.filter((t) => padded.includes(` ${t} `)).length;
      score += hits * 0.5;
      return { m, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) return catalogue;
  return scored.map((x) => x.m);
}
