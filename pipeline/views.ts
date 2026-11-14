import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { CaseDetail } from "@/schemas/api";
import { NewOffersSchema, type CaseSummary, type CheckResult, type NewOffers, type SizeSystem } from "@/schemas/domain";
import { FeedSeedItemSchema, type FeedItem, type FeedSeedItem, type SizeChart } from "@/schemas/seed";
import { convertSize, parseSizeText } from "@/lib/sizes";
import type { CaseRow } from "@/lib/store";
import type { Deps } from "./deps";
import type { SseEvent } from "./events";
import { indexEvidence } from "./util";

export function imageUrl(origin: string, caseId: string, index: number): string {
  return `${origin}/api/cases/${caseId}/images/${index}`;
}

/** Checks for the current revision, or the previous one while a reopen is still running. */
async function latestChecks(deps: Deps, c: CaseRow) {
  for (let r = c.revision; r >= 1; r--) {
    const checks = await deps.store.getChecks(c.id, r);
    if (checks.length) return { checks, leads: await deps.store.getLeads(c.id, r), revision: r };
  }
  return { checks: [], leads: [], revision: c.revision };
}

/** The price check's new-price offers (details.newOffers), or null when it didn't look any up. */
export function newOffersOf(checks: CheckResult[]): NewOffers | null {
  const raw = (checks.find((c) => c.check === "price")?.details as { newOffers?: unknown } | undefined)?.newOffers;
  const parsed = raw === undefined ? null : NewOffersSchema.safeParse(raw);
  return parsed?.success ? parsed.data : null;
}

export async function caseDetail(deps: Deps, c: CaseRow, origin: string): Promise<CaseDetail> {
  const { checks, leads, revision } = await latestChecks(deps, c);
  const images = await deps.store.getInputs(c.id, { kinds: ["image"], withData: false });
  const entry = c.history.find((h) => h.revision === revision);
  const report = entry?.leads;
  return {
    id: c.id,
    revision: c.revision,
    status: c.status,
    platform: c.platform,
    pageUrl: c.pageUrl,
    listingFacts: c.listingFacts,
    needs: c.needs,
    identify: c.identify,
    checks,
    leads,
    leadsReport: report ?? { considered: leads.length > 0 },
    run: entry?.run ?? null,
    verdict: c.verdict,
    nextMoves: c.nextMoves ?? [],
    newOffers: newOffersOf(checks),
    evidenceIndex: indexEvidence(c.listingFacts?.evidence, c.identify?.evidence, ...checks.map((x) => x.evidence)),
    imageUrls: images.map((_, i) => imageUrl(origin, c.id, i)),
    history: c.history,
  };
}

export async function caseSummaries(deps: Deps, ids: string[], origin: string): Promise<CaseSummary[]> {
  const rows = await deps.store.listCases(ids);
  return Promise.all(
    rows.map(async (c) => {
      const images = await deps.store.getInputs(c.id, { kinds: ["image"], withData: false });
      return {
        id: c.id,
        revision: c.revision,
        title: c.listingFacts?.title,
        priceGBP: c.listingFacts?.priceGBP,
        platform: c.platform,
        verdictLabel: c.verdict?.label,
        thumbnailUrl: images.length ? imageUrl(origin, c.id, 0) : undefined,
        pageUrl: c.pageUrl,
        status: c.status,
        createdAt: c.createdAt.toISOString(),
        updatedAt: c.updatedAt.toISOString(),
      };
    }),
  );
}

/** Events to replay when the in-memory buffer is gone (e.g. after a restart): rebuilt from the database. */
export async function synthesizeEvents(deps: Deps, c: CaseRow): Promise<SseEvent[]> {
  if (c.status === "investigating" || c.status === "open") return [];
  const { checks, leads, revision } = await latestChecks(deps, c);
  const out: SseEvent[] = [];
  let seq = 0;
  const push = (event: SseEvent["event"], data: unknown) => out.push({ id: `${revision}:${++seq}`, revision, event, data });
  push("investigation_started", { caseId: c.id, revision });
  const offers = newOffersOf(checks);
  if (offers) push("new_offers", offers);
  for (const ch of checks) push("check_done", ch);
  for (const l of leads) push("lead_done", l);
  const skipped = c.history.find((h) => h.revision === revision)?.leads?.skipped;
  if (skipped) push("leads_skipped", { reason: skipped });
  if (c.verdict) push("verdict", c.verdict);
  push("next_moves", c.nextMoves ?? []);
  if (c.status === "error") push("error", { message: "The investigation hit an unexpected problem and stopped." });
  const run = c.history.find((h) => h.revision === revision)?.run;
  push("investigation_done", { caseId: c.id, revision, durationMs: run?.durationMs ?? 0, geminiCalls: run?.geminiCalls ?? 0, ...(run ? { cachedCalls: run.cachedCalls } : {}) });
  return out;
}

