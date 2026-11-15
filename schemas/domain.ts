import { z } from "zod";

// ---------- primitives ----------

export const PlatformSchema = z.enum(["vinted", "facebook", "ebay", "depop", "other"]);
export type Platform = z.infer<typeof PlatformSchema>;

export const SizeSystemSchema = z.enum(["UK", "US", "EU"]);
export type SizeSystem = z.infer<typeof SizeSystemSchema>;

export const CheckNameSchema = z.enum(["identify", "fit", "price", "comfort", "condition"]);
export type CheckName = z.infer<typeof CheckNameSchema>;

export const GeminiFeatureSchema = z.enum([
  "vision",
  "object_detection",
  "search_grounding",
  "function_calling",
  "structured_output",
]);
export type GeminiFeature = z.infer<typeof GeminiFeatureSchema>;

export const Box2dSchema = z.tuple([z.number(), z.number(), z.number(), z.number()]);
export type Box2d = z.infer<typeof Box2dSchema>;

export const ConditionGradeSchema = z.enum(["new_with_tags", "like_new", "good", "worn"]);
export type ConditionGrade = z.infer<typeof ConditionGradeSchema>;

// ---------- capture & profile ----------

export const MAX_PAGE_TEXT = 20_000;
/** Most surveyed listings one capture may carry (the extension keeps at most 300 cards in total). */
export const MAX_OBSERVED_LISTINGS = 300;

