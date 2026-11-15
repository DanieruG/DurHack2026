# Detective Sleuth: Backend Technical Specification (v2)

> Build spec for Claude Code. **Backend only.** The frontend (Chrome extension side panel and a fallback upload page) is designed and built separately. This spec defines the API, event and data contracts the frontend consumes. Do not build extension code, pages, components or styling.

---

## 1. What we are building

Sleuth is a sceptical second opinion before you buy second-hand. While viewing a listing on any marketplace (Vinted, Facebook Marketplace, eBay, others), the user clicks the Sleuth Chrome extension. The extension captures what is on the page and sends it, with the user's saved needs, to this backend. The backend runs an **investigation** and returns a **verdict with evidence** plus **next moves**.

Pipeline summary:

1. Accept a captured listing (page text, image URLs, screenshots, page URL) and the user's needs.
2. Read the listing with Gemini (no per-site parsers).
3. Identify the product: always a best guess with a confidence level and alternatives; when unsure, ask the buyer to confirm before model-dependent checks.
4. Run four checks in parallel: **Fit, Price, Comfort, Condition**.
5. Let Gemini follow up to 2 bounded **leads** when something looks off.
6. Decide the verdict with **deterministic rules**; Gemini writes the wording, citing evidence.
7. Generate **next moves**: questions for the seller and a before-you-pay checklist.
8. Support **reopening** a case with new evidence, rerunning only affected checks and reporting what changed.

**Core principles**
- Language and vision models handle messy inputs. Plain code handles anything that must be exact: sizes, prices, verdict labels.
- Every verdict cites evidence. Missing evidence produces `unknown` and a seller question, never a guess.
- Every price claim states its source and date.
- No scraping. The backend only processes what the user captured on a page they chose to investigate.

**Demo category:** trainers. Category-specific knowledge lives in data, not in pipeline code.

### In scope
- Investigation pipeline, verdict, next moves, reopen, case history summaries.
- Seeded feed endpoint and a share opt-in flag (the Feed is a mock feature).
- Optional "out-sleuthed" badge on qualifying verdicts.

### Non-goals
- No frontend or extension code.
- No marketplace APIs, scrapers or crawling of marketplace pages.
- No user accounts. The user's profile lives in the extension and is sent with each request.
- No messaging sellers, making offers, watching listings, comparing multiple listings, or automatic page detection (vision-slide features only).
- No price data beyond the two sources in section 7.5.

---

## 2. Tech stack

| Concern | Choice |
| --- | --- |
| Runtime | Node.js 20.19+ / 22.12+ (Prisma 7 requirement) |
| Language | TypeScript, `strict: true` |
| API | Next.js App Router **route handlers only** (`app/api/**/route.ts`) |
| AI | Google Gemini via the official `@google/genai` SDK |
| Validation | Zod: every model output and every API input |
| Database | PostgreSQL on **Neon** (hosted), via **Prisma 7** with the Neon driver adapter |
| Streaming | Server-sent events (SSE) |
| Tests | Vitest |
| Scripts | `tsx` |

**Check current docs before implementing**, as these change often:
- Gemini: current model names, structured output config, Google Search grounding and its metadata, object detection prompting (bounding boxes), function calling, and whether built-in tools can be combined with function calling for the chosen model.
- Prisma 7 with Neon: in Prisma 7 the connection URL is configured in `prisma.config.ts`, not in `schema.prisma`; the client is created with the Neon adapter; `PrismaClient` is imported from the generated output path, not `@prisma/client`. Follow Neon's current Prisma guide.

Model names must never be hard-coded. Read them from env vars.

---

## 3. Repository layout

