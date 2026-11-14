import { AsyncLocalStorage } from "node:async_hooks";
import type { Config } from "@/lib/config";
import { ResponseCache, replayDelayMs } from "@/lib/cache";

// ---------- request / response types (SDK-shaped, minimal) ----------

export type Tier = "fast" | "strong";

export type InlineDataPart = { inlineData: { mimeType: string; data: string } };
export type TextPart = { text: string };
export type FunctionCallPart = { functionCall: { id?: string; name: string; args?: Record<string, unknown> } };
export type FunctionResponsePart = {
  functionResponse: { id?: string; name: string; response: Record<string, unknown> };
};
// Model turns may carry extra fields (e.g. thoughtSignature) that must be sent back verbatim.
export type Part = (TextPart | InlineDataPart | FunctionCallPart | FunctionResponsePart) & Record<string, unknown>;
export type Content = { role: "user" | "model"; parts: Part[] };

export type GenConfig = {
  systemInstruction?: string;
  responseMimeType?: string;
  responseJsonSchema?: unknown;
  tools?: Record<string, unknown>[];
  toolConfig?: Record<string, unknown>;
  temperature?: number;
};

export type GenRequest = { stage: string; tier: Tier; contents: Content[]; config?: GenConfig };

export type GroundingMeta = {
  groundingChunks?: { web?: { uri?: string; title?: string; domain?: string } }[];
  groundingSupports?: {
    segment?: { startIndex?: number; endIndex?: number; text?: string; partIndex?: number };
    groundingChunkIndices?: number[];
    confidenceScores?: number[];
  }[];
  webSearchQueries?: string[];
};

export type GenResponse = {
  text: string;
  functionCalls: { id?: string; name: string; args: Record<string, unknown> }[];
  /** The full model turn, for multi-turn tool use (keeps thought signatures). */
  modelContent?: Content;
  groundingMetadata?: GroundingMeta;
  usage?: { promptTokens?: number; outputTokens?: number; totalTokens?: number };
};

/** Lowest layer: actually talks to Gemini (or a mock in tests). */
export type GeminiTransport = (req: GenRequest & { model: string; abortSignal?: AbortSignal }) => Promise<GenResponse>;

export interface GeminiClient {
  generate(req: GenRequest): Promise<GenResponse & { model: string; cached: boolean }>;
}

export class GeminiError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = "GeminiError";
  }
}

// ---------- call context & log ----------

export type CallLogEntry = {
  caseId?: string;
  stage: string;
  model: string;
  latencyMs: number;
  cached: boolean;
  ok: boolean;
  promptTokens?: number;
  outputTokens?: number;
};

type CallContext = { caseId?: string; stage?: string; log: CallLogEntry[]; signal?: AbortSignal };

const callContext = new AsyncLocalStorage<CallContext>();

/** Run fn with a per-investigation call log; every Gemini call inside is recorded there. */
export function withCallLog<T>(caseId: string, fn: () => Promise<T>): { log: CallLogEntry[]; run: Promise<T> } {
  const ctx: CallContext = { caseId, log: [] };
  return { log: ctx.log, run: callContext.run(ctx, fn) };
}

/** Set the current stage (for logging) and an abort signal (for stage timeouts) for nested calls. */
export function withStageContext<T>(stage: string, signal: AbortSignal | undefined, fn: () => Promise<T>): Promise<T> {
  const parent = callContext.getStore();
  const ctx: CallContext = { caseId: parent?.caseId, stage, log: parent?.log ?? [], signal };
  return callContext.run(ctx, fn);
}

// ---------- client ----------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function isRetryable(err: unknown): boolean {
  const status = (err as { status?: number }).status;
  return status === 429 || (typeof status === "number" && status >= 500);
}

export function resolveModel(config: Pick<Config, "models">, tier: Tier): string {
  const model = tier === "strong" ? config.models.strong : config.models.fast;
  if (!model) {
    throw new GeminiError(`Gemini model for tier "${tier}" is not configured (set GEMINI_MODEL_${tier.toUpperCase()})`);
  }
  return model;
}

