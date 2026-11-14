import fs from "node:fs";
import path from "node:path";
import { testConfig, type Config } from "@/lib/config";
import type { CacheMode } from "@/lib/cache";
import { createNewPriceClient, type RawShoppingResult } from "@/lib/newPrices";
import { MemoryStore } from "@/lib/store";
import { RateLimiter } from "@/lib/rateLimit";
import type { ReferenceData } from "@/lib/seedData";
import type { FetchedImage } from "@/lib/safeFetch";
import { createGeminiClient, type GenRequest, type GenResponse, type GroundingMeta } from "@/gemini/client";
import { EventHub, type SseEvent } from "@/pipeline/events";
import type { Deps } from "@/pipeline/deps";
import type { CheckResult, Profile } from "@/schemas/domain";

// 1x1 PNG
export const PNG = new Uint8Array(
  Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==", "base64"),
);

const nikeRows = [6, 6.5, 7, 7.5, 8, 8.5, 9, 9.5, 10, 10.5, 11, 11.5, 12].map((us, i) => ({
  uk: us - 1,
  us,
  eu: [38.5, 39, 40, 40.5, 41, 42, 42.5, 43, 44, 44.5, 45, 45.5, 46][i],
  cm: 24 + (us - 6),
}));
const adidasRows = [6, 6.5, 7, 7.5, 8, 8.5, 9, 9.5, 10].map((uk, i) => ({
  uk,
  us: uk + 0.5,
  eu: [39.33, 40, 40.67, 41.33, 42, 42.67, 43.33, 44, 44.67][i],
  cm: 24.5 + (uk - 6),
}));

/** Fixed reference data for tests (independent of /data, which the team will replace with real samples). */
export function fixtureReference(): ReferenceData {
  const pegasus = [30, 35, 38, 40, 42, 45, 48, 50, 52, 55, 58, 60, 400];
  return {
    catalogue: [
      { id: "nike-pegasus-40", brand: "Nike", name: "Pegasus 40", aliases: ["Air Zoom Pegasus 40"], retailGBP: 119.95, referenceImg: null, sizeChartId: "nike-mens" },
      { id: "nike-pegasus-41", brand: "Nike", name: "Pegasus 41", aliases: [], retailGBP: 124.99, referenceImg: null, sizeChartId: "nike-mens" },
      { id: "adidas-samba-og", brand: "Adidas", name: "Samba OG", aliases: ["Samba"], retailGBP: 100, referenceImg: null, sizeChartId: "adidas-mens" },
    ],
    sizeCharts: [
      { id: "nike-mens", brand: "Nike", rows: nikeRows },
      { id: "adidas-mens", brand: "Adidas", rows: adidasRows },
    ],
    priceSamples: pegasus.map((p, i) => ({
      modelId: "nike-pegasus-40",
      priceGBP: p,
      condition: (["like_new", "good", "worn"] as const)[i % 3],
      platform: "vinted" as const,
      collectedOn: `2026-11-${String(3 + (i % 8)).padStart(2, "0")}`,
      ruleId: "R-newest-N",
    })),
    reviews: [
      { modelId: "nike-pegasus-40", text: "Comfortable for long runs.", url: "https://www.runrepeat.com/nike-pegasus-40", title: "RunRepeat", sourceType: "independent_review", topics: ["positive:comfort", "sizing:true_to_size"] },
      { modelId: "nike-pegasus-40", text: "A reliable daily trainer.", url: "https://www.runnersworld.com/pegasus-40", title: "Runner's World", sourceType: "independent_review", topics: ["positive:durability"] },
    ],
  };
}

export const PROFILE: Profile = {
  sizes: [{ brand: "Nike", size: 9, system: "UK" }],
  priorities: ["all-day comfort"],
  wearTolerance: "light",
};

export const PAGE_TEXT = `Nike Air Zoom Pegasus 40 trainers
£38.00
Size: UK 9
Condition: Very good
Worn twice, no box.
Member since 2019
Seller: jane_doe_99
4.9 ★ (120 reviews)
You may also like: Nike Air Max 90 £60`;

export const json = (obj: unknown): GenResponse => ({ text: JSON.stringify(obj), functionCalls: [] });