```
/app/api
  /cases/route.ts                    POST create case
  /cases/summaries/route.ts          GET summaries for a list of case IDs (history)
  /cases/[id]/route.ts               GET full case
  /cases/[id]/stream/route.ts        GET SSE investigation stream
  /cases/[id]/reopen/route.ts        POST new evidence
  /cases/[id]/share/route.ts         POST share opt-in
  /cases/[id]/images/[index]/route.ts GET stored listing image
  /feed/route.ts                     GET seeded feed
/pipeline
  index.ts                           runInvestigation(), reopenCase()
  events.ts                          per-case event buffer + SSE serialisation
  intake.ts                          validate capture, download images, platform detection
  extract.ts                         listing facts (Gemini, text + vision)
  needs.ts                           merge profile + optional note into UserNeeds
  identify.ts                        product identification + gate
  checks/fit.ts                      pure code
  checks/price.ts                    sampled comparisons (code) + new price (Gemini grounding)
  checks/comfort.ts                  Gemini + Google Search grounding
  checks/condition.ts                Gemini vision object detection
  leads.ts                           bounded follow-up investigations
  verdict/rules.ts                   pure code decision table
  verdict/wording.ts                 Gemini wording + evidence validator
  nextMoves.ts                       seller questions + before-you-pay checklist
  reopen.ts                          classify new evidence, rerun affected checks, diff
/gemini
  client.ts                          SDK client, model selection, retries, timeouts, call log
  structured.ts                      generateStructured<T>(schema, ...) helper
  tools.ts                           function declarations + local executors
  grounding.ts                       grounding metadata -> Evidence
/schemas                             Zod schemas + inferred types (shared with frontend)
/lib
  db.ts                              Prisma client with Neon adapter
  sizes.ts                           convertSize()
  priceSample.ts                     sampleStats() with outlier rule
  catalogue.ts                       getCatalogueCandidates()
  platform.ts                        detectPlatform(url)
  safeFetch.ts                       image download with SSRF protections
  redact.ts                          strip seller identity from text
  hash.ts, cache.ts                  record/replay cache
  cors.ts                            extension-origin CORS
/data                                seed JSON + reference images + sampling log
/prisma/schema.prisma
/prisma.config.ts
/scripts/seed.ts
/eval
  /listings                          labelled test captures
  run.ts                             accuracy report
/tests
```

---

## 4. Environment variables

```
# Database (Neon)
DATABASE_URL=                 # pooled connection, used by the app at runtime
DATABASE_URL_UNPOOLED=        # direct connection, used by Prisma CLI (migrations)

# Gemini
GEMINI_API_KEY=
GEMINI_MODEL_FAST=            # extraction, checks, wording, next moves
GEMINI_MODEL_STRONG=          # identification and recheck leads
GEMINI_COMBINED_TOOLS=false   # true = Search grounding + function calling in one call, if supported

# Pipeline
IDENTIFY_CONFIDENCE_MIN=0.75
MAX_LEADS=2
STAGE_TIMEOUT_MS=25000
MAX_IMAGES=8
MAX_IMAGE_BYTES=8000000
PIPELINE_VERSION=2            # part of cache key; bump when prompts/rules change
CACHE_MODE=off                # off | record | replay

# Extension
ALLOWED_EXTENSION_ORIGINS=    # comma-separated chrome-extension://<id> origins
ALLOWED_WEB_ORIGINS=          # fallback upload page origin(s)
```

`.env` is gitignored. Provide `.env.example` with these keys and no values.

---

## 5. Domain schemas (Zod, in `/schemas`)

All types are inferred from Zod schemas and exported for the frontend.

