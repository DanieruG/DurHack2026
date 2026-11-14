/**
 * Fill ReviewSnippet rows (the comfort check's fallback) for catalogue models that have none.
 *
 *   npm run seed:reviews              # search, write data/reviews.json, sync the ReviewSnippet table
 *   npm run seed:reviews -- --no-db   # only write data/reviews.json (then `npm run seed`)
 *
 * For each model without rows it runs the comfort check's own SerpApi search once ("{brand} {model} review comfort",
 * UK, top 6 organic results) and stores each result as a snippet: title, real URL, snippet text, source type and topics.
 * - SerpApi links through Google redirects; each is resolved by reading the 302's Location header (the page is never
 *   fetched) and kept only if it lands on the site SerpApi displayed.
 * - Source type is classified as in the live check: domain lists first, and Gemini's reading of the title and snippet
 *   only for domains the lists don't know (one Flash call per model).
 *
 * Every SerpApi response, resolved link and classification is kept in data/review-searches.json, so rerunning uses no new
 * searches. Rows for models in that file are rebuilt from it on every run (picking up any link that resolves later);
 * other rows in data/reviews.json are never touched. data/reviews.json stays the source of truth for `npm run seed`.
 */
import "../lib/loadEnv";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { loadConfig } from "../lib/config";
import { loadSeedFiles, DATA_DIR } from "../lib/seedData";
import { comfortQuery, createWebSearchClient, type WebResult } from "../lib/webSearch";
import { independentSites, resolvedMatches, reviewRows, snippetsFromResults } from "../lib/reviewSnippets";
import { createGeminiClient, createLiveTransport } from "../gemini/client";
import { generateStructured } from "../gemini/structured";
import type { EvidenceSourceType } from "../schemas/domain";
import type { ReviewSnippet } from "../schemas/seed";

const CACHE_FILE = path.join(DATA_DIR, "review-searches.json");
const REVIEWS_FILE = path.join(DATA_DIR, "reviews.json");

type CacheEntry = {
  modelId: string;
  fetchedAt: string;
  results: WebResult[];
  /** Redirect link -> real URL (only ones that match the displayed site are used). */
  resolved: Record<string, string>;
  /** Link -> Gemini's source type; absent until classified. */
  sourceTypes?: Record<string, EvidenceSourceType>;
};

const GOOGLE_REDIRECT = /^https:\/\/www\.google\.[a-z.]+\/(goto|url)\?/i;

/** The real URL behind a Google redirect link: read the 302's Location header (the page itself is never fetched). */
async function resolveRedirect(link: string): Promise<string | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(link, { redirect: "manual", signal: AbortSignal.timeout(6000), headers: { "user-agent": "SleuthBot/2 (link resolver)" } });
      const loc = res.headers.get("location");
      if (loc && /^https?:\/\//i.test(loc) && !GOOGLE_REDIRECT.test(loc)) return loc;
    } catch {
      /* retry once */
    }
    await new Promise((r) => setTimeout(r, 800));
  }
  return null;
}

const SourceTypesSchema = z.object({
  types: z.array(z.object({ result: z.number().int(), type: z.enum(["independent_review", "manufacturer", "retailer", "other"]) })).default([]),
});

const CLASSIFY_SYSTEM = `Classify each web search result about a trainer model by who wrote it: independent_review (a reviewer,
magazine, blog, forum or wearer reviewing the shoe), manufacturer (the brand itself), retailer (a shop selling it, including product
pages that call themselves reviews) or other (Q&A pages, AI-generated answers, aggregators, unrelated pages). Use only the site, title
and snippet given. Return one entry per result number.`;

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