const httpsUrl = z
  .string()
  .max(2048)
  .url()
  .refine((u) => /^https:\/\//i.test(u), "must be https");

/**
 * One listing card the user saw on a marketplace search results page (Feature A: "Survey this search"). Card facts
 * only: unknown keys are stripped, and there is deliberately no field for a seller's name, rating or location.
 */
export const ObservedListingSchema = z.object({
  id: z.string().min(1).max(64),
  title: z.string().min(1).max(300),
  price: z.number().nonnegative().max(100_000).nullable(),
  currency: z.string().max(8).nullable(),
  url: httpsUrl,
  thumbnailUrl: httpsUrl.optional(),
  sizeText: z.string().max(60).optional(),
  condition: z.string().max(60).optional(),
  sponsored: z.boolean().default(false),
  /** eBay only: auctions are excluded from every comparison (Buy It Now prices only). */
  buyingFormat: z.enum(["auction", "buy_it_now", "unknown"]).optional(),
  /** Vinted: which price the card gave. The extension always sends the item price without the buyer protection fee. */
  priceBasis: z.enum(["listed", "excl_buyer_protection"]).default("listed"),
  /** When the card was surveyed (ISO). */
  seenAt: z.string().datetime({ offset: true }),
});
export type ObservedListing = z.infer<typeof ObservedListingSchema>;

// ---------- structured listing data (read from the page by the extension) ----------

/** Where a listing field came from: the page's own JSON-LD or state, a visible page field (DOM), or Gemini. */
export const FieldSourceSchema = z.enum(["structured_data", "page_field", "gemini"]);
export type FieldSource = z.infer<typeof FieldSourceSchema>;

const sourcedText = (max: number) => z.object({ value: z.string().trim().min(1).max(max), source: FieldSourceSchema });
const sourcedGBP = z.object({ value: z.number().nonnegative().max(100_000), source: FieldSourceSchema });

export const SizeSystemOrUnknownSchema = z.enum(["UK", "US", "EU", "unknown"]);

/** One size a multi-size listing offers (eBay variations): a choice, not a fact about the pair. */
export const SizeOptionSchema = z.object({ value: z.string().trim().min(1).max(20), outOfStock: z.boolean() });
export const SizeOptionsSchema = z.object({
  /** The menu's own label, e.g. "UK Shoe Size". */
  label: z.string().max(60),
  system: SizeSystemOrUnknownSchema,
  options: z.array(SizeOptionSchema).min(1).max(60),
  source: FieldSourceSchema,
});
export type SizeOptions = z.infer<typeof SizeOptionsSchema>;

/** Where the size system was found ("Mens US 14" in the description); never assumed. */
export const SizeSystemFoundSchema = z.object({
  value: SizeSystemSchema,
  source: FieldSourceSchema,
  foundIn: z.enum(["size_field", "size_menu", "title", "description", "photo"]),
  quote: z.string().max(120).optional(),
});
export type SizeSystemFound = z.infer<typeof SizeSystemFoundSchema>;

/**
 * This listing's own fields, read by the extension from the page's structured data (JSON-LD, page state) and visible
 * page fields before anything is sent to Gemini. Listing facts only: there is deliberately no field for the seller.
 */
export const ListingDataSchema = z.object({
  title: sourcedText(300).optional(),
  brand: sourcedText(80).optional(),
  model: sourcedText(120).optional(),
  condition: sourcedText(300).optional(),
  colour: sourcedText(80).optional(),
  material: sourcedText(120).optional(),
  category: sourcedText(120).optional(),
  description: sourcedText(5000).optional(),
  uploadDate: sourcedText(60).optional(),
  styleCode: sourcedText(40).optional(),
  /** A single listed size (Vinted). */
  size: sourcedText(20).optional(),
  sizeSystem: SizeSystemFoundSchema.optional(),
  /** Size choices on a multi-size listing (eBay variations). */
  sizeOptions: SizeOptionsSchema.optional(),
  /** The listing price in GBP (Vinted: the GBP asking amount, never the seller's own currency). */
  priceGBP: sourcedGBP.optional(),
  /** eBay "List price"/RRP. */
  listPriceGBP: sourcedGBP.optional(),
  postageGBP: sourcedGBP.optional(),
  buyerProtectionGBP: sourcedGBP.optional(),
  /** Price plus buyer protection plus postage, when all parts are known. */
  totalGBP: sourcedGBP.optional(),
  /** The price in the seller's own currency, when it isn't GBP (evidence only: "Seller listed it at 40 AUD"). */
  sellerPrice: z.object({ amount: z.number().nonnegative().max(1_000_000), currency: z.string().min(3).max(3), source: FieldSourceSchema.optional() }).optional(),
  /** Item specifics pairs (eBay "About this item"), with where they were read (optional for older captures). */
  itemSpecifics: z.array(z.object({ label: z.string().max(60), value: z.string().max(300), source: FieldSourceSchema.optional() })).max(40).optional(),
  photos: z.object({ captured: z.number().int().nonnegative(), shown: z.number().int().nonnegative().nullable() }).optional(),
  /** The platform indicates its own item verification may apply (Vinted). */
  verificationAvailable: z.boolean().optional(),
  /** Vinted's dominant colour of the main photo: mostly the backdrop, so a weak hint only. */
  dominantColourHint: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  /** Plain notes about what couldn't be read, e.g. "Seller description not captured". */
  notes: z.array(z.string().max(200)).max(10).optional(),
});
export type ListingData = z.infer<typeof ListingDataSchema>;

/** What the extension (or upload page) sends. Screenshots arrive as multipart files. */
export const CaptureSchema = z.object({
  /** This listing's fields from the page's own data (see ListingDataSchema). */
  listing: ListingDataSchema.optional(),
  pageUrl: z.string().url().max(2048).optional(),
  pageText: z.string().max(MAX_PAGE_TEXT).optional(),
  imageUrls: z.array(z.string().url().max(2048)).max(32).optional(),
  /** Listings from the user's own survey of a search on the same platform (never a wider search). */
  observedListings: z.array(ObservedListingSchema).max(MAX_OBSERVED_LISTINGS).optional(),
  /** The search the survey came from: the USER's search, a hint only, never a fact about this listing. */
  searchQuery: z.string().trim().max(200).optional(),
});
export type Capture = z.infer<typeof CaptureSchema>;

export const ProfileSizeSchema = z.object({
  brand: z.string().min(1).max(60),
  size: z.number().positive().max(60),
  // Optional on input: a missing system is assumed UK by needs.ts and recorded in `assumptions`.
  system: SizeSystemSchema.optional(),
});

/** The user's usual size, not tied to any brand: used for a brand they haven't saved a size for. */
export const DefaultSizeSchema = z.object({
  size: z.number().positive().max(60),
  system: SizeSystemSchema.optional(),
});

export const WearToleranceSchema = z.enum(["none", "light", "moderate", "any"]);
export type WearTolerance = z.infer<typeof WearToleranceSchema>;

/** Saved in the extension, sent with every case. */
export const ProfileSchema = z.object({
  /** Usual size for any brand without its own entry in `sizes`. */
  defaultSize: DefaultSizeSchema.optional(),
  /** Brand-specific sizes; these win over defaultSize for that brand. */
  sizes: z.array(ProfileSizeSchema).max(20).default([]),
  priorities: z.array(z.string().min(1).max(80)).max(12).default([]),
  budgetGBP: z.number().positive().max(100_000).optional(),
  wearTolerance: WearToleranceSchema.default("light"),
});
export type Profile = z.infer<typeof ProfileSchema>;

export const UserNeedsSchema = z.object({
  sizes: z.array(z.object({ brand: z.string(), size: z.number(), system: SizeSystemSchema })),
  defaultSize: z.object({ size: z.number(), system: SizeSystemSchema }).optional(),
  priorities: z.array(z.string()),
  budgetGBP: z.number().optional(),
  wearTolerance: WearToleranceSchema,
  caseNote: z.string().optional(),
  extraPriorities: z.array(z.string()),
  assumptions: z.array(z.string()),
});
export type UserNeeds = z.infer<typeof UserNeedsSchema>;

// ---------- evidence ----------

export const EvidenceSourceTypeSchema = z.enum([
  "independent_review",
  "manufacturer",
  "retailer",
  "price_sample",
  "observed_listings",
  "other",
]);
export type EvidenceSourceType = z.infer<typeof EvidenceSourceTypeSchema>;

export const EvidenceSchema = z.object({
  id: z.string(),
  kind: z.enum(["quote", "photo_region", "data_point", "source"]),
  label: z.string(),
  quote: z.string().optional(),
  photoIndex: z.number().int().nonnegative().optional(),
  box2d: Box2dSchema.optional(),
  value: z.union([z.string(), z.number()]).optional(),
  url: z.string().optional(),
  /** The source's own site, when `url` is a redirect that doesn't show it (SerpApi web results). */
  domain: z.string().optional(),
  title: z.string().optional(),
  sourceType: EvidenceSourceTypeSchema.optional(),
  observedOn: z.string().optional(),
});
export type Evidence = z.infer<typeof EvidenceSchema>;

export const WarningSignalSchema = z.object({
  id: z.enum([
    "off_platform",
    "price_far_below",
    "new_at_low_price",
    "stock_photos",
    "title_photo_mismatch",
    "expected_photos_missing",
  ]),
  strength: z.enum(["strong", "medium", "mild"]),
  text: z.string(),
  evidence: z.array(EvidenceSchema),
  confidence: z.number().min(0).max(1),
  relatesTo: z.array(CheckNameSchema),
});
export type WarningSignal = z.infer<typeof WarningSignalSchema>;

// ---------- pipeline results ----------

export const BroadColourSchema = z.enum(["black", "white", "grey", "navy", "blue", "red", "green", "brown", "beige", "pink", "purple", "orange", "yellow"]);

/**
 * The clicked listing's colour, from the strongest source available: a style code (exact colourway), the listing's
 * colour field (unless generic, e.g. "Multicoloured"), colour words in the title, then photo analysis (weak).
 */
export const ListingColourSchema = z.object({
  names: z.array(BroadColourSchema),
  source: z.enum(["style_code", "colour_field", "title", "photo"]),
  confidence: z.number().min(0).max(1),
  styleCode: z.string().optional(),
  /** Every source consulted, strongest first, with what it said (for evidence). */
  evidence: z.array(z.object({ source: z.enum(["style_code", "colour_field", "title", "photo", "photo_hint"]), names: z.array(BroadColourSchema), note: z.string() })),
  /** Sources that disagreed with the one kept. */
  conflicts: z.array(z.object({ source: z.string(), names: z.array(BroadColourSchema) })),
});
export type ListingColour = z.infer<typeof ListingColourSchema>;

export const ListingFactsSchema = z.object({
  title: z.string().optional(),
  brandText: z.string().optional(),
  modelText: z.string().optional(),
  sizeText: z.string().optional(),
  sizeSystem: z.enum(["UK", "US", "EU", "unknown"]).optional(),
  priceGBP: z.number().nonnegative().optional(),
  platform: PlatformSchema,
  conditionClaims: z.array(z.string()),
  photoCount: z.number().int().nonnegative(),
  evidence: z.array(EvidenceSchema),
  /** Where each filled field came from (title, brand, model, size, sizeSystem, price, condition, colour, ...). */
  fieldSources: z.record(z.string(), FieldSourceSchema).optional(),
  /** Where the size system was found, when it was found (never assumed). */
  sizeSystemFound: SizeSystemFoundSchema.optional(),
  /** Size choices on a multi-size listing: there is no single listed size then. */
  sizeOptions: SizeOptionsSchema.optional(),
  /** The listing's own colour field (Vinted colour, eBay item specifics), as written. */
  colourText: z.string().optional(),
  styleCode: z.string().optional(),
  listPriceGBP: z.number().nonnegative().optional(),
  postageGBP: z.number().nonnegative().optional(),
  buyerProtectionGBP: z.number().nonnegative().optional(),
  /** What the buyer pays: price plus whatever of buyer protection and postage is known (see totalIncludes). */
  totalGBP: z.number().nonnegative().optional(),
  totalIncludes: z.array(z.enum(["buyer_protection", "postage"])).optional(),
  sellerPrice: z.object({ amount: z.number(), currency: z.string() }).optional(),
  verificationAvailable: z.boolean().optional(),
  photosShown: z.number().int().nonnegative().nullable().optional(),
  notes: z.array(z.string()).optional(),
  /** The whole shoe (or pair) in photo 0, box2d 0-1000, for colour analysis. */
  shoeBox: Box2dSchema.optional(),
  /** Vinted's dominant colour of the main photo (mostly the backdrop: a weak hint only). */
  dominantColourHint: z.string().optional(),
  listingColour: ListingColourSchema.optional(),
});
export type ListingFacts = z.infer<typeof ListingFactsSchema>;

/**
 * How sure identification is. `user_confirmed` is set only by the confirm-identity endpoint.
 * confirmed: style code read clearly, or the listing's own data states the exact model and version, consistent with the photos.
 * likely: confidence 0.75 or more, nothing conflicting. possible: 0.5 to 0.75, or Flash and Pro disagree. best_guess: below 0.5.
 */
export const ConfidenceLevelSchema = z.enum(["confirmed", "likely", "possible", "best_guess", "user_confirmed"]);
export type ConfidenceLevel = z.infer<typeof ConfidenceLevelSchema>;

/** One identification: the best guess or an alternative. `model` is the name without the brand. */
export const IdentifyCandidateSchema = z.object({
  brand: z.string().nullable(),
  model: z.string().nullable(),
  version: z.string().nullable().default(null),
  colourway: z.string().nullable().default(null),
  confidence: z.number().min(0).max(1),
  evidence: z.array(EvidenceSchema).default([]),
});
export type IdentifyCandidate = z.infer<typeof IdentifyCandidateSchema>;

/**
 * Tiered identification. Brand and model name are reported even when the model isn't in the catalogue;
 * catalogueModelId is set only for an exact catalogue match. Defaults keep cases stored before the tiers valid.
 * `bestGuess`, `alternatives` and `confidenceLevel` are derived from the old fields for cases stored before they existed
 * (see normaliseIdentify in pipeline/identifyLevel.ts).
 */
export const IdentifyResultSchema = z.object({
  /** The identification the checks run on (brand-only, with brandOnlyReason, when Gemini suggested no model at all). */
  bestGuess: IdentifyCandidateSchema.optional(),
  /** Up to 2 other candidates, most likely first. */
  alternatives: z.array(IdentifyCandidateSchema).max(2).optional(),
  confidenceLevel: ConfidenceLevelSchema.optional(),
  /** Why only the brand is known (Gemini couldn't suggest any model). */
  brandOnlyReason: z.string().optional(),
  /** Google Lens visual matches used as extra evidence (never facts); also stored as `source` evidence with links. */
  lensMatches: z.array(z.object({ title: z.string(), source: z.string().nullable().default(null), url: z.string().optional() })).optional(),
  /** Set when the user confirmed or corrected the identification. */
  userChoice: z.object({ choice: z.enum(["best_guess", "alternative", "custom", "skip"]), at: z.string() }).optional(),
  /** Recognised brand (catalogue casing when the brand is in the catalogue), or null. */
  brand: z.string().nullable().default(null),
  /** Probability that `brand` is right. */
  brandConfidence: z.number().min(0).max(1).default(0),
  /** Recognised model name without the brand, e.g. "Dropset 3", or null. */
  modelName: z.string().nullable().default(null),
  catalogueModelId: z.string().nullable(),
  inCatalogue: z.boolean().default(false),
  /** Probability that `modelName` (and catalogueModelId, when set) is exactly right. */
  confidence: z.number().min(0).max(1),
  reasons: z.string(),
  evidence: z.array(EvidenceSchema),
  /** The model the photos alone appear to show, without relying on listing text. */
  photoModel: z.object({ modelName: z.string(), confidence: z.number().min(0).max(1) }).nullable().optional(),
  /**
   * Set when the model came only from photos and the Gemini Pro recheck disagreed, declined or timed out: the brand and
   * model family are known, the exact version isn't. `options` are the two candidate versions (B is null when Pro gave none).
   */
  versionUnclear: z
    .object({ family: z.string(), options: z.tuple([z.string(), z.string().nullable()]) })
    .optional(),
});
export type IdentifyResult = z.infer<typeof IdentifyResultSchema>;

export const CheckStatusSchema = z.enum(["pass", "warn", "fail", "unknown"]);
export type CheckStatus = z.infer<typeof CheckStatusSchema>;

export const CheckResultSchema = z.object({
  check: CheckNameSchema,
  status: CheckStatusSchema,
  summary: z.string(),
  evidence: z.array(EvidenceSchema),
  confidence: z.number().min(0).max(1),
  geminiFeatures: z.array(GeminiFeatureSchema),
  details: z.record(z.string(), z.unknown()).optional(),
  /**
   * What the check actually did: its Gemini calls (cachedCalls of them answered from the record/replay cache) and, for
   * comfort (web search) and price (Google Shopping), whether the search was live or served from the cache.
   */
  usage: z
    .object({
      geminiCalls: z.number().int(),
      cachedCalls: z.number().int(),
      search: z.object({ kind: z.enum(["web", "shopping"]), live: z.boolean() }).optional(),
    })
    .optional(),
});
export type CheckResult = z.infer<typeof CheckResultSchema>;

export const DefectLabelSchema = z.enum([
  "outsole_wear",
  "heel_wear",
  "upper_creasing",
  "stitching_damage",
  "discolouration",
  "tear_or_hole",
  "sole_separation",
  "dirt_or_staining",
]);
export type DefectLabel = z.infer<typeof DefectLabelSchema>;

export const SeveritySchema = z.enum(["minor", "moderate", "major"]);
export type Severity = z.infer<typeof SeveritySchema>;

export const ConditionFindingSchema = z.object({
  label: DefectLabelSchema,
  photoIndex: z.number().int().nonnegative(),
  box2d: Box2dSchema,
  severity: SeveritySchema,
  confidence: z.number().min(0).max(1), // < 0.6 is presented as "possible"
  note: z.string(),
  evidenceId: z.string(),
});
export type ConditionFinding = z.infer<typeof ConditionFindingSchema>;

export const VerdictLabelSchema = z.enum([
  "hidden_gem",
  "worth_a_look",
  "proceed_with_caution",
  "overpriced",
  "wrong_fit",
  "not_enough_evidence",
]);
export type VerdictLabel = z.infer<typeof VerdictLabelSchema>;

export const VerdictSchema = z.object({
  label: VerdictLabelSchema,
  ruleId: z.string(),
  headline: z.string(),
  explanation: z.string(),
  citedEvidenceIds: z.array(z.string()),
  confidence: z.number().min(0).max(1),
  badge: z.enum(["out_sleuthed"]).nullable(),
});
export type Verdict = z.infer<typeof VerdictSchema>;

export const LeadTypeSchema = z.enum([
  "deeper_price_comparison",
  "recheck_identification",
  "recheck_condition_photo",
  "flag_for_seller",
]);
export type LeadType = z.infer<typeof LeadTypeSchema>;

export const LeadSchema = z.object({
  id: z.string(),
  type: LeadTypeSchema,
  reason: z.string(),
  status: z.enum(["pending", "done", "skipped", "failed"]),
  outcome: z.string().optional(),
  /** Which check the lead is about (used by flag_for_seller to target a seller question). */
  relatesTo: CheckNameSchema.optional(),
});
export type Lead = z.infer<typeof LeadSchema>;

/**
 * Whether follow-up leads were considered for a revision, and if they were skipped, why (one plain line).
 * Not considered: every check was clear (or leads are turned off), so the case file hides the section.
 */
export const LeadsReportSchema = z.object({
  considered: z.boolean(),
  skipped: z.string().optional(),
});
export type LeadsReport = z.infer<typeof LeadsReportSchema>;

export const NextMoveSchema = z.object({
  id: z.string(),
  kind: z.enum(["ask_seller", "before_you_pay"]),
  text: z.string(),
  relatesTo: z.array(CheckNameSchema),
});
export type NextMove = z.infer<typeof NextMoveSchema>;

export const CaseDiffSchema = z.object({
  fromRevision: z.number().int(),
  toRevision: z.number().int(),
  checks: z.array(
    z.object({ check: CheckNameSchema, before: z.string(), after: z.string(), reason: z.string() }),
  ),
  verdict: z.object({ before: VerdictLabelSchema, after: VerdictLabelSchema }),
});
export type CaseDiff = z.infer<typeof CaseDiffSchema>;

export const CaseSummarySchema = z.object({
  id: z.string(),
  revision: z.number().int(),
  title: z.string().optional(),
  priceGBP: z.number().optional(),
  platform: PlatformSchema,
  verdictLabel: VerdictLabelSchema.optional(),
  thumbnailUrl: z.string().optional(),
  /** The listing the case was opened from ("View listing"). */
  pageUrl: z.string().nullable().default(null),
  status: z.enum(["open", "investigating", "closed", "error"]).default("closed"),
  createdAt: z.string().optional(),
  updatedAt: z.string(),
});
export type CaseSummary = z.infer<typeof CaseSummarySchema>;

export const CaseStatusSchema = z.enum(["open", "investigating", "closed", "error"]);
export type CaseStatus = z.infer<typeof CaseStatusSchema>;

// ---------- check details (section 7.6) ----------

export const SampleStatsSchema = z.object({
  n: z.number().int(),
  excluded: z.number().int(),
  median: z.number(),
  p10: z.number(),
  p25: z.number(),
  p75: z.number(),
  p90: z.number(),
  collectedOn: z.object({ from: z.string(), to: z.string() }),
  /** Sampling rule ids behind the kept samples (see data/sampling-rules.md). */
  ruleIds: z.array(z.string()),
  /** True when any sample is placeholder data (ruleId starting "SYNTHETIC"); surfaced in evidence labels. */
  placeholder: z.boolean(),
});
export type SampleStats = z.infer<typeof SampleStatsSchema>;

export const PricePositionSchema = z.enum([
  "below",
  "typical",
  "above",
  "suspiciously_low",
  "at_or_above_new",
]);
export type PricePosition = z.infer<typeof PricePositionSchema>;

/** One UK retailer's current new price (Google Shopping). Retailer data only: never a user or a seller. */
export const NewOfferSchema = z.object({
  retailer: z.string(),
  title: z.string(),
  priceGBP: z.number(),
  /** The retailer's own product page when Shopping gives one, otherwise the Google Shopping page. Always http(s). */
  url: z.string(),
  /** Shopping thumbnail, only from the allowed image hosts (lib/newPrices.ts THUMBNAIL_HOST). */
  thumbnailUrl: z.string().optional(),
  /** Offer price minus listing price; negative means cheaper than the listing. */
  differenceGBP: z.number(),
  isLowest: z.boolean(),
  /** Whether this offer is the listing's colour: style code or title words, else the thumbnail's colours. */
  colourMatch: z.enum(["same", "different", "unknown"]).default("unknown"),
  /** What the colour match rests on ("Title says Black/White", "Thumbnail looks grey (62%)"). */
  colourEvidence: z.string().optional(),
});
export type NewOffer = z.infer<typeof NewOfferSchema>;

/** The kept new-price offers, cheapest first; enoughForComparison is false when fewer than 3 were kept (not used for the verdict). */
export const NewOffersSchema = z.object({
  offers: z.array(NewOfferSchema),
  checkedOn: z.string(),
  enoughForComparison: z.boolean(),
  /** "Colours vary: price includes other colourways" when fewer than 3 offers are the listing's colour. */
  colourNote: z.string().optional(),
  /** The Shopping queries run, in order. */
  queries: z.array(z.string()).optional(),
});
export type NewOffers = z.infer<typeof NewOffersSchema>;

// ---------- observed listings (Feature A: the user's own search survey) ----------

export const MatchLevelSchema = z.enum(["exact", "version_unknown", "different_version", "none"]);
export type MatchLevelName = z.infer<typeof MatchLevelSchema>;

export const MatchCountsSchema = z.object({
  exact: z.number().int(),
  version_unknown: z.number().int(),
  different_version: z.number().int(),
  none: z.number().int(),
});
export type MatchCounts = z.infer<typeof MatchCountsSchema>;

/** A cheaper surveyed listing that matches exactly (Price exhibit evidence, never a ranking of all results). */
export const ObservedSuggestionSchema = z.object({
  id: z.string(),
  title: z.string(),
  priceGBP: z.number(),
  url: z.string(),
  thumbnailUrl: z.string().optional(),
  platform: PlatformSchema,
  /** "UK 9", or null with sizeNotStated true. */
  sizeLabel: z.string().nullable(),
  sizeNotStated: z.boolean(),
  sponsored: z.boolean(),
  /** How much cheaper than the listing being investigated. */
  savingGBP: z.number(),
});
export type ObservedSuggestion = z.infer<typeof ObservedSuggestionSchema>;

export const ObservedComparisonSchema = z.object({
  searchQuery: z.string().nullable(),
  /** The survey's date (YYYY-MM-DD). */
  surveyedOn: z.string(),
  platform: PlatformSchema,
  /** Which Vinted price the survey used, recorded so it's consistent ("listed" on eBay). */
  priceBasis: z.enum(["listed", "excl_buyer_protection"]),
  /** Usable cards per match level, plus what was left out before matching. */
  counts: MatchCountsSchema.extend({
    surveyed: z.number().int(),
    auctionsExcluded: z.number().int(),
    unpricedExcluded: z.number().int(),
  }),
  /** The comparison the price verdict used: observed listings (Source C), the catalogue sample (A), the new price only (B), or none. */
  source: z.enum(["observed_listings", "price_sample", "new_price", "none"]),
  /** Source C stats over exact matches (all adult sizes); null when fewer than 5 exact matches. */
  stats: z.object({ n: z.number().int(), excluded: z.number().int(), median: z.number(), p10: z.number(), p25: z.number(), p75: z.number(), p90: z.number() }).nullable(),
  /** Shown instead when there were too few exact matches (or only the family is known): "4 similar listings seen, £30 to £45". */
  context: z
    .object({ n: z.number().int(), minGBP: z.number(), maxGBP: z.number(), exact: z.number().int(), versionUnknown: z.number().int(), familyLevel: z.boolean(), line: z.string() })
    .nullable(),
  /** e.g. "Couldn't compare: model unknown." */
  note: z.string().nullable(),
  suggestions: z.array(ObservedSuggestionSchema),
});
export type ObservedComparison = z.infer<typeof ObservedComparisonSchema>;

/**
 * A cheaper listing from the user's own survey worth a look ("Worth looking at" under the Price exhibit). Card facts
 * only, never seller details. Not investigated: it matched on its title, size and colour, nothing more.
 */
export const ObservedAlternativeSchema = z.object({
  listingId: z.string(),
  title: z.string(),
  priceGBP: z.number(),
  /** Always the listed prices (Vinted's without buyer protection); postage is never included. */
  priceBasis: z.enum(["listed"]),
  platform: PlatformSchema,
  url: z.string(),
  thumbnailUrl: z.string().optional(),
  /** "UK 9" (or "US 9" when it couldn't be converted), or null when the card states no size. */
  size: z.string().nullable(),
  /** exact, or version_unknown ("Version not stated"). */
  matchLevel: z.enum(["exact", "version_unknown"]),
  /** same, or unknown ("Colour unclear"). A different colour is never an alternative. */
  colourMatch: z.enum(["same", "unknown"]),
  /** Alternative price minus listing price, on the same basis: always negative (cheaper). */
  differenceGBP: z.number(),
  /** When the user surveyed it (YYYY-MM-DD). */
  observedOn: z.string(),
});
export type ObservedAlternative = z.infer<typeof ObservedAlternativeSchema>;

export const ObservedAlternativesSchema = z.object({
  /** False when the case was sent without a survey (alternatives is then empty). */
  surveyUsed: z.boolean(),
  /** The survey's platform and date, for "From your Vinted search on 14 Nov"; null without a survey. */
  platform: PlatformSchema.nullable(),
  surveyedOn: z.string().nullable(),
  /** Exact matches before version-not-stated ones, then cheapest first. */
  alternatives: z.array(ObservedAlternativeSchema),
});
export type ObservedAlternatives = z.infer<typeof ObservedAlternativesSchema>;

export const FitMatchSchema = z.enum(["exact", "close", "mismatch", "estimated"]);
export type FitMatch = z.infer<typeof FitMatchSchema>;
