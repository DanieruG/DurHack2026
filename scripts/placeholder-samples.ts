/**
 * Generates PLACEHOLDER price samples so the pipeline runs end-to-end before the team has collected real ones.
 * Every row gets ruleId "SYNTHETIC-placeholder", which the price check surfaces in its evidence label
 * ("... (placeholder data, not real listings)"). Replace data/price-samples.json with real samples collected under
 * rule R-newest-N (see data/sampling-rules.md) before any demo or pitch numbers are shown.
 *
 *   npx tsx scripts/placeholder-samples.ts
 */
import fs from "node:fs";
import path from "node:path";

const catalogue = JSON.parse(fs.readFileSync(path.join("data", "catalogue.json"), "utf8")) as { id: string; retailGBP: number }[];
const platforms = ["vinted", "ebay", "depop", "facebook"] as const;
const grades = [
  { condition: "new_with_tags", factor: 0.78 },
  { condition: "like_new", factor: 0.6 },
  { condition: "good", factor: 0.45 },
  { condition: "worn", factor: 0.3 },
] as const;

// Deterministic PRNG (mulberry32) so the file is reproducible.
function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rows: object[] = [];
catalogue.forEach((m, mi) => {
  const rand = rng(1000 + mi);
  const n = 12 + Math.floor(rand() * 4);
  for (let i = 0; i < n; i++) {
    const g = grades[Math.floor(rand() * grades.length)];
    const noise = 0.85 + rand() * 0.3;
    rows.push({
      modelId: m.id,
      priceGBP: Math.round(m.retailGBP * g.factor * noise),
      condition: g.condition,
      platform: platforms[i % platforms.length],
      collectedOn: `2026-11-${String(3 + Math.floor(rand() * 8)).padStart(2, "0")}`,
      ruleId: "SYNTHETIC-placeholder",
    });
  }
});
fs.writeFileSync(path.join("data", "price-samples.json"), JSON.stringify(rows, null, 1));
console.log(`Wrote ${rows.length} placeholder samples for ${catalogue.length} models.`);
