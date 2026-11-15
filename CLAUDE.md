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
  (gitignored, see `eval/LABELLING.md`), `label.json` (hand labels, validated by `LabelSchema` in `eval/labels.ts`).
- Labels are never filled from Sleuth's output, and the labelling tool must never show it (no summary/report/DB reads;
  `offerColours` is hidden because it names Sleuth's offers). Boxes are `[ymin, xmin, ymax, xmax]` on 0–1000 (Gemini's format);
  matches need IoU ≥ 0.3 (`OVERLAP_THRESHOLD`).
- Percentages are rounded against Sleuth (`fraction()` in `eval/metrics.ts`); every figure carries n/d.

## Conventions

- Commit each logical step separately on the feature branch; run typecheck + tests before each commit.
- British spelling in user-facing text (colour, labelling). Plain, short comments explaining why.