/** Build grounded text + metadata: each line is supported by the given domains. */
export function grounded(lines: [string, string[]][], extra = ""): GenResponse {
  const domains = [...new Set(lines.flatMap(([, d]) => d))];
  const chunks = domains.map((d) => ({ web: { uri: `https://vertexaisearch.cloud.google.com/grounding-api-redirect/${d}`, title: d } }));
  const supports: NonNullable<GroundingMeta["groundingSupports"]> = lines
    .filter(([, d]) => d.length)
    .map(([line, d]) => ({ segment: { text: line }, groundingChunkIndices: d.map((x) => domains.indexOf(x)) }));
  return { text: lines.map(([l]) => l).join("\n") + (extra ? `\n${extra}` : ""), functionCalls: [], groundingMetadata: { groundingChunks: chunks, groundingSupports: supports } };
}

/**
 * Step 2 of the comfort search, as the model would do it for mock sentences written as
 * "PRIORITY | <priority> | <assessment> | <text>" or "SIZING | <advice> | <text>" (listed as "S1: ... (sources: ...)").
 */
export function mockComfortPoints(prompt: string) {
  const points: { segment: string; topic: string; assessment?: string; sizing?: string }[] = [];
  for (const line of prompt.split("\n")) {
    const p = /^(S\d+): PRIORITY \| (.+?) \| (positive|negative|mixed|unclear) \|/i.exec(line);
    if (p) points.push({ segment: p[1], topic: p[2], assessment: p[3].toLowerCase() });
    const z = /^(S\d+): SIZING \| (runs_small|runs_large|true_to_size|unclear) \|/i.exec(line);
    if (z) points.push({ segment: z[1], topic: "sizing", sizing: z[2].toLowerCase() });
  }
  return { points, sourceTypes: [] };
}

export type Handler = (req: GenRequest & { model: string }) => GenResponse | Promise<GenResponse>;

export function promptText(req: GenRequest): string {
  return req.contents.flatMap((c) => c.parts).map((p) => ("text" in p ? String(p.text) : "")).join("\n");
}

/** Recorded responses for a clean Nike Pegasus 40 listing. */
export function happyHandlers(): Record<string, Handler> {
  return {
    extract: () =>
      json({
        title: "Nike Air Zoom Pegasus 40 trainers",
        brandText: "Nike",
        modelText: "Air Zoom Pegasus 40",
        sizeText: "UK 9",
        sizeSystem: "UK",
        price: 38,
        currency: "GBP",
        conditionClaims: ["Very good", "Worn twice, no box."],
        evidence: [
          { field: "title", kind: "quote", quote: "Nike Air Zoom Pegasus 40 trainers" },
          { field: "size", kind: "quote", quote: "Size: UK 9" },
          { field: "price", kind: "quote", quote: "£38.00" },
          { field: "condition", kind: "quote", quote: "Condition: Very good" },
        ],
      }),
    needs: () => json({ extraPriorities: ["wide fit"], budgetGBP: null, wearTolerance: null, sizes: [] }),
    identify: () =>
      json({ catalogueModelId: "nike-pegasus-40", confidence: 0.92, reasons: "Title and swoosh/sole pattern match.", evidence: [{ kind: "quote", label: "Title names the model", quote: "Nike Air Zoom Pegasus 40" }] }),
    price: () => grounded([["PRICE | none | none", []]]),
    comfort: () =>
      grounded([
        ["Reviewers find it comfortable for long days.", ["runrepeat.com", "runnersworld.com"]],
        ["Most reviewers say it fits true to size.", ["runrepeat.com"]],
      ]),
    comfort_parse: (req) => {
      const text = promptText(req);
      const piped = mockComfortPoints(text);
      if (piped.points.length) return json(piped);
      const id = (sentence: string) => new RegExp(`^(S\\d+): ${sentence}`, "m").exec(text)?.[1];
      const points = [
        { segment: id("Reviewers find it comfortable"), topic: "all-day comfort", assessment: "positive" },
        { segment: id("Most reviewers say it fits true to size"), topic: "sizing", sizing: "true_to_size" },
      ].filter((p) => p.segment);
      return json({ points, sourceTypes: [] });
    },
    condition: () => json({ findings: [{ label: "upper_creasing", photoIndex: 0, box2d: [400, 300, 520, 600], severity: "minor", confidence: 0.8, note: "Light creasing at the toe box." }], notVisible: [], contradictions: [] }),
    leads: () => json({ leads: [] }),
    verdict: () =>
      json({
        headline: "A tidy pair at a tidy price.",
        explanation: "Compared with sampled listings this pair is priced below most. The fit matches your size and the photos show only light creasing.",
        citedEvidenceIds: ["ev_price_1", "ev_fit_1"],
      }),
    next_moves: () => json({ questions: [], beforeYouPay: [{ id: "byp_protection", text: "Pay through the platform checkout so buyer protection applies." }] }),
    reopen: () => json({ conditionStatements: [], answers: [], images: [] }),
  };
}