```ts
Platform = "vinted" | "facebook" | "ebay" | "depop" | "other"

// What the extension (or upload page) sends
Capture = {
  pageUrl?: string,                 // listing URL, used only for platform detection and display
  pageText?: string,                // visible text of the listing, max 20,000 chars
  imageUrls?: string[],             // listing image URLs found on the page, max MAX_IMAGES
  // screenshots arrive as multipart files alongside this JSON
}

// Saved in the extension, sent with every case
Profile = {
  sizes: { brand: string, size: number, system: "UK" | "US" | "EU" }[],
  priorities: string[],             // e.g. ["all-day comfort", "wide fit"]
  budgetGBP?: number,
  wearTolerance: "none" | "light" | "moderate" | "any",
}

UserNeeds = Profile & {
  caseNote?: string,                // optional per-case note
  extraPriorities: string[],        // parsed from caseNote
  assumptions: string[],            // e.g. "Size system not stated; assumed UK"
}

Evidence = {
  id: string,                       // stable within a case, e.g. "ev_cond_1"
  kind: "quote" | "photo_region" | "data_point" | "source",
  label: string,
  quote?: string,                   // exact text from the listing or seller reply
  photoIndex?: number,
  box2d?: [number, number, number, number], // [ymin, xmin, ymax, xmax], normalised 0-1000
  value?: string | number,
  url?: string, title?: string,
  sourceType?: "independent_review" | "manufacturer" | "retailer" | "price_sample" | "other",
  observedOn?: string,              // ISO date, required for price evidence
}

ListingFacts = {
  title?: string,
  brandText?: string,
  modelText?: string,
  sizeText?: string,
  sizeSystem?: "UK" | "US" | "EU" | "unknown",
  priceGBP?: number,
  platform: Platform,
  conditionClaims: string[],        // seller's own words
  photoCount: number,
  evidence: Evidence[],
}

IdentifyResult = {
  catalogueModelId: string | null,
  confidence: number,
  reasons: string,
  evidence: Evidence[],
}

CheckName = "identify" | "fit" | "price" | "comfort" | "condition"

GeminiFeature = "vision" | "object_detection" | "search_grounding" | "function_calling" | "structured_output"

CheckResult = {
  check: CheckName,
  status: "pass" | "warn" | "fail" | "unknown",
  summary: string,                  // one plain sentence
  evidence: Evidence[],
  confidence: number,               // 0-1
  geminiFeatures: GeminiFeature[],  // shown as tags in the UI
  details?: Record<string, unknown>,// check-specific, see section 7
}

DefectLabel = "outsole_wear" | "heel_wear" | "upper_creasing" | "stitching_damage"
            | "discolouration" | "tear_or_hole" | "sole_separation" | "dirt_or_staining"

ConditionFinding = {
  label: DefectLabel,
  photoIndex: number,
  box2d: [number, number, number, number],
  severity: "minor" | "moderate" | "major",
  confidence: number,               // < 0.6 is presented as "possible"
  note: string,
  evidenceId: string,
}

VerdictLabel = "hidden_gem" | "worth_a_look" | "proceed_with_caution"
             | "overpriced" | "wrong_fit" | "not_enough_evidence"

Verdict = {
  label: VerdictLabel,
  ruleId: string,
  headline: string,                 // detective one-liner
  explanation: string,              // 2-4 sentences
  citedEvidenceIds: string[],
  confidence: number,
  badge: "out_sleuthed" | null,     // optional fun badge, see 7.8
}

Lead = {
  id: string,
  type: "deeper_price_comparison" | "recheck_identification" | "recheck_condition_photo" | "flag_for_seller",
  reason: string,
  status: "pending" | "done" | "skipped" | "failed",
  outcome?: string,
}

NextMove = {
  id: string,
  kind: "ask_seller" | "before_you_pay",
  text: string,                     // copy-ready, polite, never accusatory
  relatesTo: CheckName[],
}

CaseDiff = {
  fromRevision: number,
  toRevision: number,
  checks: { check: CheckName, before: string, after: string, reason: string }[],
  verdict: { before: VerdictLabel, after: VerdictLabel },
}

CaseSummary = {
  id: string, revision: number, title?: string, priceGBP?: number,
  platform: Platform, verdictLabel?: VerdictLabel, thumbnailUrl?: string, updatedAt: string,
}
```

---

## 6. Database (Prisma 7, PostgreSQL on Neon)

`prisma/schema.prisma` (no `url` in the datasource block; connection configured in `prisma.config.ts`, which points the CLI at `DATABASE_URL_UNPOOLED`; the runtime client uses the Neon adapter with `DATABASE_URL`):

```prisma
datasource db {
  provider = "postgresql"
}

model Case {
  id           String   @id @default(cuid())
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt
  status       String   // "open" | "investigating" | "closed" | "error"
  platform     String
  pageUrl      String?
  revision     Int      @default(1)
  inputHash    String
  needs        Json     // UserNeeds snapshot for this case
  listingFacts Json?
  identify     Json?
  verdict      Json?
  nextMoves    Json?
  shareOptIn   Boolean  @default(false)
  inputs       CaseInput[]
  checks       CheckRecord[]
  leads        LeadRecord[]
  @@index([updatedAt])
}

model CaseInput {
  id        String   @id @default(cuid())
  caseId    String
  case      Case     @relation(fields: [caseId], references: [id], onDelete: Cascade)
  revision  Int
  kind      String   // "image" | "page_text" | "seller_reply"
  mimeType  String?
  data      Bytes?   // image bytes (demo scale; move to object storage later)
  text      String?
  sourceUrl String?  // original image URL if downloaded
  createdAt DateTime @default(now())
}

model CheckRecord {
  id        String   @id @default(cuid())
  caseId    String
  case      Case     @relation(fields: [caseId], references: [id], onDelete: Cascade)
  revision  Int
  check     String
  result    Json     // CheckResult
  createdAt DateTime @default(now())
  @@index([caseId, revision])
}

model LeadRecord {
  id       String @id @default(cuid())
  caseId   String
  case     Case   @relation(fields: [caseId], references: [id], onDelete: Cascade)
  revision Int
  lead     Json
}

model CatalogueModel {
  id           String  @id          // e.g. "nike-pegasus-40"
  brand        String
  name         String
  aliases      Json                 // string[]
  retailGBP    Float?
  referenceImg String?              // path under /data/images/catalogue
  sizeChartId  String
}

model SizeChart {
  id    String @id
  brand String
  rows  Json                        // [{ uk, us, eu, cm }]
}

model PriceSample {
  id          String   @id @default(cuid())
  modelId     String
  priceGBP    Float
  condition   String                // "new_with_tags" | "like_new" | "good" | "worn"
  platform    String
  collectedOn DateTime
  ruleId      String                // which sampling rule produced it (see 11)
  @@index([modelId])
}

model ReviewSnippet {               // fallback only, when grounding fails
  id         String @id @default(cuid())
  modelId    String
  text       String
  url        String
  title      String
  sourceType String
  topics     Json
}

model CacheEntry {
  key       String   @id
  value     Json
  createdAt DateTime @default(now())
}
```

