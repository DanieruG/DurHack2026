import { z } from "zod";
import type { Content, GeminiClient, GenConfig, GenResponse, Part, ThinkingLevel, Tier } from "./client";
import { runToolLoop, type ToolExecutor } from "./tools";

export class StructuredOutputError extends Error {
  constructor(message: string, public readonly raw?: string) {
    super(message);
    this.name = "StructuredOutputError";
  }
}

/** Zod -> JSON Schema for Gemini's responseJsonSchema (drops keywords the API doesn't need). */
export function toGeminiSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { target: "draft-7", unrepresentable: "any", io: "output" }) as Record<string, unknown>;
  return strip(json) as Record<string, unknown>;
}

function strip(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strip);
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === "$schema" || k === "additionalProperties" || k === "$id") continue;
      out[k] = strip(v);
    }
    return out;
  }
  return node;
}

/** Pull the first JSON object/array out of model text (handles ```json fences and preamble). */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const candidate = fenced ? fenced[1].trim() : trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    /* fall through */
  }
  const start = candidate.search(/[[{]/);
  if (start === -1) throw new StructuredOutputError("No JSON found in model output", text);
  const open = candidate[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inStr = false;
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i];
    if (inStr) {
      if (ch === "\\") i++;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close && --depth === 0) {
      try {
        return JSON.parse(candidate.slice(start, i + 1));
      } catch {
        break;
      }
    }
  }
  throw new StructuredOutputError("Model output is not valid JSON", text);
}

export type StructuredArgs = {
  stage: string;
  tier: Tier;
  parts: Part[];
  system?: string;
  /** Built-in or function tools. With tools, the schema goes in the prompt and JSON is parsed from text. */
  tools?: Record<string, unknown>[];
  toolConfig?: Record<string, unknown>;
  executors?: Partial<Record<string, ToolExecutor>>;
  temperature?: number;
  thinking?: ThinkingLevel;
};

export type StructuredResult<T> = { data: T; response: GenResponse; calledFunctions: string[] };

/**
 * Ask Gemini for JSON matching a Zod schema. Uses the SDK's structured output config
 * (responseMimeType + responseJsonSchema). Invalid output -> one retry with the validation error
 * appended -> otherwise throws StructuredOutputError.
 */
export async function generateStructured<T>(
  gemini: GeminiClient,
  schema: z.ZodType<T>,
  args: StructuredArgs,
): Promise<StructuredResult<T>> {
  const jsonSchema = toGeminiSchema(schema);
  const withTools = !!args.tools?.length;
  const config: GenConfig = {
    systemInstruction: args.system,
    temperature: args.temperature ?? 0.2,
    ...(args.thinking ? { thinkingConfig: { thinkingLevel: args.thinking } } : {}),
    ...(withTools
      ? { tools: args.tools, toolConfig: args.toolConfig }
      : { responseMimeType: "application/json", responseJsonSchema: jsonSchema }),
  };
  const parts: Part[] = withTools
    ? [
        ...args.parts,
        { text: `\nReturn ONLY a JSON value (no prose) matching this JSON Schema:\n${JSON.stringify(jsonSchema)}` },
      ]
    : args.parts;

  let contents: Content[] = [{ role: "user", parts }];
  let lastError = "";
  let lastRaw = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const hasFunctions = withTools && args.tools!.some((t) => "functionDeclarations" in t);
    const { response, calledFunctions, contents: used } = hasFunctions
      ? await runToolLoop(gemini, { stage: args.stage, tier: args.tier, contents, config, executors: args.executors ?? {} })
      : { response: await gemini.generate({ stage: args.stage, tier: args.tier, contents, config }), calledFunctions: [], contents };

    lastRaw = response.text;
    try {
      const parsed = schema.safeParse(extractJson(response.text));
      if (parsed.success) return { data: parsed.data, response, calledFunctions };
      lastError = z.prettifyError(parsed.error);
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    contents = [
      ...used,
      { role: "model", parts: [{ text: response.text || "(empty)" }] },
      {
        role: "user",
        parts: [{ text: `Your previous output was invalid:\n${lastError}\nReturn corrected JSON only, matching the schema exactly.` }],
      },
    ];
  }
  throw new StructuredOutputError(`Invalid structured output after retry: ${lastError}`, lastRaw);
}
