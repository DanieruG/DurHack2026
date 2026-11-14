import { z } from "zod";
import {
  ConditionGradeSchema,
  EvidenceSourceTypeSchema,
  PlatformSchema,
  SizeSystemSchema,
} from "./domain";

export const SizeRowSchema = z.object({
  uk: z.number(),
  us: z.number(),
  eu: z.number(),
  cm: z.number(),
});
export type SizeRow = z.infer<typeof SizeRowSchema>;

export const SizeChartSchema = z.object({
  id: z.string().min(1),
  brand: z.string().min(1),
  rows: z.array(SizeRowSchema).min(2),
});
export type SizeChart = z.infer<typeof SizeChartSchema>;

/**
 * How listing titles name this model (lib/titleMatch.ts): family words, an optional version token, and extra exclusion
 * words for look-alike models (the shared exclusions always apply). The brand comes from the entry's brand.
 */
export const MatchTokensSchema = z.object({
  family: z.array(z.string().regex(/^[a-z0-9]+$/)).min(1),
  version: z.string().regex(/^[a-z0-9]+$/).nullable().default(null),
  exclude: z.array(z.string().regex(/^[a-z0-9]+$/)).default([]),
});
export type MatchTokens = z.infer<typeof MatchTokensSchema>;

export const CatalogueModelSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  brand: z.string().min(1),
  name: z.string().min(1),
  aliases: z.array(z.string()),
  retailGBP: z.number().positive().nullable().optional(),
  referenceImg: z.string().nullable().optional(),
  sizeChartId: z.string().min(1),
  matchTokens: MatchTokensSchema.nullable().optional(),
});
export type CatalogueModel = z.infer<typeof CatalogueModelSchema>;

export const PriceSampleSchema = z.object({
  modelId: z.string(),
  priceGBP: z.number().positive(),
  condition: ConditionGradeSchema,
  platform: PlatformSchema,
  collectedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}/),
  ruleId: z.string().min(1),
});
export type PriceSample = z.infer<typeof PriceSampleSchema>;

export const ReviewSnippetSchema = z.object({
  modelId: z.string(),
  text: z.string().min(1),
  url: z.string().url(),
  title: z.string(),
  sourceType: EvidenceSourceTypeSchema,
  topics: z.array(z.string()),
});
export type ReviewSnippet = z.infer<typeof ReviewSnippetSchema>;

/** Public feed item (API response). */
export const FeedItemSchema = z.object({
  caseId: z.string(),
  modelName: z.string(),
  priceGBP: z.number(),
  platform: PlatformSchema,
  verdictLabel: z.literal("hidden_gem"),
  oneLineEvidence: z.string(),
  priceSource: z.string(),
  checkedAt: z.string(),
});
export type FeedItem = z.infer<typeof FeedItemSchema>;

/** Seed row in data/feed.json: a FeedItem plus what the size filter needs (stripped from responses). */
export const FeedSeedItemSchema = FeedItemSchema.extend({
  modelId: z.string(),
  size: z.object({ value: z.number(), system: SizeSystemSchema }),
});
export type FeedSeedItem = z.infer<typeof FeedSeedItemSchema>;
