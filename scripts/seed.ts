/**
 * Seed reference data from /data into Neon (idempotent upserts; validates every file with Zod and fails loudly).
 *   npm run seed
 */
import "../lib/loadEnv";
import { hashObject } from "../lib/hash";
import { loadSeedFiles } from "../lib/seedData";

async function main() {
  const seed = loadSeedFiles(); // throws with a readable report on invalid data
  console.log(
    `Validated: ${seed.catalogue.length} models, ${seed.sizeCharts.length} size charts, ${seed.priceSamples.length} price samples, ` +
      `${seed.reviews.length} review snippets, ${seed.feed.length} feed items.`,
  );
  const placeholders = seed.priceSamples.filter((s) => s.ruleId.startsWith("SYNTHETIC")).length;
  if (placeholders) {
    console.warn(
      `\n⚠  ${placeholders} price samples are PLACEHOLDER data (ruleId SYNTHETIC-*). Price evidence will say so.\n` +
        `   Replace data/price-samples.json with real R-newest-N samples (data/sampling-rules.md) before a demo.\n`,
    );
  }

  const { getDb } = await import("../lib/db");
  const db = getDb();

  for (const c of seed.sizeCharts) {
    await db.sizeChart.upsert({ where: { id: c.id }, create: c, update: { brand: c.brand, rows: c.rows } });
  }
  for (const m of seed.catalogue) {
    const data = { brand: m.brand, name: m.name, aliases: m.aliases, retailGBP: m.retailGBP ?? null, referenceImg: m.referenceImg ?? null, sizeChartId: m.sizeChartId };
    await db.catalogueModel.upsert({ where: { id: m.id }, create: { id: m.id, ...data }, update: data });
  }

  // Price samples and review snippets have no natural key: derive a deterministic id from content + occurrence,
  // upsert, then remove rows no longer in the file, so the table always mirrors data/*.json.
  const occurrences = new Map<string, number>();
  const sampleRows = seed.priceSamples.map((s) => {
    const base = hashObject(s).slice(0, 20);
    const n = (occurrences.get(base) ?? 0) + 1;
    occurrences.set(base, n);
    return { id: `ps_${base}_${n}`, ...s, collectedOn: new Date(`${s.collectedOn.slice(0, 10)}T00:00:00Z`) };
  });
  // Content-derived ids make createMany + skipDuplicates an idempotent upsert (one round trip).
  await db.priceSample.deleteMany({ where: { id: { notIn: sampleRows.map((r) => r.id) } } });
  await db.priceSample.createMany({ data: sampleRows, skipDuplicates: true });

  const reviewRows = seed.reviews.map((r, i) => ({ id: `rs_${hashObject(r).slice(0, 20)}_${i}`, ...r }));
  await db.reviewSnippet.deleteMany({ where: { id: { notIn: reviewRows.map((r) => r.id) } } });
  if (reviewRows.length) await db.reviewSnippet.createMany({ data: reviewRows, skipDuplicates: true });

  // Catalogue models / charts removed from the files are removed from the database too.
  await db.catalogueModel.deleteMany({ where: { id: { notIn: seed.catalogue.map((m) => m.id) } } });
  await db.sizeChart.deleteMany({ where: { id: { notIn: seed.sizeCharts.map((c) => c.id) } } });

  const counts = await Promise.all([db.catalogueModel.count(), db.sizeChart.count(), db.priceSample.count(), db.reviewSnippet.count()]);
  console.log(`Seeded: ${counts[0]} models, ${counts[1]} size charts, ${counts[2]} price samples, ${counts[3]} review snippets.`);
  await db.$disconnect();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
