import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  CatalogueModelSchema,
  FeedSeedItemSchema,
  PriceSampleSchema,
  ReviewSnippetSchema,
  SizeChartSchema,
  type CatalogueModel,
  type FeedSeedItem,
  type PriceSample,
  type ReviewSnippet,
  type SizeChart,
} from "@/schemas/seed";

export type ReferenceData = {
  catalogue: CatalogueModel[];
  sizeCharts: SizeChart[];
  priceSamples: PriceSample[];
  reviews: ReviewSnippet[];
};

export type SeedFiles = ReferenceData & { feed: FeedSeedItem[] };

export const DATA_DIR = path.join(process.cwd(), "data");

function readJson<T>(dir: string, file: string, schema: z.ZodType<T>): T {
  const full = path.join(dir, file);
  const raw = JSON.parse(fs.readFileSync(full, "utf8"));
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid seed file ${file}:\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}

/** Load and Zod-validate every seed file; also checks cross-references. Throws loudly on invalid data. */
export function loadSeedFiles(dir = DATA_DIR): SeedFiles {
  const catalogue = readJson(dir, "catalogue.json", z.array(CatalogueModelSchema));
  const sizeCharts = readJson(dir, "sizecharts.json", z.array(SizeChartSchema));
  const priceSamples = readJson(dir, "price-samples.json", z.array(PriceSampleSchema));
  const reviews = readJson(dir, "reviews.json", z.array(ReviewSnippetSchema));
  const feed = readJson(dir, "feed.json", z.array(FeedSeedItemSchema));

  const chartIds = new Set(sizeCharts.map((c) => c.id));
  const modelIds = new Set(catalogue.map((m) => m.id));
  const problems: string[] = [];
  if (modelIds.size !== catalogue.length) problems.push("catalogue.json has duplicate ids");
  if (chartIds.size !== sizeCharts.length) problems.push("sizecharts.json has duplicate ids");
  for (const m of catalogue) if (!chartIds.has(m.sizeChartId)) problems.push(`${m.id}: unknown sizeChartId ${m.sizeChartId}`);
  for (const s of priceSamples) if (!modelIds.has(s.modelId)) problems.push(`price sample for unknown model ${s.modelId}`);
  for (const r of reviews) if (!modelIds.has(r.modelId)) problems.push(`review for unknown model ${r.modelId}`);
  for (const f of feed) if (!modelIds.has(f.modelId)) problems.push(`feed item ${f.caseId}: unknown model ${f.modelId}`);
  for (const c of sizeCharts) {
    for (let i = 1; i < c.rows.length; i++) {
      if (c.rows[i].cm <= c.rows[i - 1].cm) problems.push(`${c.id}: rows must be sorted by cm ascending`);
    }
  }
  if (problems.length) throw new Error(`Seed data cross-reference errors:\n- ${problems.join("\n- ")}`);
  return { catalogue, sizeCharts, priceSamples, reviews, feed };
}