Never store seller usernames, profile photos, seller ratings text or any other seller identity. Never store user identity. Page text is redacted (section 7.1) before it is stored or sent to Gemini.

---

## 7. Pipeline

### 7.1 Intake (`intake.ts`)
1. Validate the request (section 8). At least one of: screenshots, `imageUrls`, `pageText`.
2. `detectPlatform(pageUrl)` from the hostname; default `other`.
3. **Image download** (`safeFetch.ts`) for `imageUrls`:
   - HTTPS only; resolve DNS and reject private, loopback and link-local addresses; no redirects to other hosts; 5 s timeout; `MAX_IMAGE_BYTES` limit; only `image/jpeg|png|webp` content types.
   - Download at most `MAX_IMAGES`, de-duplicated. Failures are skipped, not fatal.
   - If no image could be downloaded and screenshots were provided, use the screenshots. If neither, continue text-only (condition will be `unknown`).
4. **Redaction** (`redact.ts`): remove obvious seller identity from `pageText` (lines near "seller", "member since", usernames with @, profile/rating blocks). The extension also redacts; this is a second layer. The extract prompt must also ignore seller identity.
5. Downscale images over ~2000 px on the long edge before storing and sending.
6. Compute `inputHash` (content of images + text + needs + `PIPELINE_VERSION`) for caching.

### 7.2 Orchestration (`index.ts`)

```ts
async function runInvestigation(caseId, emit) {
  emit("investigation_started")
  const [facts, needs] = await Promise.all([extractListing(c), buildNeeds(c.profile, c.caseNote)])

  const identify = await identifyProduct(facts, images)   // always a bestGuess + confidenceLevel (7.5)
  emit("check_done", identifyCheck)
  // possible / best_guess: run condition and fit, then pause for the buyer to confirm (7.5). Never stop at "unknown model".

  // Four checks in parallel. Emit each as it resolves. A rejection becomes an `unknown` result.
  const checks = await settleAndEmit([
    checkFit(facts, needs, identify),
    checkPrice(facts, identify, needs),
    checkComfort(identify, needs),
    checkCondition(images, facts, needs),
  ])

  const leads = await followLeads(caseId, checks, MAX_LEADS)   // may update checks via executors
  return finalise(caseId, checks, leads)
}

async function finalise(caseId, checks, leads = []) {
  const verdict = await decideAndWordVerdict(checks)
  const nextMoves = await generateNextMoves(checks, leads, verdict)
  persist(...)
  emit("verdict", verdict); emit("next_moves", nextMoves); emit("investigation_done")
}
```

Each stage has `STAGE_TIMEOUT_MS`. Timeouts and errors produce `unknown` results with a plain explanation; the investigation always reaches a verdict.

### 7.3 Extract (`extract.ts`): Gemini, `GEMINI_MODEL_FAST`
- Inputs: redacted page text + images.
- Output: `ListingFacts` via structured output.
- Rules: extract only what is written or visible; leave fields empty rather than guess; each fact gets an Evidence entry (`quote` for text, `photo_region` for something read from an image, e.g. a size label); never extract seller identity; ignore page navigation, ads and "similar items" sections (instruct the model to focus on the main listing).
- `geminiFeatures`: `["vision", "structured_output"]`.

### 7.4 Needs (`needs.ts`)
- Start from the `Profile` sent by the extension.
- If `caseNote` is present, Gemini (`GEMINI_MODEL_FAST`) parses it into `extraPriorities` and any overrides (e.g. a different budget for this purchase).
- Missing size system → assume UK and record it in `assumptions`.

