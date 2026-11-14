# Sleuth backend

A sceptical second opinion before you buy second-hand trainers. The Chrome extension captures a listing and sends it here.
The backend runs an **investigation**: it reads the listing, identifies the model, runs the fit, price, comfort and condition checks,
and follows up bounded leads. It then returns a rule-decided **verdict with evidence** and **next moves**.

This repo is the backend only. The spec is in `SLEUTH_BACKEND_SPEC.md`. The API and data contracts are the Zod schemas in [`schemas/`](schemas/), which the frontend imports.

## Quick start

```bash
npm install                    # also runs `prisma generate`
cp .env.example .env.local     # fill in values (Neon, Gemini model names, extension origin)
npm run db:deploy              # apply migrations (or `npm run db:migrate:https`, see below)
npm run seed                   # load /data into Neon (idempotent, Zod-validated)
npm run dev                    # http://localhost:3000/api/...
npm test                       # unit, schema, pipeline and API tests (mocked Gemini, no network)
```

Model names are never hard-coded. Set `GEMINI_MODEL_FAST` (extraction, checks, wording, next moves) and `GEMINI_MODEL_STRONG`
(identification, recheck leads) to current Gemini model ids. `GEMINI_COMBINED_TOOLS=true` runs price Source B and comfort as one call
with Google Search plus function calling (Gemini 3 tool combination, sent with `includeServerSideToolInvocations`). Both paths produce
identical output shapes; a test checks this.

`SEARCH_TIMEOUT_MS` (default `10000`) caps the comfort check's Google Search grounded step. Past the cap the search is
aborted and comfort falls back to the saved review snippets. `STAGE_TIMEOUT_MS` still bounds each stage as a whole.

The price check's current new price (Source B) comes from Google Shopping via SerpApi (`SHOPPING_API_KEY`), not from
grounding. `lib/newPrices.ts` queries `"{brand} {model}"` with UK results, then filters in code: retailers only (no
eBay, Vinted, Depop, StockX, GOAT and similar), the exact model and version, no accessories or kids' versions, GBP prices,
one offer per retailer. It needs at least 3 offers, and the new price is their median. Responses are cached in `CacheEntry`
for 24 hours, and `CACHE_MODE=replay` serves them without calling the API. Each live call is logged as
`[shopping] q=... raw=N kept=M` (the key is never logged) so the free quota can be tracked.

Without `DATABASE_URL`, the app falls back to an in-memory store seeded from `/data`. This is useful for local work, but it isn't persistent.

### Neon on networks that block port 5432

The runtime client uses the Neon serverless driver over WebSockets (port 443), so the app works anywhere. The Prisma CLI needs
Postgres port 5432. Venue Wi-Fi often blocks that port, which shows up as `P1001: Can't reach database server`. In that case:

```bash
npx prisma migrate diff --from-migrations prisma/migrations --to-schema prisma/schema.prisma --script \
  > prisma/migrations/<timestamp>_<name>/migration.sql     # create a new migration without a DB connection
npm run db:migrate:https                                   # apply pending migrations over 443
```

`db:migrate:https` records each migration in `_prisma_migrations` with Prisma's checksum, so `prisma migrate deploy/status` agree
afterwards. The seed script also runs over 443.

## Chrome extension (side panel)

`extension/` is the side panel client. It imports the Zod schemas from `schemas/` and validates every response and SSE event against
them, so a contract change shows up as a type error in the extension.

```bash
npm run ext:build              # or ext:watch; output in extension/dist
```

1. In Chrome, open `chrome://extensions`, turn on Developer mode, choose **Load unpacked** and select `extension/dist`.
2. The manifest `key` fixes the ID at `appjiengjbolgmppilkllgmnmoogpiej`. Put `chrome-extension://appjiengjbolgmppilkllgmnmoogpiej` in
   `ALLOWED_EXTENSION_ORIGINS`, or the API answers `403`.
3. Click the toolbar icon to open the panel. The server address (default `http://localhost:3000`) is under **Profile → Server**.

Flow: Profile (stored in `chrome.storage.local`) → Case ready (reads the active tab only via `chrome.scripting`) → `POST /api/cases` →
live log from `/stream` → `GET /api/cases/:id` for the case file → **Add evidence** posts to `/reopen` and shows what changed from the `diff` event.
Vinted, eBay, Facebook and Depop are pre-permitted. Other sites ask for access on first use.

`extension/dist/preview.html` shows the five screens and all six verdict treatments side by side, rendered from fixture data with
the shipping components. It opens straight from disk.

## Scripts

| Script | What it does |
| --- | --- |
| `npm run dev` / `build` / `start` | Next.js (route handlers only) |
| `npm test` | Vitest. `RUN_DB_TESTS=1 npx vitest run tests/db.integration.test.ts` runs one end-to-end case against Neon and cleans up after itself |
| `npm run seed` | Validate every `/data` file with Zod, then upsert. Prints a warning while placeholder price samples are present |
| `npm run eval` | Run `eval/listings/*` through the pipeline and write `eval/report.md` |
| `npm run db:deploy` / `db:migrate` / `db:migrate:https` | Prisma migrations |
| `npx tsx scripts/placeholder-samples.ts` | Regenerate the placeholder price samples |

## Demo mode (record / replay)

