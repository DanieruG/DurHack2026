import { z } from "zod";

const bool = z
  .string()
  .optional()
  .transform((v) => v === "true" || v === "1");

const csv = z
  .string()
  .optional()
  .transform((v) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean));

const EnvSchema = z.object({
  DATABASE_URL: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL_FAST: z.string().optional(),
  GEMINI_MODEL_STRONG: z.string().optional(),
  GEMINI_COMBINED_TOOLS: bool,
  IDENTIFY_CONFIDENCE_MIN: z.coerce.number().min(0).max(1).default(0.75),
  MAX_LEADS: z.coerce.number().int().min(0).max(5).default(2),
  STAGE_TIMEOUT_MS: z.coerce.number().int().positive().default(25_000),
  SEARCH_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  MAX_IMAGES: z.coerce.number().int().positive().max(20).default(8),
  MAX_IMAGE_BYTES: z.coerce.number().int().positive().default(8_000_000),
  PIPELINE_VERSION: z.string().default("2"),
  CACHE_MODE: z.enum(["off", "record", "replay"]).default("off"),
  ALLOWED_EXTENSION_ORIGINS: csv,
  ALLOWED_WEB_ORIGINS: csv,
});

export type Config = {
  databaseUrl?: string;
  geminiApiKey?: string;
  /** Model names come from env only; never hard-coded. */
  models: { fast?: string; strong?: string };
  combinedTools: boolean;
  identifyConfidenceMin: number;
  maxLeads: number;
  stageTimeoutMs: number;
  /** Cap on each Google Search grounded step (price new-price lookup, comfort reviews); past it, saved data is used. */
  searchTimeoutMs: number;
  maxImages: number;
  maxImageBytes: number;
  pipelineVersion: string;
  cacheMode: "off" | "record" | "replay";
  allowedOrigins: string[];
};

const blank = (v: string | undefined) => (v && v.trim() ? v.trim() : undefined);

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const cleaned = Object.fromEntries(Object.entries(env).map(([k, v]) => [k, v === "" ? undefined : v]));
  const e = EnvSchema.parse(cleaned);
  return {
    databaseUrl: blank(e.DATABASE_URL),
    geminiApiKey: blank(e.GEMINI_API_KEY),
    models: { fast: blank(e.GEMINI_MODEL_FAST), strong: blank(e.GEMINI_MODEL_STRONG) },
    combinedTools: e.GEMINI_COMBINED_TOOLS,
    identifyConfidenceMin: e.IDENTIFY_CONFIDENCE_MIN,
    maxLeads: e.MAX_LEADS,
    stageTimeoutMs: e.STAGE_TIMEOUT_MS,
    searchTimeoutMs: e.SEARCH_TIMEOUT_MS,
    maxImages: e.MAX_IMAGES,
    maxImageBytes: e.MAX_IMAGE_BYTES,
    pipelineVersion: e.PIPELINE_VERSION,
    cacheMode: e.CACHE_MODE,
    allowedOrigins: [...e.ALLOWED_EXTENSION_ORIGINS, ...e.ALLOWED_WEB_ORIGINS],
  };
}

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    models: { fast: "test-fast", strong: "test-strong" },
    combinedTools: false,
    identifyConfidenceMin: 0.75,
    maxLeads: 2,
    stageTimeoutMs: 2000,
    searchTimeoutMs: 1000,
    maxImages: 8,
    maxImageBytes: 8_000_000,
    pipelineVersion: "test",
    cacheMode: "off",
    allowedOrigins: ["chrome-extension://testextensionid"],
    ...overrides,
  };
}
