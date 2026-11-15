# Sleuth: notes for Claude

Sleuth investigates second-hand trainer listings (eBay, Vinted) captured by a Chrome side-panel extension, and gives a
verdict. Next.js app with route handlers only (see `AGENTS.md`: this Next.js version differs from older ones; read
`node_modules/next/dist/docs/` before touching `app/`). Most of the logic is plain TypeScript in `pipeline/` and `lib/`.

## Commands

    npm run typecheck && npm test      # run both after every change; ~5 s, no network, no live Gemini
    npm run ext:build                  # extension → extension/dist
    npm run eval                       # labelled cases → eval/report.md, eval/summary.json (live Gemini; test DB)
    npm run eval:slide / eval:labels   # slide table / missing-labels list in eval/LABELLING.md
    npm run label                      # local labelling page, http://127.0.0.1:4870 (eval/label/)
    npm run eval:baseline              # one plain Gemini call per case, same scoring → side-by-side in report.md
    npm run eval:photos                # restore gitignored eval photos from the main DB (checks sha256)

Scripts run with `npx tsx <file>`; top-level await needs the project's ESM setup, so put throwaway scripts that import
project code **inside** the repo tree or symlink `node_modules` next to them (tsx won't resolve packages from /tmp).
Happy-dom prints iframe stack traces during tests: noise, not failures.

## Where things are

| Path | What |
| --- | --- |
| `schemas/domain.ts` | Zod schemas for everything: Capture, ListingData (extension's structured fields, each with a `source`), ListingFacts, CheckResult, Evidence, DefectLabel, VerdictLabel, BroadColour |
| `schemas/eval.ts` | Eval summary/figure schemas, `HEADLINE_IDS`, `figureText` |
| `pipeline/index.ts` | `createCase` (stores case + inputs, starts `runInvestigation`) |
| `pipeline/intake.ts` | `prepareText` (redact + scope page text), image intake |
| `pipeline/listingData.ts` | `redactListingData`, merging extension fields into ListingFacts |
| `pipeline/examine.ts`, `identify.ts`, `checks/*`, `verdict/*` | Gemini calls, checks, verdict rules |
| `gemini/client.ts` | Gemini client: tiers (fast/strong from `GEMINI_MODEL_FAST/STRONG`), retry, record/replay cache, call counting |
| `lib/redact.ts` | Server-side text redaction (seller cards, feedback blocks, towns, VAT, postcodes, phones, emails) |
| `lib/marketplace/redactSeller.ts` | Identifier masking (`scrubIdentifiers`, `identifierVariants`, `scrubUrl`) |
| `lib/store.ts`, `lib/prismaStore.ts` | Store interface (memory + Prisma/Neon). `CaseInput.kind` is a free string (no migration to add kinds) |
| `extension/src/lib/capture.ts` | What the extension reads from the page (`prepareCapture`, `structuredListing`) |
| `eval/` | Eval set and metrics: `labels.ts` (label schema), `collect.ts` (runs a case), `metrics.ts`, `report.ts` |
| `eval/label/` | Labelling tool: `api.ts` (reads capture/photos/label only, validates and saves), `server.ts` (node:http), `page.html` (vanilla JS, no build). Tested by driving the page in happy-dom (`tests/labelTool.test.ts`) |
| `scripts/export-eval-case.ts` | Main DB case → `eval/listings/<platform>-<itemId>/` (read-only on the DB) |
| `tests/` | Vitest; `tests/helpers.ts` `makeDeps` gives a mocked Gemini + memory store |

## Identification when the model isn't clear

Sleuth never refuses to name a model. The old "confidence gate" (below `IDENTIFY_CONFIDENCE_MIN`: withhold the model,
mark every other check `unknown`, verdict `not_enough_evidence`) is a misconception: don't build on it or bring it back.

- Identify always returns a `bestGuess` (brand, model, version, colourway), up to 2 `alternatives` with their
  confidence, a `confidenceLevel`, and the evidence for each. Brand only, with the reason recorded, only when Gemini
  can't suggest any model at all.
- Levels: `confirmed` (style code read clearly, or the listing states the exact model and version, consistent with the
  photos); `likely` (≥ 0.75, no conflicting evidence); `possible` (0.5–0.75, or Flash and Pro disagree: the top two
  become bestGuess and an alternative); `best_guess` (< 0.5).
- Vague title, or below `likely` after the first pass: SerpApi Google Lens on the main photo (plus the clearest side
  profile). Matches go to identify as visual matches, not facts, and are stored as evidence with links. Cache them per
  image URL and count them against the search quota.
- `confirmed`, `likely`, `user_confirmed`: carry on with bestGuess. `possible`, `best_guess`: pause before any
  model-dependent step (comfort, new-price search, observed-listing comparison, alternatives, leads). Case status
  `awaiting_confirmation`, event `identity_check_needed`. Condition and fit (brand size chart) still run and stream. The
  buyer answers via `POST /api/cases/:id/confirm-identity` (`best_guess` | `alternative` + index | `custom`, normalised
  against the catalogue with no search | `skip`). Nothing searches while paused; no timeout; resumable from History. If a
  clearly read style code or the listing's own data contradicts the buyer's choice, keep the choice and add a warning.
  Skip: model-dependent checks become `unknown`, no searches.
- Carrying on with an unconfirmed guess (the eval does): comfort says "Based on our best guess: {model}". Price is
  conditional ("If this is the {model}, it's £X new"), and its status stays `unknown` unless every candidate's new
  price is within 15% of the others (then their range, confidence ≤ 0.4).
- Verdict R1 (`not_enough_evidence`) fires only when not even the brand is known.
- Eval never pauses: it carries on with bestGuess and records how often it would have paused. Scoring: top-1 and top-3
  correct, accuracy by level (report it if a lower level is right more often than a higher one); brand only counts as
  wrong. Cache replay replays the pause and the recorded choice.
- Labels (`eval/labels.ts`): `listingShowsModel` describes the listing, not what Sleuth may say. `model`/`version` are
  what the pair really is, researched beyond the listing if need be; `"unknown"` (`UNKNOWN`) only when even that fails,
  which leaves the case out of model accuracy.

Status (2026-11-15): built as above. Where to look: `pipeline/identifyLevel.ts` (levels, `normaliseIdentify` for old stored
cases), `pipeline/lens.ts` + `lib/lens.ts` (Lens, cached per image URL, counted in `lib/serpQuota.ts`),
`pipeline/identityCheck.ts` (question payload, the buyer's answer, contradiction warning), `pipeline/confirm.ts`
(`startConfirm`: resumes a paused case, or corrects a closed one as a new revision), `pipeline/identityReplay.ts` (record/replay
of the buyer's answer), `extension/src/panel/screens/IdentityCard.tsx`. Notes:

- The pause is persisted (status `awaiting_confirmation`, checks, identify with alternatives, a union survey, `pause_state`
  input with run totals), so it survives a restart; `synthesizeEvents` re-asks it. `ctx.paused` makes any search throw.
- Lens runs before the pause, so it can spend quota on a case that then waits. Model-dependent checks wait for the Gemini Pro
  recheck (fit and condition run alongside it).
- `createCase(deps, req, { pause: false })` is how the eval carries on with the best guess; the eval records `wouldHavePaused`.
- Replay: `CACHE_MODE=record` saves the buyer's answer per listing; `CACHE_MODE=replay` shows the card, waits
  `REPLAY_CHOICE_DELAY_MS`, then applies it. With no recorded answer a replayed case waits for the buyer.
- The prompt and schema changed and `PIPELINE_VERSION` is 3: existing `data/cache` recordings won't match, so re-record demos.

## Databases

- Two Neon databases: main (`DATABASE_URL`) and branch `test-runs` (`TEST_DATABASE_URL`). Eval, reruns and DB tests call
  `useTestDatabase()` (`lib/testDb.ts`) first and must never touch main.
- The venue network blocks port 5432: use the Neon WebSocket driver (443). Prisma CLI migrations: `npm run db:migrate:https`.
  Bash commands that reach Neon or Gemini need the sandbox disabled.
- Tables: Case (JSON columns listingFacts/identify/verdict/nextMoves/history/needs), CaseInput (page_text, image,
  screenshot, seller_reply, observed_listings, listing_data), CheckRecord, LeadRecord, CacheEntry (cached SerpApi/Gemini
  responses; no prompts or logs are stored anywhere else).

## Privacy rules (important)

- Seller identity is redacted twice: in the extension (`prepareCapture`) and on the server (`prepareText`,
  `redactListingData`). Never store or send a seller's name, handle, town, VAT/CRN, or the buyer's name/postcode.
- **Never put a real seller name, username, the user's name or postcode in committed files** (tests, comments, docs,
  commit messages). Use placeholders like `sample_shop_01`, `Sampleshop Shoes`, `AB1 2BD`.
- Real identities found in the data live only in `data/private/known-identities.txt` (gitignored), used by
  `scripts/redact-stored.ts --verify`.
- Line-based `redact()` is for page text only: on short JSON strings it deletes legitimate text ("Ask the seller…").
  For JSON, mask identifiers/contacts/URLs (`lib/redactStored.ts`).

## Eval

- Case folder: `capture.json` (redacted capture, may include `capture.listing` structured fields), `photo-NN.*`
  (gitignored; restore with `npm run eval:photos` from the main DB), `photos.json` (source case id, sha256 per photo,
  photos removed on purpose), `label.json` (hand labels, validated by `LabelSchema` in `eval/labels.ts`).
- Never commit photos. `npm run eval` throws if any are missing. Remove a non-shoe photo with
  `scripts/eval-photos.ts --remove` (renumbers and shifts label defect keys).
- Labels are never filled from Sleuth's output, and the labelling tool must never show it (no summary/report/DB reads;
  `offerColours` is hidden because it names Sleuth's offers). Boxes are `[ymin, xmin, ymax, xmax]` on 0–1000 (Gemini's format);
  matches need IoU ≥ 0.3 (`OVERLAP_THRESHOLD`).
- Baseline (`eval/baseline.ts`, `eval/run-baseline.ts`): fixed user prompt + buyer line from `EVAL_PROFILE`, same
  page text (`prepareText`), same photos, structured output mapped to `CaseRun`, scored by the same `summarise()`.
  `eval/write.ts` regenerates report.md/slide.md from summary.json + baseline-summary.json; summaries carry
  `caseIds` + `labelsHash` so stale comparisons are flagged. Keep it fair: any change to inputs applies to both.
- Percentages are rounded against Sleuth (`fraction()` in `eval/metrics.ts`); every figure carries n/d.

## Conventions

- Commit each logical step separately on the feature branch; run typecheck + tests before each commit.
- British spelling in user-facing text (colour, labelling). Plain, short comments explaining why.