`CACHE_MODE=record` stores every Gemini response and downloaded image under `data/cache/`, and in the `CacheEntry` table when a database
is configured. `CACHE_MODE=replay` serves those with realistic 300–900 ms delays, so the stage demo doesn't depend on the network or rate
limits. Cache misses fall through to a live call and are recorded. Keys are `hash(stage, model, normalised inputs, PIPELINE_VERSION)`,
with images hashed by content. Bump `PIPELINE_VERSION` when prompts or rules change. For a fully offline demo, unset `DATABASE_URL` too:
the in-memory store plus the file cache need no network.

## Layout

```
app/api/**/route.ts   HTTP layer (thin): CORS, validation, status codes
pipeline/             index (create + run), core (finalise), runChecks, intake, extract, needs, identify,
                      checks/{fit,price,comfort,condition}, leads, verdict/{rules,wording,validate}, nextMoves,
                      reopen, events (SSE hub), views (detail/summaries/feed), deps (DI), util
gemini/               client (tiers, retry, cache, call log), structured, tools, grounding
lib/                  pure utilities, stores (memory + Prisma/Neon), cache, safeFetch, redact, cors, http
schemas/              Zod schemas + inferred types (shared with the frontend)
data/                 seed JSON, sampling rules, reference images, record/replay cache
eval/                 labelled listings + accuracy report
tests/                Vitest (no live Gemini calls)
```

All dependencies (store, Gemini client, event hub, image fetcher, clock) are injected through `Deps`, which is how the tests run the real
pipeline and routes with a mocked Gemini.

## API (summary; see `schemas/api.ts`)

| Endpoint | Notes |
| --- | --- |
| `POST /api/cases` | multipart: `capture` (JSON), `profile` (JSON), `caseNote?`, `screenshots[]?` (0–6). → `201 { caseId }`. Needs a screenshot, image URL or page text. Rate limit: 20 per hour per IP |
| `GET /api/cases/:id/stream` | SSE. Late subscribers get the buffered events for the current revision. Supports `Last-Event-ID`. 15 s keep-alive. Stays open, so reopen progress arrives on the same connection |
| `GET /api/cases/:id` | Full case, including `evidenceIndex`, absolute `imageUrls` and `history` |
| `GET /api/cases/summaries?ids=a,b` | Max 50 ids |
| `POST /api/cases/:id/reopen` | multipart: `capture?`, `sellerReply?`, `screenshots[]?` → `202 { caseId, revision }`. `409` while the case is still investigating |
| `POST /api/cases/:id/share` | `{ optIn }`. Opting in is allowed only for `hidden_gem` (`409` otherwise). Opting out is always allowed |
| `GET /api/cases/:id/images/:index` | Stored listing image (`photoIndex` in evidence) |
| `GET /api/feed?brand=&size=&system=` | Seeded mock items plus opted-in hidden gems, size-filtered via the size charts |

The CORS allow-list is `ALLOWED_EXTENSION_ORIGINS` + `ALLOWED_WEB_ORIGINS`. Requests without an `Origin` (e.g. `<img>` loads) aren't
cross-origin browser requests and are served without CORS headers.

## Decisions where the spec left room

- **Schema additions:** `Case.history`, `Case.answered` (questions the seller has already answered) and `CaseInput.position` (stable photo order).
  The optional fields are `Lead.relatesTo` (lets `flag_for_seller` target a check), plus `SampleStats.excluded`, `ruleIds` and `placeholder`.
- **`Profile.sizes[].system` is optional on input:** a missing system is assumed UK and recorded in `UserNeeds.assumptions`, as 7.4 says.
- **R5 treats any non-pass check as caution.** That covers `warn` and `unknown`, plus a theoretical `fail` not caught by R2–R4, so a failed check can never reach R6/R7.
- **Price Source B** (grounded new price) runs when Source A is unavailable or the price is at least p75. The `deeper_price_comparison`
  lead forces it. A price is accepted only when a grounding support ties it to a source. Resale and marketplace domains are excluded.
  At least 2 distinct sources must agree within 15%, and the new price is their median.
- **Fit uses chart rows.** One row step is half a size (`warn`), two or more is a mismatch (`fail`). Cross-brand estimates compare cm:
  within 0.8 cm is a `warn`, beyond that is a `fail`. If the listing doesn't state a system, UK is assumed and the result is capped at `warn`.
- **Condition and wear tolerance:** `light` is the spec table. `none` warns on any finding, `moderate` passes moderate wear, and `any` turns major into a `warn`.
  Findings under 0.6 confidence are labelled "Possible" and count one severity level lower.
- **Repeated `check_done` events:** the same check may be emitted more than once, when comfort's sizing advice adjusts fit or a lead
  updates a check. The later event replaces the earlier one.
- **Next moves:** code decides which gaps get a question (max 3, ordered by importance). Gemini only phrases them, and each phrasing
  passes the validator or falls back to a template.
- **Single process:** the event buffer and rate limiter are in memory, which is fine for a demo. Running more than one instance needs a shared bus.

## Data honesty

- `data/price-samples.json` is **placeholder data** (`ruleId: SYNTHETIC-placeholder`). While those rows are present, every price
  evidence label says *"(placeholder data, not real listings)"* and `npm run seed` warns. Collect real samples under
  `data/sampling-rules.md` (rule `R-newest-N`) **before** choosing demo listings, then replace the file and re-seed.
- `data/reviews.json` (the comfort fallback when grounding fails) is empty. Add real snippets with their URLs if you want the fallback.
- Catalogue `retailGBP` values and the men's size charts are approximate. Check them against the brands' own charts.
- `data/images/catalogue/` has no reference images yet. Identification works without them but is stronger with them.
- `eval/report.md` numbers are counts plus truncated percentages. Quote them exactly.
