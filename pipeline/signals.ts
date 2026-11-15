import type {
  CheckName,
  CheckResult,
  Evidence,
  IdentifyResult,
  ListingFacts,
  Platform,
  WarningSignal,
} from "@/schemas/domain";
import { titleMatchesModel } from "@/lib/newPrices";
import { gbp } from "./util";

export type WarningSignalInput = {
  checks: CheckResult[];
  facts: ListingFacts;
  identify: IdentifyResult | null;
  pageText: string;
  sellerReplies?: string[];
  platform: Platform;
};

const OFF_PLATFORM = /(?:\bbank\s+transfer\b|\bbacs\b|\bsort\s+code\b|\bpaypal\s+(?:friends?\s*(?:and|&)\s*family|f\s*&\s*f|fnf)\b|\bwhatsapp\b|\btelegram\b|\b(?:text|txt)\s+me\b|\b(?:call|ring)\s+me\b|\bemail\s+me\b|\[phone number removed\]|\[email removed\]|\bpay\s+directly\b|\bpay\s+outside\b|\boff\s+the\s+(?:app|platform|site|vinted|ebay|depop)\b)/i;
const NEGATED = /\b(?:no|not|never|don't|do not|won't|will not|without)\b/i;
const NEW_CLAIM = /\b(?:brand\s+new|new\s+with\s+tags?|new\s+without\s+tags?|bnwt|bnib|unworn|never\s+worn|new\s+in\s+box|deadstock)\b|\bnew\b(?!\s+balance)/i;
const LIKE_NEW = /\b(?:like\s+new|as\s+new|nearly\s+new)\b/i;
const SIZE_LABEL = /\b(?:size|tongue)\s+label\b/i;
const INSOLE = /\binsole\b/i;

const check = (checks: CheckResult[], name: CheckName) => checks.find((c) => c.check === name);
const details = (result: CheckResult | undefined): Record<string, unknown> => (result?.details ?? {}) as Record<string, unknown>;

function signalEvidence(id: string, label: string, quote?: string, value?: string | number): Evidence {
  return { id, kind: quote ? "quote" : "data_point", label, ...(quote ? { quote } : {}), ...(value !== undefined ? { value } : {}) };
}

function firstOffPlatformEvidence(pageText: string, sellerReplies: string[]): Evidence | null {
  const sources = [{ label: "Listing text", text: pageText }, ...sellerReplies.map((text) => ({ label: "Seller's reply", text }))];
  for (const source of sources) {
    for (const clause of source.text.split(/[.,;!?\n]+/).map((x) => x.trim()).filter(Boolean)) {
      const match = OFF_PLATFORM.exec(clause);
      if (!match) continue;
      if (NEGATED.test(clause.slice(0, match.index))) continue;
      return signalEvidence("ev_signal_off_platform_1", source.label, clause.slice(0, 300));
    }
  }
  return null;
}

/** What the buyer pays, for new-price comparisons (Vinted: including protection and postage). */
function paidFor(price: number, d: Record<string, unknown>): { total: number; words: string } {
  const total = typeof d.listingTotalGBP === "number" ? d.listingTotalGBP : price;
  const basis = typeof d.priceBasis === "string" && total !== price ? d.priceBasis : `${gbp(price)}`;
  return { total, words: basis };
}

function priceEvidence(price: number, d: Record<string, unknown>, id: string): Evidence | null {
  const sample = d.sample as { n?: number; p10?: number; p90?: number } | undefined;
  if (sample?.n !== undefined && sample.n >= 5 && sample.p10 !== undefined && price < sample.p10) {
    const source = (d.observedComparison as { source?: string } | undefined)?.source === "observed_listings" ? "your search" : "sampled listings";
    return signalEvidence(id, `Priced at ${gbp(price)}. ${source[0].toUpperCase()}${source.slice(1)}: ${gbp(sample.p10)} to ${gbp(sample.p90 ?? sample.p10)}.`, undefined, price);
  }
  const newPrice = d.newPrice as { gbp?: number } | undefined;
  const paid = paidFor(price, d);
  if (newPrice?.gbp !== undefined && paid.total < 0.4 * newPrice.gbp) {
    return signalEvidence(id, `Priced at ${paid.words}. New from UK retailers: about ${gbp(newPrice.gbp)}.`, undefined, paid.total);
  }
  return null;
}

function newPriceEvidence(price: number, d: Record<string, unknown>): Evidence | null {
  const newPrice = d.newPrice as { gbp?: number } | undefined;
  const paid = paidFor(price, d);
  if (newPrice?.gbp === undefined || paid.total >= 0.6 * newPrice.gbp) return null;
  return signalEvidence("ev_signal_new_at_low_price_1", `Priced at ${paid.words}. New from UK retailers: about ${gbp(newPrice.gbp)}.`, undefined, paid.total);
}

function modelsMatch(a: string, b: string): boolean {
  const normalise = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return normalise(a) === normalise(b);
}

function titleModel(facts: ListingFacts, identify: IdentifyResult): string | null {
  const title = facts.title ?? "";
  const brand = facts.brandText ?? identify.brand ?? "";
  if (facts.modelText && titleMatchesModel(title, brand, facts.modelText)) return facts.modelText;
  if (identify.modelName && titleMatchesModel(title, brand, identify.modelName)) return identify.modelName;
  return null;
}

