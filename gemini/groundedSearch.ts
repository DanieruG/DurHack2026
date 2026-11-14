import type { GeminiClient, GenConfig, GroundingMeta } from "./client";
import { groundingSources, type GroundedSource } from "./grounding";
import { functionTool, runToolLoop, type ToolExecutor, type ToolName } from "./tools";

/**
 * Google Search grounding, in two steps.
 *
 * Step 1 (this module): a grounded call that answers in plain prose. Gemini 3 drops groundingChunks/groundingSupports
 * when the grounded answer is forced into a rigid format (we saw 0 sources for "PRICE | x | £y" lines, and the
 * same happens with a JSON schema), but plain sentences come back with sources attached.
 * Step 2 (the caller): a separate call without tools turns the *supported* sentences into JSON. Every structured item
 * must point at a sentence, and it inherits only that sentence's sources, so attribution stays exact.
 */

/** One sentence of the grounded answer and the sources Google says support it. */
export type Segment = { id: string; text: string; sources: GroundedSource[] };

export type GroundedAnswer = {
  text: string;
  meta: GroundingMeta | undefined;
  sources: GroundedSource[];
  segments: Segment[];
  queries: string[];
  calledFunctions: string[];
};

/** Supported segments in answer order, each with its sources ("S1", "S2", ...). */
export function supportedSegments(meta: GroundingMeta | undefined, sources = groundingSources(meta)): Segment[] {
  const byChunk = new Map(sources.map((s) => [s.chunkIndex, s]));
  const out: Segment[] = [];
  const seen = new Map<string, Segment>();
  for (const sup of meta?.groundingSupports ?? []) {
    const text = sup.segment?.text?.trim();
    if (!text) continue;
    const srcs = (sup.groundingChunkIndices ?? []).map((i) => byChunk.get(i)).filter((s): s is GroundedSource => !!s);
    if (!srcs.length) continue;
    const existing = seen.get(text);
    if (existing) {
      for (const s of srcs) if (!existing.sources.includes(s)) existing.sources.push(s);
      continue;
    }
    const seg: Segment = { id: `S${out.length + 1}`, text, sources: srcs };
    seen.set(text, seg);
    out.push(seg);
  }
  return out;
}

/** "S1: ... (sources: nike.com, jdsports.co.uk)" lines for the structuring prompt. */
export function segmentList(segments: Segment[]): string {
  return segments.map((s) => `${s.id}: ${s.text} (sources: ${[...new Set(s.sources.map((x) => x.domain))].join(", ")})`).join("\n");
}

const normText = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Find the sentence a structured item points at: by id ("S3"), or by its exact text (models sometimes echo the text). */
export function resolveSegment(segments: Segment[], ref: string): Segment | undefined {
  const r = ref.trim();
  const byId = segments.find((s) => s.id === r.toUpperCase());
  if (byId) return byId;
  const n = normText(r.replace(/^S\d+:\s*/i, "").replace(/\s*\(sources:[^)]*\)\s*$/, ""));
  return n ? segments.find((s) => normText(s.text) === n) : undefined;
}

export class NoGroundingError extends Error {
  constructor(stage: string) {
    super(`${stage}: search returned no sources`);
    this.name = "NoGroundingError";
  }
}

/**
 * Run the grounded prose call; if Google returns no supported sentences, try once more (the model sometimes answers
 * from memory without citing). Throws NoGroundingError when there is still nothing to attribute.
 */
export async function groundedSearch(
  gemini: GeminiClient,
  args: {
    stage: string;
    prompt: string;
    temperature?: number;
    combinedTools: boolean;
    /** Function tools offered alongside Search when combinedTools is on. */
    functions?: ToolName[];
    executors: Partial<Record<string, ToolExecutor>>;
  },
): Promise<GroundedAnswer> {
  const contents = [{ role: "user" as const, parts: [{ text: args.prompt }] }];
  for (let attempt = 0; attempt < 2; attempt++) {
    const config: GenConfig = { temperature: args.temperature ?? 0, thinkingConfig: { thinkingLevel: "LOW" }, tools: [{ googleSearch: {} }] };
    let res;
    let calledFunctions: string[] = [];
    if (args.combinedTools && args.functions?.length) {
      const r = await runToolLoop(gemini, {
        stage: args.stage,
        tier: "fast",
        contents,
        config: { ...config, tools: [{ googleSearch: {} }, functionTool(args.functions)], toolConfig: { includeServerSideToolInvocations: true } },
        executors: args.executors,
      });
      res = r.response;
      calledFunctions = r.calledFunctions;
    } else {
      res = await gemini.generate({ stage: args.stage, tier: "fast", contents, config });
    }
    const sources = groundingSources(res.groundingMetadata);
    const segments = supportedSegments(res.groundingMetadata, sources);
    if (segments.length) {
      return { text: res.text, meta: res.groundingMetadata, sources, segments, queries: res.groundingMetadata?.webSearchQueries ?? [], calledFunctions };
    }
  }
  throw new NoGroundingError(args.stage);
}