// ---------- feed (mock feature) ----------

let feedCache: FeedSeedItem[] | null = null;
export function loadFeed(dir = path.join(process.cwd(), "data")): FeedSeedItem[] {
  if (!feedCache) {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, "feed.json"), "utf8"));
    feedCache = z.array(FeedSeedItemSchema).parse(raw);
  }
  return feedCache;
}

/** Does an item (size on its own brand's chart) fit the user's size (on their brand's chart, if known)? */
export function fitsSize(
  item: { modelChart: SizeChart | undefined; size: number; system: SizeSystem },
  user: { brand?: string; size: number; system: SizeSystem },
  charts: SizeChart[],
): boolean {
  if (!item.modelChart) return false;
  const itemRow = convertSize(item.size, item.system, item.modelChart);
  if (!itemRow) return false;
  const userChart = user.brand ? charts.find((c) => c.brand.toLowerCase() === user.brand!.toLowerCase()) : undefined;
  if (userChart && userChart.id !== item.modelChart.id) {
    const userRow = convertSize(user.size, user.system, userChart);
    return !!userRow && Math.abs(userRow.cm - itemRow.cm) <= 0.3;
  }
  const userRow = convertSize(user.size, user.system, item.modelChart);
  return !!userRow && userRow.index === itemRow.index;
}

function sharedCaseToFeed(c: CaseRow, checks: CheckResult[], modelName: string): FeedItem | null {
  if (!c.verdict || c.verdict.label !== "hidden_gem" || c.listingFacts?.priceGBP === undefined) return null;
  const price = checks.find((x) => x.check === "price");
  const sourceEv = price?.evidence.find((e) => e.sourceType === "price_sample") ?? price?.evidence.find((e) => e.kind === "source");
  return {
    caseId: c.id,
    modelName,
    priceGBP: c.listingFacts.priceGBP,
    platform: c.platform,
    verdictLabel: "hidden_gem",
    oneLineEvidence: price?.summary ?? c.verdict.headline,
    priceSource: sourceEv?.label ?? "Sampled listings",
    checkedAt: c.updatedAt.toISOString(),
  };
}

export async function buildFeed(deps: Deps, q: { brand?: string; size?: number; system?: SizeSystem }): Promise<FeedItem[]> {
  const ref = await deps.store.getReference();
  const chartFor = (modelId: string) => {
    const m = ref.catalogue.find((x) => x.id === modelId);
    return m ? ref.sizeCharts.find((c) => c.id === m.sizeChartId) : undefined;
  };
  const filterOn = q.size !== undefined;
  const user = { brand: q.brand, size: q.size ?? 0, system: q.system ?? ("UK" as SizeSystem) };

  const seeded = loadFeed()
    .filter((f) => !filterOn || fitsSize({ modelChart: chartFor(f.modelId), size: f.size.value, system: f.size.system }, user, ref.sizeCharts))
    .map(({ modelId: _m, size: _s, ...item }) => item);

  // Opted-in hidden gems from real cases (no seller or user identity is ever included).
  const shared: FeedItem[] = [];
  for (const c of await deps.store.listSharedHiddenGems(50)) {
    const modelId = c.identify?.catalogueModelId;
    const model = ref.catalogue.find((m) => m.id === modelId);
    if (!model) continue;
    const parsed = parseSizeText(c.listingFacts?.sizeText, c.listingFacts?.sizeSystem === "unknown" ? undefined : c.listingFacts?.sizeSystem);
    if (filterOn) {
      if (!parsed || parsed.system === "unknown") continue;
      if (!fitsSize({ modelChart: chartFor(model.id), size: parsed.size, system: parsed.system }, user, ref.sizeCharts)) continue;
    }
    const item = sharedCaseToFeed(c, await deps.store.getChecks(c.id, c.revision), `${model.brand} ${model.name}`);
    if (item) shared.push(item);
  }
  return [...shared, ...seeded].sort((a, b) => b.checkedAt.localeCompare(a.checkedAt));
}
