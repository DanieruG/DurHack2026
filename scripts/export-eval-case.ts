/**
 * Turn captured cases into eval cases (eval/listings/<platform>-<itemId>/), with personal details removed. Reads the
 * main database and never writes to it.
 *   npx tsx scripts/export-eval-case.ts <caseId> [<caseId> ...]
 *   npx tsx scripts/export-eval-case.ts --all      (the newest finished case for each listing)
 *
 * Writes, per listing:
 *   capture.json   the redacted page text, the page URL, the extension's structured fields (`listing`: item
 *                  specifics, size options, Vinted attributes, pricing breakdown, each with its source) when the case
 *                  stored them, and the user's search survey as card facts only (never the user's own sizes or
 *                  profile: the eval uses its own profile, see eval/LABELLING.md)
 *   photo-NN.*     the listing's own photos as stored with the case, in photo-index order (sent as screenshots); other
 *                  listings' thumbnails that older captures picked up are left out, and repeats of one photo kept once
 *   photos.json    which case the photos came from and their sha256 (photos are gitignored; npm run eval:photos
 *                  restores them). Photos it lists as removed (not the shoes) are never exported again.
 *   label.json     every field left empty, for a person to fill in. Labels are never filled in from the pipeline.
 * An existing label.json is never overwritten.
 */
import "../lib/loadEnv";
import fs from "node:fs";
import path from "node:path";
import { redact } from "../lib/redact";
import { listingItemId, scopeListingImages } from "../lib/listingScope";
import type { StoredSurvey } from "../lib/observed";
import { ListingDataSchema, type ListingData, type ObservedListing, type Platform } from "../schemas/domain";
import { redactListingData } from "../pipeline/listingData";
import { EMPTY_LABEL } from "../eval/labels";
import { manifestFromFolder, readManifest, sha256, writeManifest } from "../eval/photos";

const { getDb } = await import("../lib/db");
const db = getDb();
const OUT = path.join(process.cwd(), "eval", "listings");
const EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

const args = process.argv.slice(2);
if (!args.length) throw new Error("usage: npx tsx scripts/export-eval-case.ts <caseId...> | --all");

const select = {
  id: true,
  createdAt: true,
  status: true,
  platform: true,
  pageUrl: true,
  revision: true,
  inputs: { orderBy: [{ revision: "asc" as const }, { position: "asc" as const }], select: { kind: true, revision: true, text: true, data: true, mimeType: true, sourceUrl: true } },
};
let cases = args[0] === "--all" ? await db.case.findMany({ orderBy: { createdAt: "desc" }, select }) : await db.case.findMany({ where: { id: { in: args } }, select });
if (args[0] === "--all") {
  // The newest case per listing that has page text; a finished one if there is one.
  const byListing = new Map<string, (typeof cases)[number]>();
  for (const c of cases) {
    if (!c.pageUrl || !c.inputs.some((i) => i.kind === "page_text")) continue;
    const prev = byListing.get(c.pageUrl);
    if (!prev || (prev.status !== "closed" && c.status === "closed")) byListing.set(c.pageUrl, c);
  }
  cases = [...byListing.values()];
}

/** The stored structured fields (listing_data), redacted again; null for cases captured before they were stored. */
function structuredFields(text: string | null | undefined): ListingData | null {
  if (!text) return null;
  const parsed = ListingDataSchema.safeParse(JSON.parse(text));
  if (!parsed.success) throw new Error(`stored listing_data doesn't match ListingDataSchema: ${parsed.error.issues[0]?.message}`);
  return redactListingData(parsed.data) ?? null;
}

/** Stored survey cards back into the capture format: card facts only (title, price, link, thumbnail, size). */
function surveyCards(text: string | null | undefined): { observedListings: ObservedListing[]; searchQuery?: string } | null {
  if (!text) return null;
  const s = JSON.parse(text) as StoredSurvey;
  return {
    observedListings: s.listings.map((l) => ({
      id: l.id,
      title: l.title,
      price: l.priceGBP,
      currency: "GBP",
      url: l.url,
      ...(l.thumbnailUrl ? { thumbnailUrl: l.thumbnailUrl } : {}),
      ...(l.sizeText ? { sizeText: l.sizeText } : {}),
      sponsored: l.sponsored,
      priceBasis: s.priceBasis,
      seenAt: `${l.seenOn ?? s.surveyedOn}T12:00:00.000Z`,
    })),
    ...(s.searchQuery ? { searchQuery: s.searchQuery } : {}),
  };
}

for (const c of cases) {
  const platform = c.platform as Platform;
  const itemId = c.pageUrl ? listingItemId(c.pageUrl, platform) : null;
  const name = `${platform}-${itemId ?? c.id}`;
  const dir = path.join(OUT, name);
  fs.mkdirSync(dir, { recursive: true });

  // First revision only: later revisions add seller replies, which are the user's conversation.
  const first = c.inputs.filter((i) => i.revision === 1);
  const pageText = redact(first.find((i) => i.kind === "page_text")?.text).text;
  const survey = surveyCards(first.find((i) => i.kind === "observed_listings")?.text);
  const listing = structuredFields(first.find((i) => i.kind === "listing_data")?.text);
  // Only this listing's own photos, once each: older captures also picked up other listings' thumbnails.
  const seen = new Set<string>();
  const photos = first.filter((i) => {
    if (!(i.kind === "image" || i.kind === "screenshot") || !i.data || !i.mimeType || !EXT[i.mimeType]) return false;
    if (!i.sourceUrl) return true;
    const scoped = scopeListingImages([i.sourceUrl], platform)[0];
    // One photo at two sizes (eBay s-l400.jpg and s-l1600.webp) shares its image id.
    const key = scoped && (i.sourceUrl.match(/\/images\/g\/([^/]+)\//)?.[1] ?? scoped);
    if (!key || (platform === "vinted" && /\/310x430\//.test(i.sourceUrl)) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Photos removed on purpose (not the shoes) stay out; photos.json records them.
  const removed = new Set((readManifest(dir)?.removed ?? []).map((r) => r.sha256));
  const kept = photos.filter((p) => !removed.has(sha256(p.data!)));
  for (const f of fs.readdirSync(dir).filter((f) => /^photo-\d+\./.test(f))) fs.rmSync(path.join(dir, f));
  kept.forEach((p, n) => fs.writeFileSync(path.join(dir, `photo-${String(n + 1).padStart(2, "0")}.${EXT[p.mimeType!]}`), p.data!));

  const capture = {
    capture: { pageUrl: c.pageUrl ?? undefined, pageText, ...(listing ? { listing } : {}), imageUrls: [], ...(survey ?? {}) },
    source: { exportedFrom: "live testing", capturedOn: c.createdAt.toISOString().slice(0, 10), status: c.status },
  };
  fs.writeFileSync(path.join(dir, "capture.json"), `${JSON.stringify(capture, null, 2)}\n`);
  writeManifest(dir, manifestFromFolder(dir, c.id));
  const labelPath = path.join(dir, "label.json");
  if (!fs.existsSync(labelPath)) fs.writeFileSync(labelPath, `${JSON.stringify(EMPTY_LABEL, null, 2)}\n`);
  console.log(`${name}: ${kept.length} photos, ${pageText.length} chars of page text${listing ? ", structured fields" : ", no structured fields"}${survey ? `, ${survey.observedListings.length} survey cards` : ""} (case ${c.id}, ${c.status})`);
}
process.exit(0);