export function createGeminiClient(opts: {
  config: Pick<Config, "models" | "pipelineVersion">;
  transport: GeminiTransport;
  cache?: ResponseCache;
  retryBackoffMs?: number;
  logger?: (e: CallLogEntry) => void;
}): GeminiClient {
  const backoff = opts.retryBackoffMs ?? 1200;
  const logger = opts.logger ?? defaultLogger;

  return {
    async generate(req) {
      const ctx = callContext.getStore();
      let model: string;
      try {
        model = resolveModel(opts.config, req.tier);
      } catch (err) {
        warnOnce(`[gemini] ${(err as Error).message}`);
        throw err;
      }
      const started = Date.now();
      const key = opts.cache?.enabled
        ? ResponseCache.key({ stage: req.stage, model, input: { contents: req.contents, config: req.config }, pipelineVersion: opts.config.pipelineVersion })
        : null;

      const record = (ok: boolean, cached: boolean, res?: GenResponse) => {
        const entry: CallLogEntry = {
          caseId: ctx?.caseId,
          stage: ctx?.stage ?? req.stage,
          model,
          latencyMs: Date.now() - started,
          cached,
          ok,
          promptTokens: res?.usage?.promptTokens,
          outputTokens: res?.usage?.outputTokens,
        };
        ctx?.log.push(entry);
        logger(entry);
      };

      if (key && opts.cache) {
        const hit = await opts.cache.get<GenResponse>("gemini", key);
        if (hit) {
          if (opts.cache.replaying) await sleep(replayDelayMs(key));
          record(true, true, hit);
          return { ...hit, model, cached: true };
        }
      }

      let res: GenResponse;
      try {
        try {
          res = await opts.transport({ ...req, model, abortSignal: ctx?.signal });
        } catch (err) {
          if (!isRetryable(err) || ctx?.signal?.aborted) throw err;
          await sleep(backoff + Math.floor(Math.random() * 400));
          res = await opts.transport({ ...req, model, abortSignal: ctx?.signal });
        }
      } catch (err) {
        record(false, false);
        if (!process.env.VITEST) console.warn(`[gemini] stage=${req.stage} model=${model} failed: ${err instanceof Error ? err.message : String(err)}`);
        throw err;
      }
      record(true, false, res);
      if (key && opts.cache) await opts.cache.set("gemini", key, res);
      return { ...res, model, cached: false };
    },
  };
}

const warned = new Set<string>();
function warnOnce(msg: string) {
  if (warned.has(msg) || process.env.VITEST) return;
  warned.add(msg);
  console.warn(msg);
}

function defaultLogger(e: CallLogEntry) {
  if (process.env.NODE_ENV === "test" || process.env.VITEST) return;
  console.info(
    `[gemini] case=${e.caseId ?? "-"} stage=${e.stage} model=${e.model} ${e.latencyMs}ms` +
      `${e.cached ? " (cache)" : ""}${e.ok ? "" : " FAILED"}` +
      (e.promptTokens !== undefined ? ` tokens=${e.promptTokens}/${e.outputTokens ?? 0}` : ""),
  );
}

// ---------- live transport (official @google/genai SDK) ----------

export function createLiveTransport(apiKey: string | undefined): GeminiTransport {
  let ai: import("@google/genai").GoogleGenAI | null = null;
  return async (req) => {
    if (!apiKey) throw new GeminiError("GEMINI_API_KEY is not set");
    if (!ai) {
      const { GoogleGenAI } = await import("@google/genai");
      ai = new GoogleGenAI({ apiKey });
    }
    try {
      const res = await ai.models.generateContent({
        model: req.model,
        contents: req.contents as never,
        config: { ...(req.config as Record<string, unknown>), abortSignal: req.abortSignal } as never,
      });
      const cand = res.candidates?.[0];
      const textParts = (cand?.content?.parts ?? []).filter((p) => typeof p.text === "string" && !p.thought);
      return {
        text: textParts.map((p) => p.text).join(""),
        functionCalls: (res.functionCalls ?? []).map((c) => ({ id: c.id, name: c.name ?? "", args: (c.args ?? {}) as Record<string, unknown> })),
        modelContent: cand?.content ? ({ role: "model", parts: cand.content.parts ?? [] } as unknown as Content) : undefined,
        groundingMetadata: cand?.groundingMetadata as GroundingMeta | undefined,
        usage: {
          promptTokens: res.usageMetadata?.promptTokenCount,
          outputTokens: res.usageMetadata?.candidatesTokenCount,
          totalTokens: res.usageMetadata?.totalTokenCount,
        },
      };
    } catch (err) {
      const status = (err as { status?: number }).status;
      throw new GeminiError(err instanceof Error ? err.message : String(err), status);
    }
  };
}

// ---------- helpers ----------

export function imagePart(img: { bytes: Uint8Array; mimeType: string }): InlineDataPart {
  return { inlineData: { mimeType: img.mimeType, data: Buffer.from(img.bytes).toString("base64") } };
}

export function userContent(parts: Part[]): Content {
  return { role: "user", parts };
}
