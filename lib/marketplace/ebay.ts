import type { ListingData, SizeOptions } from "@/schemas/domain";
import { listingItemId } from "@/lib/listingScope";
import {
  firstOffer,
  isRecord,
  jsonLdProducts,
  money,
  schemaCondition,
  str,
  systemFromLabel,
  valueAfterKey,
  type ExtractedListing,
  type MarketplacePage,
} from "./common";

/**
 * eBay item pages, in order: JSON-LD core fields -> item specifics from the DOM -> photos from the gallery grid -> size
 * options from the page state (MSKU). JSON-LD's `image` is never used for photos: it lists only some of them.
 */

const EBAY_ID = /\/images\/g\/([^/]+)\//;

/** Full-size eBay photo URL from any size variant: https://i.ebayimg.com/images/g/{id}/s-l1600.jpg */
export function ebayPhotoUrl(url: string): { id: string; url: string } | null {
  if (!/^https:\/\/i\.ebayimg\.com\/images\/g\//i.test(url)) return null;
  const m = EBAY_ID.exec(url);
  return m ? { id: m[1], url: `https://i.ebayimg.com/images/g/${m[1]}/s-l1600.jpg` } : null;
}

/** Gallery grid photos (src, or data-src for lazy-loaded ones), one per image id, full size, in gallery order. */
export function ebayGridPhotos(grid: { src: string | null; dataSrc: string | null }[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const g of grid) {
    for (const u of [g.src, g.dataSrc]) {
      const p = u ? ebayPhotoUrl(u) : null;
      if (!p || seen.has(p.id)) continue;
      seen.add(p.id);
      out.push(p.url);
    }
  }
  return out;
}

const STYLE_LABEL = /^(style code|style|style number|mpn|manufacturer part number|product code|model number)$/i;
const NOT_APPLICABLE = /^(does not apply|n\/?a|not applicable|unbranded|-|none)$/i;

/** The size menu of the page state's MSKU (variation) model: each option's name and stock flag. */
export function ebaySizeOptions(scripts: string[]): SizeOptions | undefined {
  const msku = valueAfterKey(scripts.filter((s) => s.includes('"MSKU"')), "MSKU", '{"_type":"VariationViewModel"');
  if (!isRecord(msku)) return undefined;
  const menus = Array.isArray(msku.selectMenus) ? msku.selectMenus.filter(isRecord) : [];
  const menu = menus.find((m) => /size/i.test(String(m.displayLabel ?? ""))) ?? (menus.length === 1 ? menus[0] : undefined);
  const map = isRecord(msku.menuItemMap) ? msku.menuItemMap : {};
  if (!menu) return undefined;
  const ids = Array.isArray(menu.menuItemValueIds) ? menu.menuItemValueIds : [];
  const options = ids
    .map((id) => map[String(id)])
    .filter(isRecord)
    .map((o) => ({ value: str(o.valueName) ?? str(o.displayName) ?? "", outOfStock: o.outOfStock === true }))
    .filter((o) => o.value && o.value.length <= 20)
    .slice(0, 60);
  if (!options.length) return undefined;
  const label = str(menu.displayLabel) ?? "Size";
  return { label: label.slice(0, 60), system: systemFromLabel(label), options, source: "structured_data" };
}

/** The seller's identifiers in the page data and links, so they can be removed everywhere (never sent). */
export function ebaySellerIds(page: MarketplacePage): string[] {
  const ids = new Set<string>();
  const add = (v: string | undefined) => {
    const t = v ? decodeURIComponent(v.replace(/\+/g, " ")).replace(/^~/, "").trim() : "";
    if (t.length >= 3 && t.length <= 64) ids.add(t);
  };
  const texts = [...(page.embedded?.scripts ?? []), ...(page.embedded?.json ?? [])];
  for (const t of texts) {
    for (const m of t.matchAll(/[?&](?:seller|_ssn|username|store_name|sid)=([^&"'\\\s#]{3,64})/g)) add(m[1]);
    for (const m of t.matchAll(/"(?:_ssn|store_name|username|sellerUserName|sellerName|storeName)"\s*:\s*"([^"\\]{3,64})"/g)) add(m[1]);
    for (const m of t.matchAll(/"entity_id"\s*:\s*"~([^"\\]{3,64})"/g)) add(m[1]);
    for (const m of t.matchAll(/ebay\.[a-z.]+\/(?:str|usr)\/([A-Za-z0-9_.-]{3,64})/g)) add(m[1]);
  }
  return [...ids];
}

export function extractEbay(page: MarketplacePage): ExtractedListing {
  const itemId = listingItemId(page.pageUrl, "ebay");
  const fields = page.fields;
  const listing: ListingData = {};
  const notes: string[] = [];

  // 1. JSON-LD Product for this item (its offer URL names the item id).
  const products = jsonLdProducts(page.embedded?.jsonLd ?? []);
  const product = products.find((p) => {
    const u = [p.url, p["@id"], firstOffer(p)?.url].map(str).filter(Boolean) as string[];
    return !itemId || !u.length || u.some((x) => x.includes(itemId));
  });
  if (product) {
    const offer = firstOffer(product);
    const sd = "structured_data" as const;
    const name = str(product.name);
    if (name) listing.title = { value: name.slice(0, 300), source: sd };
    const brand = str(isRecord(product.brand) ? product.brand.name : product.brand);
    if (brand) listing.brand = { value: brand.slice(0, 80), source: sd };
    const model = str(product.model);
    if (model) listing.model = { value: model.slice(0, 120), source: sd };
    const gbp = !offer?.priceCurrency || /^gbp$/i.test(String(offer.priceCurrency));
    const price = gbp ? money(offer?.price) : undefined;
    if (price !== undefined) listing.priceGBP = { value: price, source: sd };
    const spec = isRecord(offer?.priceSpecification) ? offer.priceSpecification : undefined;
    const list = spec && /list price|rrp/i.test(String(spec.name ?? "")) && (!spec.priceCurrency || /^gbp$/i.test(String(spec.priceCurrency))) ? money(spec.price) : undefined;
    if (list !== undefined) listing.listPriceGBP = { value: list, source: sd };
    const condition = schemaCondition(offer?.itemCondition);
    if (condition) listing.condition = { value: condition, source: sd };
    const shipping = Array.isArray(offer?.shippingDetails) ? offer.shippingDetails.find(isRecord) : isRecord(offer?.shippingDetails) ? offer.shippingDetails : undefined;
    const rate = shipping && isRecord(shipping.shippingRate) ? shipping.shippingRate : undefined;
    const postage = rate && (!rate.currency || /^gbp$/i.test(String(rate.currency))) ? money(rate.value) : undefined;
    if (postage !== undefined) listing.postageGBP = { value: postage, source: sd };
    if (price !== undefined && postage !== undefined) listing.totalGBP = { value: Math.round((price + postage) * 100) / 100, source: sd };
  }

  // 2. Item specifics (visible page fields).
  const specifics = (fields?.specifics ?? []).filter((s) => s.label && s.value);
  if (specifics.length) listing.itemSpecifics = specifics.slice(0, 40).map((s) => ({ label: s.label, value: s.value, source: "page_field" as const }));
  const spec = (re: RegExp) => specifics.find((s) => re.test(s.label))?.value;
  const pf = "page_field" as const;
  const colour = spec(/^colou?r$/i);
  if (colour) listing.colour = { value: colour.slice(0, 80), source: pf };
  if (!listing.brand && spec(/^brand$/i)) listing.brand = { value: spec(/^brand$/i)!.slice(0, 80), source: pf };
  if (!listing.model) {
    const m = spec(/^model$/i) ?? spec(/^product line$/i);
    if (m) listing.model = { value: m.slice(0, 120), source: pf };
  }
  const material = spec(/^upper material$/i) ?? spec(/^material$/i);
  if (material) listing.material = { value: material.slice(0, 120), source: pf };
  const styleCode = specifics.find((s) => STYLE_LABEL.test(s.label) && !NOT_APPLICABLE.test(s.value.trim()))?.value;
  if (styleCode && styleCode.length <= 40) listing.styleCode = { value: styleCode, source: pf };
  const conditionText = spec(/^condition$/i);
  // JSON-LD's condition ("New") stands; the specifics' fuller wording ("New with box") stays in itemSpecifics.
  if (conditionText && !listing.condition) listing.condition = { value: conditionText.split(":")[0].slice(0, 300), source: pf };

  // 3. Photos: the gallery grid only (src or data-src), one per image id, full size.
  const photos = ebayGridPhotos(fields?.grid ?? []);
  listing.photos = { captured: photos.length, shown: fields?.pictureTotal ?? null };

  // 4. Size options from the page state (the visible page only says "UK Shoe Size: Select").
  const sizeOptions = ebaySizeOptions(page.embedded?.scripts ?? []);
  if (sizeOptions) {
    listing.sizeOptions = sizeOptions;
    if (sizeOptions.system !== "unknown") listing.sizeSystem = { value: sizeOptions.system, source: "structured_data", foundIn: "size_menu", quote: sizeOptions.label };
  }

  if (fields?.descriptionFrame) notes.push("Seller description not captured");
  if (notes.length) listing.notes = notes;
  return { listing, photos, sellerIds: ebaySellerIds(page) };
}