### 7.5 Identify (`identify.ts`): Gemini vision, `GEMINI_MODEL_STRONG`
1. `getCatalogueCandidates(facts)`: shortlist by brand and alias text match; if none, the whole catalogue (15-20 models).
2. Send listing images + up to 5 candidate reference images + candidate names.
3. Output `IdentifyResult` with a `bestGuess`, up to 2 `alternatives` and a `confidenceLevel` (`confirmed` | `likely` | `possible` | `best_guess`). The model never returns "no model" when the brand is known; brand-only only when it can't suggest any model, with the reason.
4. **No gate.** The earlier rule here (unclear → every other check `unknown`, verdict `not_enough_evidence`) is superseded. Low confidence means: Google Lens for more evidence, then pause for the buyer to confirm before model-dependent steps, while condition and fit run. Full rules: "Identification when the model isn't clear" in `CLAUDE.md`. The seller question asks for the tongue or size label photo.
- `geminiFeatures`: `["vision", "structured_output"]`.

### 7.6 Checks

**Fit (`checks/fit.ts`): pure code**
- `convertSize(listingSize, listingSystem, brandChart)`; compare with the user's size for the identified brand.
- No size for that brand in the profile → convert via another brand's chart (cm) and set `warn`, saying it's a cross-brand estimate.
- No size in the listing → `unknown` (becomes a seller question).
- Mismatch → `fail`. Exact → `pass`. Half-size off → `warn`.
- `details`: `{ listed, listedSystem, userSize, match: "exact" | "close" | "mismatch" | "estimated" }`.

**Price (`checks/price.ts`): two sources only**

Source A, **sampled listings** (code):
- `sampleStats(modelId, condition?)` from `PriceSample`: `{ n, median, p10, p25, p75, p90, collectedOn: { from, to } }`.
- Outlier rule (code, documented): exclude samples above 3× or below ⅓ of the median before computing.
- Requires `n ≥ 5`; otherwise Source A is unavailable.
- Evidence label must read like: "Compared with 12 listings sampled on 10 Nov" (`sourceType: "price_sample"`, `observedOn` set).
- **Maximum confidence 0.7** (small, dated sample).

Source B, **current new price** (Gemini + Google Search grounding):
- Ask for the current new retail price of the identified model in the UK, with sources.
- Parse grounding metadata into `source` Evidence with `sourceType: "retailer"` and `observedOn` = today.
- Accept only if at least 2 sources agree within 15%; otherwise Source B is unavailable.
- **Never use grounding for second-hand prices.**

Status:
- Neither source available → `unknown` ("I couldn't find reliable price comparisons for this model").
- Listing price ≥ current new price (B) → `fail` ("costs as much as buying new").
- Price > p90 (A) → `fail` ("well above the sampled listings").
- Price < p10 (A) → `warn` ("unusually low; check condition and details").
- Price ≤ p25 (A), or ≤ 60% of new price (B) when A is unavailable → `pass`, position `below`.
- Otherwise → `pass`, position `typical`.
- Over the user's budget → at least `warn`.
- `details`: `{ sample?: stats, newPrice?: { gbp, sources: n }, position: "below" | "typical" | "above" | "suspiciously_low" | "at_or_above_new" }`.
- `geminiFeatures`: `["search_grounding"]` when Source B is used, plus `["function_calling"]` when called via tools (7.8).

**Comfort (`checks/comfort.ts`): Gemini + Google Search grounding, `GEMINI_MODEL_FAST`**
- Query about the identified model against the user's priorities (comfort for long wear, width, sizing advice, durability).
- Parse grounding metadata into `source` Evidence, keeping URL, title and the exact text segment each source supports.
- Classify each source as `independent_review`, `manufacturer`, `retailer` or `other` (domain heuristics plus model hint). Manufacturer claims can never be the only support for `pass`.
- Fewer than 2 independent sources → `warn` (or `unknown` if none).
- Sizing advice from reviews (e.g. "runs small") is passed to the fit check's `details.reviewSizingNote` and may turn a fit `pass` into `warn`.
- Fallback: if grounding fails, use `ReviewSnippet` rows (same Evidence shape, confidence capped at 0.6).
- `geminiFeatures`: `["search_grounding"]`.