function conditionPhotoEvidence(condition: CheckResult | undefined): { photos: { photoIndex: number; stockPhotoLikely: boolean; confidence: number; showsSizeLabel: boolean; showsInsole: boolean }[]; notVisible: string[] } {
  const d = details(condition);
  const photos = Array.isArray(d.photos) ? d.photos : [];
  return {
    photos: photos.filter((p): p is { photoIndex: number; stockPhotoLikely: boolean; confidence: number; showsSizeLabel: boolean; showsInsole: boolean } => {
      if (!p || typeof p !== "object") return false;
      const x = p as Record<string, unknown>;
      return typeof x.photoIndex === "number" && typeof x.stockPhotoLikely === "boolean" && typeof x.confidence === "number";
    }),
    notVisible: Array.isArray(d.notVisible) ? d.notVisible.filter((x): x is string => typeof x === "string") : [],
  };
}

/** Detect explainable warning signs using only redacted text and existing check results. */
export function detectWarningSignals(args: WarningSignalInput): WarningSignal[] {
  const out: WarningSignal[] = [];
  const offPlatform = firstOffPlatformEvidence(args.pageText, args.sellerReplies ?? []);
  if (offPlatform) {
    out.push({ id: "off_platform", strength: "strong", text: "The listing asks to move payment or contact off-platform.", evidence: [offPlatform], confidence: 0.9, relatesTo: ["price"] });
  }

  const price = check(args.checks, "price");
  const priceDetails = details(price);
  const listingPrice = typeof priceDetails.listingPriceGBP === "number" ? priceDetails.listingPriceGBP : args.facts.priceGBP;
  if (listingPrice !== undefined) {
    const ev = priceEvidence(listingPrice, priceDetails, "ev_signal_price_far_below_1");
    if (ev) out.push({ id: "price_far_below", strength: "medium", text: "Unusually low. Could be a quick sale, but worth checking.", evidence: [ev], confidence: 0.85, relatesTo: ["price"] });
    if (NEW_CLAIM.test(args.facts.conditionClaims.join(" ")) && !LIKE_NEW.test(args.facts.conditionClaims.join(" "))) {
      const newEv = newPriceEvidence(listingPrice, priceDetails);
      if (newEv) out.push({ id: "new_at_low_price", strength: "medium", text: "Listed as new at an unusually low price. There may be an innocent explanation, but it is worth checking.", evidence: [newEv], confidence: 0.85, relatesTo: ["price", "condition"] });
    }
  }

  const condition = check(args.checks, "condition");
  const photoInfo = conditionPhotoEvidence(condition);
  const mainStock = photoInfo.photos.find((p) => p.photoIndex === 0);
  const allPhotosRepresented = args.facts.photoCount > 0 && new Set(photoInfo.photos.map((p) => p.photoIndex)).size >= args.facts.photoCount;
  const allStock = allPhotosRepresented && photoInfo.photos.every((p) => p.stockPhotoLikely && p.confidence >= 0.7);
  if ((mainStock?.stockPhotoLikely && mainStock.confidence >= 0.7) || allStock) {
    out.push({ id: "stock_photos", strength: "medium", text: "The photos look stock-like rather than clearly showing the actual pair.", evidence: [signalEvidence("ev_signal_stock_photos_1", "Stock-looking photo evidence")], confidence: 0.8, relatesTo: ["condition"] });
  }

  const photoModel = args.identify?.photoModel;
  const listedModel = args.identify ? titleModel(args.facts, args.identify) : null;
  if (photoModel && photoModel.confidence >= 0.8 && listedModel && !modelsMatch(photoModel.modelName, listedModel)) {
    out.push({ id: "title_photo_mismatch", strength: "medium", text: "The model shown in the photos does not match the model named in the title.", evidence: [signalEvidence("ev_signal_title_photo_mismatch_1", `Title names ${listedModel}; photos suggest ${photoModel.modelName}.`)], confidence: Math.min(photoModel.confidence, 0.9), relatesTo: ["identify"] });
  }

  if (out.length > 0) {
    const sizeFromPhoto = args.facts.evidence.some((e) => e.kind === "photo_region" && /^Listed size \(photo/i.test(e.label));
    const sizeVisible = photoInfo.photos.some((p) => p.showsSizeLabel) || sizeFromPhoto || !photoInfo.notVisible.some((x) => SIZE_LABEL.test(x));
    const insoleVisible = photoInfo.photos.some((p) => p.showsInsole) || !photoInfo.notVisible.some((x) => INSOLE.test(x));
    const missing: string[] = [];
    if (!sizeVisible) missing.push("the size label");
    if (!insoleVisible) missing.push("the insole");
    if (missing.length) {
      out.push({ id: "expected_photos_missing", strength: "mild", text: `The listing does not show ${missing.join(" or ")}, which would help verify the pair.`, evidence: [signalEvidence("ev_signal_expected_photos_missing_1", `Not visible: ${missing.join(", ")}.`)], confidence: 0.75, relatesTo: ["condition", "identify"] });
    }
  }
  return out;
}
