import { ConditionGradeSchema, SizeSystemSchema } from "@/schemas/domain";
import { z } from "zod";
import { convertSize } from "@/lib/sizes";
import { sampleStats } from "@/lib/priceSample";
import { getCatalogueCandidates, MAX_CANDIDATES } from "@/lib/catalogue";
import type { ReferenceData } from "@/lib/seedData";
import type { NewPrices } from "@/lib/newPrices";
import type { Content, GeminiClient, GenConfig, GenResponse, Part, Tier } from "./client";

// ---------- declarations (spec 7.8) ----------

export const FUNCTION_DECLARATIONS = [
  {
    name: "convertSize",
    description:
      "Convert a trainer size between UK, US and EU (and foot length in cm) using the brand's own size chart. Exact lookup, not an estimate.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        brand: { type: "string", description: "Brand name, e.g. Nike" },
        size: { type: "number", description: "Size number, e.g. 9.5" },
        system: { type: "string", enum: ["UK", "US", "EU"] },
      },
      required: ["brand", "size", "system"],
    },
  },
  {
    name: "sampleStats",
    description:
      "Statistics (n, median, p10/p25/p75/p90, collection dates) over sampled second-hand listing prices for a catalogue model, optionally restricted to a condition grade.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        modelId: { type: "string", description: "Catalogue model id, e.g. nike-pegasus-40" },
        condition: { type: "string", enum: ConditionGradeSchema.options },
      },
      required: ["modelId"],
    },
  },
  {
    name: "getNewPrices",
    description:
      "Current NEW retail prices in GBP from UK retailers (Google Shopping), filtered to exactly this brand and model; second-hand marketplaces, other versions and accessories are excluded. Returns the kept offers, their median and lowest price, or available=false when fewer than 3 retailers match.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        brand: { type: "string", description: "Brand, e.g. adidas" },
        modelName: { type: "string", description: "Model name without the brand, e.g. Dropset 3" },
      },
      required: ["brand", "modelName"],
    },
  },
  {
    name: "getCatalogueCandidates",
    description: "Shortlist catalogue trainer models matching brand / model text. Returns ids and names.",
    parametersJsonSchema: {
      type: "object",
      properties: { brandText: { type: "string" }, modelText: { type: "string" } },
    },
  },
] as const;

export type ToolName = (typeof FUNCTION_DECLARATIONS)[number]["name"];

export function functionTool(names?: ToolName[]): Record<string, unknown> {
  return {
    functionDeclarations: FUNCTION_DECLARATIONS.filter((d) => !names || names.includes(d.name)),
  };
}

// ---------- local executors ----------

const ConvertArgs = z.object({ brand: z.string(), size: z.coerce.number(), system: SizeSystemSchema });
const StatsArgs = z.object({ modelId: z.string(), condition: ConditionGradeSchema.optional() });
const CandidateArgs = z.object({ brandText: z.string().optional(), modelText: z.string().optional() });

export type ToolExecutor = (args: Record<string, unknown>) => Record<string, unknown> | Promise<Record<string, unknown>>;

const NewPriceArgs = z.object({ brand: z.string().min(1), modelName: z.string().min(1) });

/** `newPrices` is the case's Shopping lookup (memoised per case, so a tool call and the price check share one request). */
export function makeToolExecutors(
  ref: ReferenceData,
  newPrices?: (modelName: string, brand: string) => Promise<NewPrices>,
): Record<ToolName, ToolExecutor> {
  return {
    async getNewPrices(args) {
      const a = NewPriceArgs.safeParse(args);
      if (!a.success) return { error: "invalid arguments" };
      if (!newPrices) return { error: "new prices are not available" };
      try {
        const r = await newPrices(a.data.modelName, a.data.brand);
        return r.available
          ? { available: true, medianGBP: r.medianGBP, lowestGBP: r.lowestGBP, checkedOn: r.checkedOn, offers: r.offers.map((o) => ({ retailer: o.retailer, priceGBP: o.priceGBP })) }
          : { available: false, reason: `only ${r.offers.length} UK retailer offer(s) matched; at least 3 are needed`, checkedOn: r.checkedOn };
      } catch {
        return { available: false, reason: "the price lookup failed" };
      }
    },
    convertSize(args) {
      const a = ConvertArgs.safeParse(args);
      if (!a.success) return { error: "invalid arguments" };
      const chart = ref.sizeCharts.find((c) => c.brand.toLowerCase() === a.data.brand.toLowerCase());
      if (!chart) return { error: `no size chart for brand ${a.data.brand}` };
      const row = convertSize(a.data.size, a.data.system, chart);
      return row ? { uk: row.uk, us: row.us, eu: row.eu, cm: row.cm, chartId: chart.id } : { error: "size not on chart" };
    },
    sampleStats(args) {
      const a = StatsArgs.safeParse(args);
      if (!a.success) return { error: "invalid arguments" };
      const stats = sampleStats(ref.priceSamples, a.data.modelId, a.data.condition);
      return stats ? { available: true, ...stats } : { available: false, reason: "fewer than 5 samples after outlier rule" };
    },
    getCatalogueCandidates(args) {
      const a = CandidateArgs.safeParse(args);
      if (!a.success) return { error: "invalid arguments" };
      const list = getCatalogueCandidates(a.data, ref.catalogue).slice(0, MAX_CANDIDATES);
      return { candidates: list.map((m) => ({ id: m.id, brand: m.brand, name: m.name })) };
    },
  };
}

// ---------- tool loop ----------

export type ToolLoopResult = { response: GenResponse; calledFunctions: string[]; contents: Content[] };

/**
 * Call Gemini with function tools; execute requested calls locally and feed results back
 * until the model answers in text (or maxSteps is reached, then force a text answer).
 */
export async function runToolLoop(
  gemini: GeminiClient,
  args: {
    stage: string;
    tier: Tier;
    contents: Content[];
    config: GenConfig;
    executors: Partial<Record<string, ToolExecutor>>;
    maxSteps?: number;
  },
): Promise<ToolLoopResult> {
  const contents = [...args.contents];
  const called: string[] = [];
  const maxSteps = args.maxSteps ?? 4;

  for (let step = 0; step <= maxSteps; step++) {
    const isLast = step === maxSteps;
    const config: GenConfig = isLast
      ? { ...args.config, toolConfig: { ...(args.config.toolConfig ?? {}), functionCallingConfig: { mode: "NONE" } } }
      : args.config;
    const res = await gemini.generate({ stage: args.stage, tier: args.tier, contents, config });
    if (!res.functionCalls.length || isLast) return { response: res, calledFunctions: called, contents };

    contents.push(
      res.modelContent ?? {
        role: "model",
        parts: res.functionCalls.map((c) => ({ functionCall: { id: c.id, name: c.name, args: c.args } }) as Part),
      },
    );
    const responses: Part[] = await Promise.all(res.functionCalls.map(async (c) => {
      const exec = args.executors[c.name];
      called.push(c.name);
      let response: Record<string, unknown>;
      try {
        response = exec ? await exec(c.args) : { error: `unknown function ${c.name}` };
      } catch (err) {
        response = { error: err instanceof Error ? err.message : "execution failed" };
      }
      return { functionResponse: { id: c.id, name: c.name, response } } as Part;
    }));
    contents.push({ role: "user", parts: responses });
  }
  /* c8 ignore next */
  throw new Error("unreachable");
}
