import type { CaseDetail } from "@/schemas/api";
import type { CaseDiff, CheckResult, NewOffers, ObservedAlternatives, ObservedComparison, Profile } from "@/schemas/domain";
import type { ListingPreview } from "../lib/capture";
import { applyEvent, newInvestigation, type IncomingEvent, type Investigation } from "../lib/progress";

/** A flat, unbranded running shoe on a light backdrop, standing in for a listing photo (toe left, heel right). */
export const TRAINER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300">
<rect width="400" height="300" fill="#E4E6E9"/>
<rect y="236" width="400" height="64" fill="#D6D9DD"/>
<path d="M40 214 L364 214 L364 220 C364 231 356 238 342 238 L66 238 C48 238 40 231 40 222 Z" fill="#2B2D31"/>
<path d="M38 214 C35 200 44 192 60 190 L250 186 C290 184 320 176 350 168 C363 165 369 176 367 194 L364 214 Z" fill="#F3F3F1"/>
<path d="M52 204 L360 198" stroke="#C9CCD0" stroke-width="2"/>
<path d="M60 190 C66 160 96 140 140 128 L196 112 C214 96 236 84 262 80 L300 74 C320 72 336 80 344 96 C352 120 354 148 350 168 C320 176 290 184 250 186 Z" fill="#4E5866"/>
<path d="M60 190 C66 160 96 140 140 128 L156 152 C124 162 100 176 94 189 Z" fill="#69727E"/>
<path d="M300 112 C318 108 336 112 348 124 L350 168 C334 172 318 176 302 178 Z" fill="#434C59"/>
<path d="M262 80 C280 70 310 66 330 74 C324 84 300 88 276 90 Z" fill="#26282C"/>
<g stroke="#E6E7E9" stroke-width="5" stroke-linecap="round">
<path d="M196 112 L210 126"/><path d="M212 102 L226 116"/><path d="M228 93 L242 107"/><path d="M244 86 L258 100"/>
</g>
<rect x="340" y="74" width="9" height="24" fill="#A3A9B2"/>
<path d="M150 168 C200 164 250 154 300 140" stroke="#8A929C" stroke-width="3" fill="none"/>
<path d="M338 178 C346 182 352 192 354 204" stroke="#B9BDC2" stroke-width="5" stroke-linecap="round" fill="none"/>
</svg>`;

export const TRAINER_URL = `data:image/svg+xml;utf8,${encodeURIComponent(TRAINER_SVG)}`;

export const PROFILE: Profile = {
  sizes: [
    { brand: "Nike", size: 9, system: "UK" },
    { brand: "Adidas", size: 9.5, system: "UK" },
  ],
  priorities: ["all-day comfort"],
  budgetGBP: 60,
  wearTolerance: "light",
};

export const LISTING: ListingPreview = {
  title: "Nike Pegasus 40",
  priceGBP: 42,
  platform: "vinted",
  photoCount: 5,
  thumbnail: TRAINER_URL,
  pageUrl: "https://www.vinted.co.uk/items/0000000000-nike-pegasus-40",
};

const condition: CheckResult = {
  check: "condition",
  status: "warn",
  summary: "Possible heel wear (photo 1). Inside lining not shown.",
  evidence: [{ id: "ev_c1", kind: "photo_region", label: "Possible heel wear (photo 1)", photoIndex: 0, box2d: [560, 760, 820, 935] }],
  confidence: 0.55,
  geminiFeatures: ["vision", "object_detection", "structured_output"],
  details: {
    findings: [{ label: "heel_wear", photoIndex: 0, box2d: [560, 760, 820, 935], severity: "moderate", confidence: 0.52, note: "Outsole worn at the heel edge", evidenceId: "ev_c1" }],
    notVisible: ["inside lining"],
    contradictions: [],
    photosChecked: 5,
  },
};

const fit: CheckResult = {
  check: "fit",
  status: "pass",
  summary: "Listed UK 9. Your Nike size.",
  evidence: [
    { id: "ev_f1", kind: "quote", label: "Listing size", quote: "UK 9" },
    { id: "ev_f2", kind: "data_point", label: "Your saved Nike size: UK 9", value: 9 },
    { id: "ev_f3", kind: "data_point", label: "Nike size chart: UK 9 = US 10 = EU 44 (28 cm)", value: 28 },
  ],
  confidence: 0.95,
  geminiFeatures: [],
  details: { listed: "UK 9", listedSystem: "UK", match: "exact" },
};

const comfort: CheckResult = {
  check: "comfort",
  status: "pass",
  summary: "Reviewers praise the cushioning for long days.",
  evidence: [
    { id: "ev_m1", kind: "source", label: "RunRepeat", title: "Nike Pegasus 40 review", url: "https://runrepeat.com/nike-pegasus-40", sourceType: "independent_review", quote: "Comfortable enough to wear all day, not just for runs.", observedOn: "2026-11-14" },
    { id: "ev_m2", kind: "source", label: "Runner's World", title: "Pegasus 40 tested", url: "https://www.runnersworld.com/uk/pegasus-40", sourceType: "independent_review", quote: "Soft, forgiving cushioning that holds up over long miles.", observedOn: "2026-11-14" },
    { id: "ev_m3", kind: "source", label: "Believe in the Run", title: "Pegasus 40 review", url: "https://believeintherun.com/pegasus-40", sourceType: "independent_review", quote: "A dependable daily shoe that stays comfortable.", observedOn: "2026-11-14" },
  ],
  confidence: 0.8,
  geminiFeatures: ["search_grounding"],
};

/** Retailer offers as the server sends them (same colour first, then cheapest; one isLowest). Thumbnails left out: the preview is offline. */
export const NEW_OFFERS: NewOffers = {
  checkedOn: "2026-11-14",
  enoughForComparison: true,
  offers: [
    { retailer: "Decathlon UK", title: "Nike Air Zoom Pegasus 40 Men's Road Running Shoes", priceGBP: 75.23, url: "https://www.decathlon.co.uk/", differenceGBP: 33.23, isLowest: true, colourMatch: "same", colourEvidence: "Thumbnail looks black 71%, white 22%" },
    { retailer: "Sports Direct", title: "Nike Pegasus 40 Running Shoes Mens", priceGBP: 79.99, url: "https://www.sportsdirect.com/", differenceGBP: 37.99, isLowest: false, colourMatch: "same", colourEvidence: "Thumbnail looks black 64%, white 30%" },
    { retailer: "JD Sports", title: "Nike Air Zoom Pegasus 40", priceGBP: 89.99, url: "https://www.jdsports.co.uk/", differenceGBP: 47.99, isLowest: false, colourMatch: "unknown" },
    { retailer: "FARFETCH", title: "Nike Air Zoom Pegasus 40 low-top sneakers", priceGBP: 104, url: "https://www.farfetch.com/uk/", differenceGBP: 62, isLowest: false, colourMatch: "different", colourEvidence: "Thumbnail looks white 82%" },
  ],
};

/** A comparison with the user's own search survey: too few exact matches for Source C, so context and suggestions only. */
export const OBSERVED: ObservedComparison = {
  searchQuery: "nike pegasus 40",
  surveyedOn: "2026-11-14",
  platform: "vinted",
  priceBasis: "excl_buyer_protection",
  counts: { exact: 4, version_unknown: 2, different_version: 6, none: 9, surveyed: 21, auctionsExcluded: 0, unpricedExcluded: 0 },
  source: "price_sample",
  stats: null,
  context: { n: 6, minGBP: 28, maxGBP: 55, exact: 4, versionUnknown: 2, familyLevel: false, line: "6 similar listings seen, £28 to £55 (4 exact, 2 not stating the version)" },
  note: null,
  suggestions: [
    { id: "4410001", title: "Nike Air Zoom Pegasus 40 UK 9 grey", priceGBP: 28, url: "https://www.vinted.co.uk/items/4410001-nike-pegasus-40", thumbnailUrl: TRAINER_URL, platform: "vinted", sizeLabel: "UK 9", sizeNotStated: false, sponsored: false, savingGBP: 14 },
    { id: "4410002", title: "Pegasus 40 running shoes Nike", priceGBP: 34, url: "https://www.vinted.co.uk/items/4410002-pegasus-40", platform: "vinted", sizeLabel: null, sizeNotStated: true, sponsored: true, savingGBP: 8 },
  ],
};

/** Cheaper listings from the same survey ("Worth looking at"): 4 qualify, so 3 show with "Show all 4". */
export const ALTERNATIVES: ObservedAlternatives = {
  surveyUsed: true,
  platform: "vinted",
  surveyedOn: "2026-11-14",
  alternatives: [
    { listingId: "4410001", title: "Nike Air Zoom Pegasus 40 UK 9 grey and white, worn twice", priceGBP: 28, priceBasis: "listed", platform: "vinted", url: "https://www.vinted.co.uk/items/4410001-nike-pegasus-40", thumbnailUrl: TRAINER_URL, size: "UK 9", matchLevel: "exact", colourMatch: "same", differenceGBP: -14, observedOn: "2026-11-14" },
    { listingId: "4410003", title: "Nike Pegasus 40 trainers", priceGBP: 31, priceBasis: "listed", platform: "vinted", url: "https://www.vinted.co.uk/items/4410003-nike-pegasus-40", size: null, matchLevel: "exact", colourMatch: "unknown", differenceGBP: -11, observedOn: "2026-11-14" },
    { listingId: "4410002", title: "Pegasus running shoes Nike", priceGBP: 34, priceBasis: "listed", platform: "vinted", url: "https://www.vinted.co.uk/items/4410002-pegasus", thumbnailUrl: TRAINER_URL, size: "UK 9", matchLevel: "version_unknown", colourMatch: "same", differenceGBP: -8, observedOn: "2026-11-14" },
    { listingId: "4410004", title: "Nike Pegasus grey", priceGBP: 36, priceBasis: "listed", platform: "vinted", url: "https://www.vinted.co.uk/items/4410004-pegasus", size: "UK 9", matchLevel: "version_unknown", colourMatch: "same", differenceGBP: -6, observedOn: "2026-11-14" },
  ],
};

const price: CheckResult = {
  check: "price",
  status: "pass",
  summary: "Below typical. Compared with 12 listings sampled 10 Nov.",
  evidence: [
    { id: "ev_p1", kind: "data_point", label: "Compared with 12 listings sampled on 10 Nov", sourceType: "price_sample", observedOn: "2026-11-10" },
    { id: "ev_p2", kind: "source", label: "New price at a retailer: £75", url: "https://example.com", sourceType: "retailer", observedOn: "2026-11-14" },
  ],
  confidence: 0.7,
  geminiFeatures: ["search_grounding"],
  details: {
    listingPriceGBP: 42,
    sample: { n: 12, excluded: 1, median: 50, p10: 36, p25: 44, p75: 55, p90: 60, collectedOn: { from: "2026-11-10", to: "2026-11-10" }, ruleIds: ["R-newest-N"], placeholder: false },
    newPrice: { gbp: 75, sources: 3 },
    position: "below",
    newOffers: NEW_OFFERS,
    observedComparison: OBSERVED,
    observedAlternatives: ALTERNATIVES,
  },
};

const identify: CheckResult = {
  check: "identify",
  status: "pass",
  summary: "Identified as the Nike Pegasus 40.",
  evidence: [],
  confidence: 0.9,
  geminiFeatures: ["vision", "structured_output"],
  details: { modelName: "Nike Pegasus 40", gatePassed: true },
};

export const CASE_FILE: CaseDetail = {
  id: "cm0preview0042",
  revision: 1,
  status: "closed",
  platform: "vinted",
  pageUrl: LISTING.pageUrl,
  listingFacts: null,
  needs: { sizes: [{ brand: "Nike", size: 9, system: "UK" }], priorities: ["all-day comfort"], budgetGBP: 60, wearTolerance: "light", extraPriorities: [], assumptions: [] },
  identify: null,
  checks: [identify, condition, fit, comfort, price],
  leads: [
    { id: "lead_1", type: "recheck_condition_photo", reason: "The heel wear in photo 2 was uncertain.", status: "done", outcome: "Rechecked photo 2 for heel wear: condition is warn." },
    { id: "lead_2", type: "flag_for_seller", reason: "The inside lining isn't shown.", status: "done", outcome: "Added a question for the seller about condition.", relatesTo: "condition" },
  ],
  leadsReport: { considered: true },
  newOffers: NEW_OFFERS,
  observedComparison: OBSERVED,
  observedAlternatives: ALTERNATIVES,
  warningSignals: [{
    id: "stock_photos",
    strength: "medium",
    text: "The photos look stock-like rather than clearly showing the actual pair.",
    evidence: [{ id: "ev_signal_stock_photos_1", kind: "data_point", label: "Stock-looking photo evidence" }],
    confidence: 0.8,
    relatesTo: ["condition"],
  }],
  run: { durationMs: 11400, geminiCalls: 7, cachedCalls: 0 },
  verdict: {
    label: "proceed_with_caution",
    ruleId: "R6",
    headline: "Good fit and fair price, but check the heel before buying.",
    explanation: "The size matches your Nike UK 9 and the price sits below most of the 12 sampled listings. The heel may be worn, and the photos don't show the inside lining, so ask before you commit.",
    citedEvidenceIds: ["ev_c1", "ev_f2", "ev_p1"],
    confidence: 0.6,
    badge: null,
  },
  nextMoves: [{ id: "nm1", kind: "ask_seller", text: "Could you send a close-up of the heel?", relatesTo: ["condition"] }],
  evidenceIndex: {},
  imageUrls: [TRAINER_URL],
  history: [],
};

export const DIFF: CaseDiff = {
  fromRevision: 1,
  toRevision: 2,
  checks: [{ check: "condition", before: "warn", after: "pass", reason: "Heel close-up shows light wear only" }],
  verdict: { before: "proceed_with_caution", after: "worth_a_look" },
};

/** The investigation screen, part-way through, built by replaying real event shapes through the reducer. */
export function investigationInProgress(): Investigation {
  const t0 = 1_000_000;
  const ev = (name: IncomingEvent["name"], data: unknown, s: number): IncomingEvent => ({ name, data, revision: 1, at: t0 + s * 1000 });
  const events: IncomingEvent[] = [
    ev("investigation_started", { caseId: "x", revision: 1 }, 0),
    ev("stage_started", { stage: "identify" }, 1),
    ev("check_done", identify, 3),
    ev("check_done", fit, 4),
    ev("stage_started", { stage: "price" }, 4),
    ev("new_offers", NEW_OFFERS, 5),
    ev("check_done", { ...price, status: "warn", details: { ...price.details, position: "suspiciously_low" } }, 6),
    ev("check_done", { ...comfort, evidence: [...comfort.evidence, { ...comfort.evidence[0], id: "ev_m4", url: "https://example.org/review" }] }, 9),
    ev("stage_started", { stage: "condition" }, 9),
    ev("lead_started", { id: "lead1", type: "deeper_price_comparison", reason: "Price is under p10.", status: "pending", relatesTo: "price" }, 11),
  ];
  return events.reduce(applyEvent, newInvestigation(1, t0));
}