async function main() {
  const writeDb = !process.argv.includes("--no-db");
  const config = loadConfig();
  const seed = loadSeedFiles();
  const cache = readJson<Record<string, CacheEntry>>(CACHE_FILE, {});
  for (const [query, e] of Object.entries(cache)) e.modelId ??= seed.catalogue.find((m) => comfortQuery(m.brand, m.name) === query)?.id ?? "";
  const save = () => fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2) + "\n");

  const db = writeDb ? (await import("../lib/db")).getDb() : null;
  const owned = new Set(Object.values(cache).map((e) => e.modelId)); // models whose rows this script built
  const handWritten = new Set(seed.reviews.filter((r) => !owned.has(r.modelId)).map((r) => r.modelId));
  const inDb = db ? new Set((await db.reviewSnippet.groupBy({ by: ["modelId"] })).map((r: { modelId: string }) => r.modelId)) : new Set<string>();
  const targets = seed.catalogue.filter((m) => owned.has(m.id) || (!handWritten.has(m.id) && !inDb.has(m.id)));
  console.log(`${seed.catalogue.length} catalogue models; ${targets.length} to build (${targets.filter((m) => !owned.has(m.id)).length} need a search).`);

  const web = createWebSearchClient({ apiKey: config.shoppingApiKey, mode: "off", store: null, timeoutMs: 30_000 }); // no latency budget here
  const gemini = config.geminiApiKey ? createGeminiClient({ config, transport: createLiveTransport(config.geminiApiKey) }) : null;
  let searches = 0;
  let geminiCalls = 0;
  let newlyResolved = 0;
  const built: ReviewSnippet[] = [];
  const failed: string[] = [];
  const report: { id: string; snippets: number; independent: number }[] = [];

  for (const m of targets) {
    const query = comfortQuery(m.brand, m.name);
    let entry = cache[query];
    if (!entry) {
      try {
        searches++;
        const res = await web.search(query);
        entry = cache[query] = { modelId: m.id, fetchedAt: new Date().toISOString(), results: res.results, resolved: {} };
        save(); // saved straight away, so a rerun never repeats a search
      } catch (err) {
        failed.push(`${m.id} (${err instanceof Error ? err.message : String(err)})`);
        continue;
      }
    }
    for (const r of entry.results) {
      const have = entry.resolved[r.link];
      if (GOOGLE_REDIRECT.test(r.link) && !(have && resolvedMatches(r, have))) {
        const real = await resolveRedirect(r.link);
        if (real && resolvedMatches(r, real)) {
          entry.resolved[r.link] = real;
          newlyResolved++;
        }
      }
    }
    if (!entry.sourceTypes && gemini) {
      try {
        geminiCalls++;
        const list = entry.results.map((r) => `[${r.index}] site: ${r.domain || r.source || "unknown"}\n    ${r.title}\n    ${r.snippet}`).join("\n");
        const { data } = await generateStructured(gemini, SourceTypesSchema, {
          stage: "review_seed",
          tier: "fast",
          system: CLASSIFY_SYSTEM,
          parts: [{ text: `Model: ${m.brand} ${m.name}\nResults:\n${list}` }],
          temperature: 0,
          thinking: "LOW",
        });
        const results = entry.results;
        entry.sourceTypes = Object.fromEntries(data.types.flatMap((t) => (results[t.result - 1] ? [[results[t.result - 1].link, t.type]] : [])));
      } catch (err) {
        console.warn(`  ${m.id}: classification failed (${err instanceof Error ? err.message : String(err)}); domain lists only`);
      }
    }
    save();

    const snippets = snippetsFromResults(m.id, entry.results, entry.resolved, entry.sourceTypes ?? {});
    built.push(...snippets);
    report.push({ id: m.id, snippets: snippets.length, independent: independentSites(snippets) });
    console.log(`  ${m.id}: ${snippets.length} snippets, ${independentSites(snippets)} independent site(s)`);
  }

  const rebuilt = new Set(report.map((r) => r.id));
  const all = [...seed.reviews.filter((r) => !rebuilt.has(r.modelId)), ...built].sort((a, b) => a.modelId.localeCompare(b.modelId));
  fs.writeFileSync(REVIEWS_FILE, JSON.stringify(all, null, 2) + "\n");
  loadSeedFiles(); // re-validate the file just written
  if (db) {
    const rows = reviewRows(all);
    await db.reviewSnippet.deleteMany({ where: { id: { notIn: rows.map((r) => r.id) } } });
    if (rows.length) await db.reviewSnippet.createMany({ data: rows, skipDuplicates: true });
  }

  console.log(`\nSerpApi searches used: ${searches}. Gemini classification calls: ${geminiCalls}. Links newly resolved: ${newlyResolved}.`);
  console.log(`data/reviews.json: ${all.length} snippets${db ? " (ReviewSnippet table synced)" : ""}.`);
  if (failed.length) console.log(`\nSearch failed (rerun to retry; nothing stored for these): ${failed.join(", ")}`);
  const thin = report.filter((r) => r.independent < 2);
  if (thin.length) {
    console.log(`\nModels with fewer than 2 independent sources:`);
    for (const r of thin) console.log(`  ${r.id}: ${r.independent} independent of ${r.snippets} snippets`);
  } else if (report.length) {
    console.log("\nEvery model built got at least 2 independent sources.");
  }
  await db?.$disconnect();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