**Condition (`checks/condition.ts`): Gemini vision object detection, `GEMINI_MODEL_FAST`**
- Detect **defects, not objects**, using only `DefectLabel`. Boxes as `[ymin, xmin, ymax, xmax]` normalised 0-1000, per photo.
- Prompt notes: shadows, dirt and lighting can resemble damage; lower confidence when unsure; list areas not visible in any photo (e.g. "inside lining", "heel close-up") in `notVisible`.
- Compare with `conditionClaims`; record contradictions ("described as like new; moderate outsole wear visible").
- Status (respecting `wearTolerance`): any `major` → `fail`; any `moderate` or a contradiction → `warn`; minor only or none → `pass`; no usable images → `unknown`.
- `details`: `{ findings: ConditionFinding[], notVisible: string[], contradictions: string[] }`.
- `geminiFeatures`: `["vision", "object_detection", "structured_output"]`.

### 7.7 Leads (`leads.ts`): Gemini decides, code executes
- Gemini receives a compact summary of the check results and the allowed lead types; returns up to `MAX_LEADS` with reasons, or none.
- Executors:
  - `deeper_price_comparison`: recompute Source A restricted to the listing's condition grade, and run Source B if it wasn't run. Update the price check.
  - `recheck_identification`: rerun identify with `GEMINI_MODEL_STRONG` on the single clearest photo; if the model changes, rerun downstream checks.
  - `recheck_condition_photo`: rerun condition on one photo with a narrower defect list.
  - `flag_for_seller`: no compute; guarantees a seller question for that gap.
- Leads change results only through executors. Emit `lead_started` and `lead_done`. Persist as `LeadRecord`.

### 7.8 Function calling (`/gemini/tools.ts`)
Declare as Gemini function tools; the app executes them and returns results:
- `convertSize({ brand, size, system })`
- `sampleStats({ modelId, condition? })`
- `getCatalogueCandidates({ brandText?, modelText? })`

Used in leads and in the price/comfort stages so Gemini can request exact facts while reasoning. If `GEMINI_COMBINED_TOOLS=true` and the model supports combining Google Search with function calling, run price Source B and comfort as single calls with both. Otherwise (default), run grounding and function calls separately and merge in code. **Both paths must produce identical output shapes.**

### 7.9 Verdict (`verdict/rules.ts`, `verdict/wording.ts`)
Rules evaluated in order; first match wins.

| ruleId | Condition | Label |
| --- | --- | --- |
| R1 | not even the brand is known | `not_enough_evidence` |
| R2 | fit = fail | `wrong_fit` |
| R3 | price = fail | `overpriced` |
| R4 | condition = fail | `proceed_with_caution` |
| R5 | any check = warn or unknown | `proceed_with_caution` |
| R6 | all pass AND price position = below AND no condition finding above minor | `hidden_gem` |
| R7 | otherwise | `worth_a_look` |

- **Badge:** `out_sleuthed` when the label is `hidden_gem` and every check's confidence ≥ 0.7 except price, which may be ≥ 0.6. Otherwise `null`.
- **Wording:** Gemini writes `headline` (sceptical detective voice, short) and `explanation` (2-4 sentences) and returns `citedEvidenceIds`.
- **Validator:** every cited ID exists; every `fail`/`warn` check is mentioned; no facts beyond the evidence; price claims mention their source; banned words in all generated text: "scam", "fake", "fraud", "liar", "rip-off", "guaranteed". On failure: retry once with the error, then use a deterministic template per label.
- Gemini never chooses or changes the label.

### 7.10 Next moves (`nextMoves.ts`): Gemini, `GEMINI_MODEL_FAST`
- One `ask_seller` question per `unknown`/`warn` check and per `flag_for_seller` lead, plus one per `notVisible` area that matters for the verdict. Polite, specific, copy-ready, max 3 questions total, ordered by importance.
- For `hidden_gem` and `worth_a_look`: 2-3 `before_you_pay` items (pay through the platform for buyer protection, check the returns policy, save the listing).
- Same banned-words validator as the verdict.

### 7.11 Reopen (`reopen.ts`)
- Input: new screenshots/image URLs and/or seller reply text (captured by the extension from the conversation page). Increments `revision`.
- Affected checks:
  - New image → `condition` (and `identify` if Gemini sees a label or tag in it).
  - Seller reply → extract facts from the reply and merge into `ListingFacts`; size → fit; price → price; condition statements → condition; model name → identify.
- If identify changes, rerun all downstream checks. Otherwise rerun only affected checks.
- Recompute verdict and next moves (questions already answered are dropped).
- Emit `case_reopened`, normal events, then `diff` (`CaseDiff`).