export type Recorded = { calls: GenRequest[]; shoppingRequests: string[] };

/** Saved SerpApi google_shopping results (tests/fixtures/shopping/<name>.json). */
export function shoppingFixture(name: string): RawShoppingResult[] {
  return JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "shopping", `${name}.json`), "utf8"));
}

/**
 * A real NewPriceClient whose network is a stub: responses come from `byQuery` (default: no results), every
 * request is recorded (query only; there is no key in tests), and nothing ever leaves the process.
 */
export function fakeNewPrices(byQuery: Record<string, RawShoppingResult[]> = {}, opts: { mode?: CacheMode; store?: MemoryStore; now?: () => Date } = {}) {
  const requests: string[] = [];
  const client = createNewPriceClient({
    apiKey: "test-key",
    mode: opts.mode ?? "off",
    store: opts.store ?? new MemoryStore(fixtureReference()),
    now: opts.now ?? (() => new Date("2026-11-14T12:00:00Z")),
    logger: () => undefined,
    retryBackoffMs: 1,
    fetch: async (url) => {
      const q = new URL(url).searchParams.get("q") ?? "";
      requests.push(q);
      return { ok: true, status: 200, json: async () => ({ shopping_results: byQuery[q] ?? [] }) };
    },
  });
  return { client, requests };
}

export function makeDeps(
  opts: { handlers?: Record<string, Handler>; config?: Partial<Config>; reference?: ReferenceData; images?: Record<string, Uint8Array>; shopping?: Record<string, RawShoppingResult[]> } = {},
): Deps & Recorded {
  const shopping = fakeNewPrices(opts.shopping);
  const handlers = { ...happyHandlers(), ...(opts.handlers ?? {}) };
  const calls: GenRequest[] = [];
  const config = testConfig(opts.config);
  const gemini = createGeminiClient({
    config,
    retryBackoffMs: 1,
    transport: async (req) => {
      calls.push(req);
      const h = handlers[req.stage];
      if (!h) throw new Error(`No mock for stage ${req.stage}`);
      const res = await h(req);
      // Extract and identify are one call now (examine.ts): the mock's identification comes from the identify handler.
      if (req.stage === "extract" && handlers.identify && !res.functionCalls.length) {
        try {
          const body = JSON.parse(res.text);
          if (body && typeof body === "object" && !("identification" in body)) {
            const id = await handlers.identify({ ...req, stage: "identify" });
            return { ...res, text: JSON.stringify({ ...body, identification: JSON.parse(id.text) }) };
          }
        } catch {
          /* not JSON: return as is */
        }
      }
      return res;
    },
  });
  const images = opts.images ?? { "https://img.example.com/1.jpg": PNG, "https://img.example.com/2.jpg": PNG };
  const fetchImage = async (url: string): Promise<FetchedImage> => {
    const bytes = images[url];
    if (!bytes) throw new Error("not found");
    // Different URLs must produce different content so de-dup doesn't merge them.
    const unique = new Uint8Array([...bytes, ...Buffer.from(url)]);
    return { bytes: unique, mimeType: "image/png", sourceUrl: url };
  };
  return {
    config,
    store: new MemoryStore(opts.reference ?? fixtureReference()),
    gemini,
    newPrices: shopping.client,
    shoppingRequests: shopping.requests,
    hub: new EventHub(),
    fetchImage,
    readReferenceImage: async () => null,
    limiter: { create: new RateLimiter(1000, 60_000), reopen: new RateLimiter(1000, 60_000) },
    now: () => new Date("2026-11-14T12:00:00Z"),
    calls,
  };
}

export function eventNames(events: SseEvent[]): string[] {
  return events.map((e) => e.event);
}

export function checksFrom(events: SseEvent[]): Record<string, CheckResult> {
  const out: Record<string, CheckResult> = {};
  for (const e of events) if (e.event === "check_done") out[(e.data as CheckResult).check] = e.data as CheckResult;
  return out;
}

export function check(partial: Partial<CheckResult> & Pick<CheckResult, "check" | "status">): CheckResult {
  return { summary: `${partial.check} ${partial.status}`, evidence: [{ id: `ev_${partial.check}_1`, kind: "data_point", label: partial.check }], confidence: 0.8, geminiFeatures: [], ...partial };
}
