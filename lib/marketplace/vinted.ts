import type { ListingData } from "@/schemas/domain";
import { listingItemId } from "@/lib/listingScope";
import { findSizeSystem, isRecord, jsonAt, jsonLdProducts, money, poundsIn, str, type ExtractedListing, type MarketplacePage } from "./common";

/**
 * Vinted item pages, in order: page data (attributes, description, photos, pricing) -> JSON-LD (title, brand, colour,
 * category) -> DOM fallbacks (data-testid fields). JSON-LD's price is in the SELLER's currency and is never used.
 */

const NEXT_F = /self\.__next_f\.push\(\s*(\[[\s\S]*\])\s*\)\s*;?\s*$/;

/** The joined Next.js RSC payload: the strings of every `self.__next_f.push([1, "..."])` script. */
export function nextFlight(scripts: string[]): string {
  let out = "";
  for (const s of scripts) {
    const m = NEXT_F.exec(s.trim());
    if (!m) continue;
    try {
      const arr = JSON.parse(m[1]) as unknown[];
      if (arr[0] === 1 && typeof arr[1] === "string") out += arr[1];
    } catch {
      /* not a flight chunk */
    }
  }
  return out;
}

type Plugin = { name: string; data: Record<string, unknown> };

/** The item's named plugins (summary, attributes, description, ...) from the payload row that lists them. */
export function vintedPlugins(flight: string, itemId: string | null): Plugin[] {
  for (const line of flight.split("\n")) {
    const i = line.indexOf('"plugins":[');
    if (i === -1) continue;
    const arr = jsonAt(line, i + '"plugins":'.length);
    if (!Array.isArray(arr)) continue;
    const plugins = arr.filter(isRecord).filter((p) => typeof p.name === "string" && isRecord(p.data)) as unknown as Plugin[];
    if (!plugins.length) continue;
    if (itemId && !plugins.some((p) => String(p.data.item_id ?? "") === itemId)) continue;
    return plugins;
  }
  return [];
}

/** The pricingServices object (GBP amounts for the viewer, plus the seller's own currency). */
export function vintedPricing(flight: string): Record<string, unknown> | null {
  const i = flight.indexOf('"pricingServices":{');
  if (i === -1) return null;
  const v = jsonAt(flight, i + '"pricingServices":'.length);
  return isRecord(v) ? v : null;
}

const amount = (v: unknown, currency = "GBP"): number | undefined => {
  if (!isRecord(v)) return undefined;
  const cur = String(v.currencyCode ?? v.currency_code ?? "");
  return cur.toUpperCase() === currency ? money(v.amount) : undefined;
};

type Photo = { id: string; isMain: boolean; url: string; dominant?: string };