---

## 8. API contract (for the frontend and extension)

All requests and responses are validated with schemas from `/schemas`.

**CORS:** allow only origins in `ALLOWED_EXTENSION_ORIGINS` and `ALLOWED_WEB_ORIGINS`; handle `OPTIONS` preflight; methods `GET, POST`.

**Abuse limits:** simple in-memory rate limit per IP (e.g. 20 case creations per hour). Case IDs are unguessable cuids; there is no other auth.

### `POST /api/cases`
`multipart/form-data`:
- `capture`: JSON string, `Capture`
- `profile`: JSON string, `Profile`
- `caseNote?`: string
- `screenshots[]?`: 0-6 image files (png/jpg/webp, ≤ `MAX_IMAGE_BYTES` each)

At least one screenshot, image URL or page text is required.
→ `201 { caseId }`. The investigation starts immediately; events are buffered per case so a late stream subscriber misses nothing.

### `GET /api/cases/:id/stream` (SSE)

| Event | Data |
| --- | --- |
| `investigation_started` | `{ caseId, revision }` |
| `stage_started` / `stage_done` | `{ stage, geminiFeatures? }` |
| `capture_warning` | `{ message }` e.g. "Only 1 photo could be loaded" |
| `check_done` | `CheckResult` |
| `lead_started` / `lead_done` | `Lead` |
| `verdict` | `Verdict` |
| `next_moves` | `NextMove[]` |
| `case_reopened` | `{ caseId, revision }` |
| `diff` | `CaseDiff` |
| `investigation_done` | `{ caseId, revision, durationMs, geminiCalls }` |
| `error` | `{ stage?, message }` (non-fatal unless the case status becomes `error`) |

Send a keep-alive comment every 15 s. Late subscribers receive the buffered events for the current revision.

### `GET /api/cases/:id`
→ `{ id, revision, status, platform, pageUrl, listingFacts, needs, identify, checks: CheckResult[], leads: Lead[], verdict, nextMoves, evidenceIndex: Record<id, Evidence>, imageUrls: string[], history: { revision, verdictLabel, at }[] }`
Images served via `GET /api/cases/:id/images/:index`.

### `GET /api/cases/summaries?ids=a,b,c`
The extension stores case IDs locally for History. → `CaseSummary[]` (max 50 IDs).

### `POST /api/cases/:id/reopen`
`multipart/form-data`: `capture?` (JSON `Capture`, e.g. seller reply page text or new image URLs), `sellerReply?` (string), `screenshots[]?`.
→ `202 { caseId, revision }`. Progress on the same stream.

### `POST /api/cases/:id/share`
`{ optIn: boolean }`. Allowed only when the current verdict is `hidden_gem`. → `200 { shareOptIn }`.

### `GET /api/feed?brand=&size=&system=`
Seeded from `/data/feed.json` (mock feature). Filters to items that fit the given size via size charts. → `FeedItem[]`: `{ caseId, modelName, priceGBP, platform, verdictLabel: "hidden_gem", oneLineEvidence, priceSource: string, checkedAt }`. No seller or user identity.

---

## 9. Gemini client (`/gemini/client.ts`, `structured.ts`)
- One `GoogleGenAI` client; per-call model tier `fast` | `strong`.
- `generateStructured<T>(zodSchema, { tier, parts, tools? })`: sends the JSON schema through the SDK's structured output config, parses, validates. Invalid output → one retry with the validation error appended → otherwise throw.
- Retry once with backoff on 429/5xx.
- Images sent inline with correct MIME types.
- Log per call: case, stage, model, latency, token usage if returned. Totals are reported in `investigation_done`.

---

## 10. Cache and demo mode (`/lib/cache.ts`)
- Key: `hash(stage, model, normalised inputs, PIPELINE_VERSION)`; images hashed by content.
- `record`: call Gemini and store. `replay`: serve stored results; on a miss, call live and record.
- Replay emits events with realistic delays (300-900 ms per stage) so the stream looks live.
- Purpose: the stage demo must not depend on network or rate limits.

---

## 11. Seed data (`/data`, loaded by `scripts/seed.ts`)

```
catalogue.json        [{ id, brand, name, aliases[], retailGBP, referenceImg, sizeChartId }]
sizecharts.json       [{ id, brand, rows: [{ uk, us, eu, cm }] }]
price-samples.json    [{ modelId, priceGBP, condition, platform, collectedOn, ruleId }]
sampling-rules.md     the written sampling rules (see below)
reviews.json          [{ modelId, text, url, title, sourceType, topics[] }]   // fallback only
feed.json             [FeedItem]
/images/catalogue/    reference images
```