/** The item's own photos array (full-size `url`, normally /f800/). */
function itemPhotos(plugins: Plugin[]): Photo[] {
  for (const p of plugins) {
    const photos = p.data.photos;
    if (!Array.isArray(photos) || !photos.length) continue;
    const out = photos
      .filter(isRecord)
      .map((ph) => ({ id: String(ph.id ?? ""), isMain: ph.is_main === true, url: String(ph.url ?? ""), dominant: str(ph.dominant_color_opaque) }))
      .filter((ph) => ph.id && /^https:\/\/images\d*\.vinted\.net\//.test(ph.url));
    if (out.length) return out;
  }
  return [];
}

/** The seller's username, id and avatar from the seller blocks (removed everywhere; never sent). */
export function vintedSellerIds(plugins: Plugin[], flight: string): string[] {
  const ids = new Set<string>();
  const add = (v: unknown) => {
    const t = typeof v === "number" ? String(v) : str(v);
    if (t && t.length >= 3 && t.length <= 80) ids.add(t);
  };
  for (const p of plugins) {
    if (p.name === "user_info_header" || p.name === "seller_badges_info") {
      add(p.data.name);
      add(p.data.username);
      add(p.data.login);
      add(p.data.seller_id);
      const photo = isRecord(p.data.photo) ? p.data.photo : undefined;
      add(photo?.id);
    }
    add(p.data.seller_id);
    add(p.data.user_id);
  }
  for (const m of flight.matchAll(/"(?:seller_id|sellerId|user_id)"\s*:\s*"?(\d{3,20})"?/g)) add(m[1]);
  return [...ids];
}

export function extractVinted(page: MarketplacePage): ExtractedListing {
  const itemId = listingItemId(page.pageUrl, "vinted");
  const flight = nextFlight(page.embedded?.scripts ?? []);
  const plugins = vintedPlugins(flight, itemId);
  const plugin = (name: string) => plugins.find((p) => p.name === name)?.data;
  const listing: ListingData = {};
  const sd = "structured_data" as const;
  const pf = "page_field" as const;

  // 1. Page data: attributes, description, photos, pricing.
  const attrs = Array.isArray(plugin("attributes")?.attributes) ? (plugin("attributes")!.attributes as unknown[]).filter(isRecord) : [];
  const attr = (code: string) => {
    const a = attrs.find((x) => x.code === code);
    return str(isRecord(a?.data) ? a.data.value : undefined);
  };
  const set = <K extends "size" | "condition" | "colour" | "material" | "uploadDate" | "brand">(k: K, v: string | undefined, max: number, source: "structured_data" | "page_field" = sd) => {
    if (v) listing[k] = { value: v.slice(0, max), source };
  };
  set("size", attr("size"), 20);
  set("condition", attr("status"), 300);
  set("colour", attr("color"), 80);
  set("material", attr("material"), 120);
  set("uploadDate", attr("upload_date"), 60);
  set("brand", attr("brand"), 80);
  const description = str(plugin("description")?.description) ? String(plugin("description")!.description).trim() : undefined;
  if (description) listing.description = { value: description.slice(0, 5000), source: sd };
  const summaryTitle = (() => {
    const lines = plugin("summary")?.lines;
    if (!Array.isArray(lines)) return undefined;
    for (const l of lines.filter(isRecord)) {
      const els = Array.isArray(l.elements) ? l.elements.filter(isRecord) : [];
      const t = els.find((e) => e.style === "title");
      if (t) return str(t.value);
    }
    return undefined;
  })();
  if (summaryTitle) listing.title = { value: summaryTitle.slice(0, 300), source: sd };

  const photos = itemPhotos(plugins);
  const main = photos.find((p) => p.isMain) ?? photos[0];
  if (main?.dominant && /^#[0-9a-f]{6}$/i.test(main.dominant)) listing.dominantColourHint = main.dominant;

  const pricing = vintedPricing(flight);
  if (pricing) {
    const services = isRecord(pricing.services) ? pricing.services : {};
    const price = amount(pricing.originalAskingAmount);
    const protection = amount(isRecord(services.buyerProtection) ? services.buyerProtection.finalPrice : undefined);
    const postage = amount(isRecord(services.shipping) ? services.shipping.finalPrice : undefined);
    if (price !== undefined) listing.priceGBP = { value: price, source: sd };
    if (protection !== undefined) listing.buyerProtectionGBP = { value: protection, source: sd };
    if (postage !== undefined) listing.postageGBP = { value: postage, source: sd };
    if (price !== undefined && (protection !== undefined || postage !== undefined)) {
      listing.totalGBP = { value: Math.round((price + (protection ?? 0) + (postage ?? 0)) * 100) / 100, source: sd };
    }
    const seller = isRecord(pricing.sellerOriginalAskingAmount) ? pricing.sellerOriginalAskingAmount : undefined;
    const cur = str(seller?.currencyCode)?.toUpperCase();
    const sellerAmount = money(seller?.amount);
    if (cur && cur !== "GBP" && /^[A-Z]{3}$/.test(cur) && sellerAmount !== undefined) listing.sellerPrice = { amount: sellerAmount, currency: cur };
  }
  if (plugins.some((p) => p.name === "offline_verification_availability")) listing.verificationAvailable = true;

  // 2. JSON-LD: title, brand, colour, category (never its price: that is the seller's currency).
  const product = jsonLdProducts(page.embedded?.jsonLd ?? []).find((p) => {
    const offer = isRecord(p.offers) ? p.offers : undefined;
    return !itemId || String(offer?.url ?? p.url ?? "").includes(itemId);
  });
  if (product) {
    const name = str(product.name);
    if (name && !listing.title) listing.title = { value: name.slice(0, 300), source: sd };
    const brand = str(isRecord(product.brand) ? product.brand.name : product.brand);
    if (brand && !listing.brand) listing.brand = { value: brand.slice(0, 80), source: sd };
    const colour = str(product.color);
    if (colour && !listing.colour) listing.colour = { value: colour.slice(0, 80), source: sd };
    const category = str(product.category);
    if (category) listing.category = { value: category.slice(0, 120), source: sd };
    const desc = typeof product.description === "string" ? product.description.trim() : "";
    if (desc && !listing.description) listing.description = { value: desc.slice(0, 5000), source: sd };
  }

  // 3. DOM fallbacks (stable data-testid fields).
  const t = page.fields?.testIds ?? {};
  if (!listing.size) set("size", t["item-attributes-size"], 20, pf);
  if (!listing.condition) set("condition", t["item-attributes-status"], 300, pf);
  if (!listing.colour) set("colour", t["item-attributes-color"], 80, pf);
  if (!listing.material) set("material", t["item-attributes-material"], 120, pf);
  if (!listing.priceGBP) {
    const p = poundsIn(t["item-price"]);
    if (p !== undefined) listing.priceGBP = { value: p, source: pf };
  }
  if (!listing.postageGBP) {
    const p = poundsIn(t["item-shipping-banner-price"]);
    if (p !== undefined) listing.postageGBP = { value: p, source: pf };
  }

  // The size field has no system: look for one in the title, then the description. Never assume UK.
  const system = findSizeSystem(listing.size?.value, listing.title?.value, listing.description?.value);
  if (system) listing.sizeSystem = system;

  const photoUrls = photos.map((p) => p.url);
  listing.photos = { captured: photoUrls.length, shown: page.fields?.photoTiles || photoUrls.length || null };
  return { listing, photos: photoUrls, sellerIds: vintedSellerIds(plugins, flight) };
}