**Sampling rules for `price-samples.json`** (must be followed and documented in `sampling-rules.md`):
- For each catalogue model and each platform, search the model name and record the **first N listings sorted by newest**, regardless of price or condition (rule `R-newest-N`).
- Record price, condition, platform and collection date for every entry. No seller details.
- Collect samples **before** choosing demo listings.
- Do not hand-remove entries; outliers are removed only by the code rule in 7.6.

The seed script is idempotent (upsert) and validates every file with Zod, failing loudly on invalid data.

---

## 12. Evaluation (`/eval`)
- `eval/listings/<id>/` holds a captured listing (`capture.json`, images) and `label.json` (schema: `eval/labels.ts`; guide: `eval/LABELLING.md`). The label gives the model the pair really is, researched if the listing doesn't say, never `null` to mean "Sleuth should refuse".
- `eval/run.ts` runs the pipeline (respecting `CACHE_MODE`) and writes `eval/report.md`:
  - identification accuracy: top-1 and top-3, by confidence level; brand-only counts as wrong. The eval never pauses (it carries on with the best guess) and reports how often it would have paused.
  - fit and price agreement with labels
  - verdict agreement where `expectedVerdict` is set
  - average duration and Gemini calls per case
- These numbers may appear on a pitch slide. Report them exactly; never round favourably.

---

## 13. Responsible AI requirements (enforced in code)
- Verdict labels come from rules only.
- Every verdict and next move passes the validator; every verdict cites existing evidence.
- Missing evidence → `unknown` → seller question.
- Condition findings below 0.6 confidence are marked "possible".
- Every price claim states its source (sampled listings with date, or current new price with sources). Sampled-price confidence is capped at 0.7.
- Banned-words list applies to all generated text.
- Seller identity is redacted before storage and before any Gemini call. No user identity is stored.
- Images are only fetched from URLs the user's own capture provided, through `safeFetch`. No crawling.
- Feed items are opt-in, `hidden_gem` only, with no identities.

---

## 14. Testing
- **Unit:** `convertSize`, `sampleStats` + outlier rule, price status table, verdict rules (one test per rule plus ordering), badge rule, evidence validator, banned words, `detectPlatform`, `redact`, `safeFetch` address blocking, affected-check mapping for reopen, diff.
- **Schema:** every Zod schema round-trips fixtures.
- **Pipeline with fixtures:** a mocked Gemini client with recorded responses; cover every confidence level and the pause for confirmation, a rejected check becoming `unknown`, the lead limit, reopen rerunning only affected checks, and the combined-tools flag producing identical shapes.
- **API:** CORS preflight, rejection of requests with no capture content, share refused for non-`hidden_gem`.
- No live Gemini calls in tests.

---

## 15. Build order and acceptance criteria

1. **Neon + Prisma 7 setup, schemas, seed.** `npx prisma migrate dev` succeeds against Neon; `npm run seed` loads all data with Zod validation.
2. **Gemini client + `generateStructured`.** Validated JSON from a test call; retry path tested.
3. **Intake.** Platform detection, safe image download, redaction, hashing; tested.
4. **Extract + needs.** A captured Vinted page (text + images) produces valid `ListingFacts` and `UserNeeds` with evidence and no seller identity.
5. **Identify.** Correct model on clear eval listings; on an ambiguous one, a best guess at `possible` or `best_guess` with alternatives, never `null`.
6. **Fit + price Source A.** Pure functions with full tests.
7. **Verdict rules, badge, wording, validator.** All rules tested; template fallback works.
8. **Orchestrator, SSE, CORS, API routes.** End-to-end run from `POST /api/cases` with the stream delivering events incrementally to a test client.
9. **Condition.** Boxes in 0-1000 format on real listing photos; `notVisible` and contradictions populated.
10. **Comfort + price Source B with grounding.** Sources parsed with types and dates; `ReviewSnippet` fallback works.
11. **Next moves.**
12. **Leads + function calling,** including the combined-tools flag and fallback.
13. **Reopen + diff + summaries endpoint.**
14. **Cache record/replay.** Full demo run in replay mode with no network.
15. **Eval script and report.**
16. **Feed and share endpoints** (seeded).

After step 8, the API contract in section 8 is frozen; the frontend depends on it. Run the tests after every step.
