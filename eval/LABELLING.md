# Labelling an eval case

Each folder in `eval/listings/` is one real listing: `capture.json` (the page text, redacted, and the search survey's
card facts), the listing's photos `photo-01`, `photo-02`, … in the order Sleuth sees them, `photos.json` (where the
photos came from), and `label.json`, which you fill in.

## Where the photos live

The photos are sellers' photos, so they're **not in git** (`.gitignore`: `eval/listings/*/photo-*`). They live only on
your machine, in each case's folder (`eval/listings/<case>/photo-NN.webp`). What git does keep is each case's
`photos.json`: the stored case the photos came from (in the main database) and every photo's sha256.

To restore them (a fresh clone, or after deleting them):

    npm run eval:photos      # reads the main database (DATABASE_URL), never writes; checks every sha256

`npm run eval` refuses to run while any photo is missing, so a case can't quietly run on text alone, and
`npm run label` warns about it. Photos stay restorable only while their case is in the main database; if a case is
deleted, back up its folder first (copying `eval/listings/` somewhere private is enough).

To drop a photo that isn't the shoes: `npx tsx scripts/eval-photos.ts --remove <case> photo-NN.webp "<reason>"`. It
deletes the file, renumbers the photos after it (moving their defect labels), and records the photo's hash in
`photos.json` under `removed`, so neither a restore nor a re-export brings it back. After adding photos by hand, run
`npx tsx scripts/eval-photos.ts --manifest`.

**Use the labelling tool:** `npm run label`, then open http://127.0.0.1:4870. It lists every case with what's still
missing; for each case it shows the photos one at a time (drag a box around each defect, pick its type and severity),
the label form, and the page text with the listing's structured fields alongside. Save writes the case's `label.json`,
checked against the eval schema. It never shows Sleuth's answers for a case, and it never shows `offerColours` (those
name the offers Sleuth found); edit that field by hand in `label.json` if you need it.

**Label what you see, before looking at what Sleuth said.** Read the page text in `capture.json`, open the listing URL
if it's still live, and look at every photo. Never copy a label from Sleuth's output or a report, and don't guess:
leave a field `null` when you can't tell. A `null` field leaves that case out of that one figure, and the report says
how many cases each figure covers.

Every case runs with the same profile, so fit doesn't depend on whoever captured the listing: a usual size of UK 9, no
brand sizes, priorities "all-day comfort", light wear accepted (`EVAL_PROFILE` in `eval/collect.ts`).

## Fields

| Field | What to write | Example |
| --- | --- | --- |
| `identifiable` | `true` if you can tell the exact model and version from the listing; `false` if you can't. Sleuth should refuse to name a model when it's `false`. | `true` |
| `brand` | The brand, as on the shoe. | `"Nike"` |
| `model` | The model without its version. Leave `null` when `identifiable` is `false`. | `"Pegasus"`, `"Air Max"`, `"Samba OG"`, `"P-6000"` |
| `version` | The version, or `"none"` if the model has no versions. Leave `null` when `identifiable` is `false`. | `"40"`, `"95"`, `"none"` |
| `styleCode` | The style code if you know it, and whether it can be read in the photos or text (`visible`). `{ "value": null, "visible": false }` when there's none to read. | `{ "value": "FV6603-101", "visible": true }` |
| `colourway` | The shoe's broad colours, main colour first, from: black, white, grey, navy, blue, red, green, brown, beige, pink, purple, orange, yellow. | `["white", "grey"]` |
| `size` | The size as the listing states it, and its system: `UK`, `US`, `EU`, or `unknown` if the listing doesn't say. A listing that offers several sizes: `"value": "multiple"`. A listing that gives no size at all: `{ "value": "not_stated", "system": "unknown" }`. | `{ "value": 9, "system": "UK" }` |
| `conditionGrade` | `new_with_tags`, `like_new`, `good` or `worn`, from the photos and description. | `"good"` |
| `defects` | Defects you can see, per photo you checked (see below), each with a severity: `minor`, `moderate` or `major`. | `{ "3": [{ "label": "heel_wear", "severity": "minor", "box2d": [520, 610, 760, 900] }], "4": [] }` |
| `offerColours` | Optional. New-price offers whose colour you checked by eye against the listing, by URL. | `[{ "url": "https://…", "colourMatch": "same" }]` |
| `expectedVerdict` | Optional. The verdict you'd expect: `hidden_gem`, `worth_a_look`, `proceed_with_caution`, `wrong_fit`, `overpriced`, `not_enough_evidence`. | `"worth_a_look"` |
| `notes` | Optional. Anything odd about the case. | |

## Marking defects

Defect boxes are needed on **at least 10 photos across the whole set**, so not every case needs them. For each photo
you check, add its number (photo-03 is `"3"`) with a list of defects; `[]` means you checked it and saw none. Labels:
`outsole_wear`, `heel_wear`, `upper_creasing`, `stitching_damage`, `discolouration`, `tear_or_hole`, `sole_separation`,
`dirt_or_staining`.

A box is `[ymin, xmin, ymax, xmax]` on a 0–1000 scale of the photo's height and width (top left is `[0, 0, …]`), the
same format Gemini uses. The labelling tool measures it for you. To measure one by hand: open the photo in Preview, Tools > Show Inspector, drag a selection around the defect, and read its pixel
position and size; then `y × 1000 ÷ photo height` and `x × 1000 ÷ photo width`. A box Sleuth reports counts as finding
your defect when the two overlap by at least 0.3 (intersection over union), so it doesn't need to be tight.

## Checking your work

    npm run eval:labels     # updates the list below
    npm run eval            # runs every case: eval/summary.json, eval/report.md, eval/slide.md
    npm run eval:baseline   # the same cases through one plain Gemini call each: eval/baseline-summary.json,
                            # and the side-by-side table in eval/report.md and eval/slide.md
    npm run eval:slide      # rewrite eval/slide.md and eval/report.md from the latest summaries

Run `npm run eval` and `npm run eval:baseline` one after the other on the same labels: the comparison says "not
comparable" if the cases or labels changed between them. The labels, `report.md`, `summary.json`,
`baseline-summary.json` and `slide.md` are committed; the photos aren't.

## Adding a case

    npx tsx scripts/export-eval-case.ts <caseId>    # one captured case (reads the main database, never writes)
    npx tsx scripts/export-eval-case.ts --all        # the newest case for every listing

Cases captured from now on also store the extension's structured fields (item specifics, size options, Vinted
attributes, pricing breakdown, each with its source); the export puts them in `capture.json` as `capture.listing`,
`npm run eval` runs the case with them, and the report lists which cases had them. The current cases were captured
before they were stored, so they run on page text and photos only.

The export redacts the page text and structured fields again, keeps only this listing's photos, never copies your profile or seller
replies, and leaves `label.json` empty. Look through the photos before committing a case: the export can't see what's
in them.

## Notes on the current cases

Things to know while labelling (not labels):

- `ebay-178485489023`, `ebay-198622268078`, `ebay-206627552126`: stock product photos, so there's no wear to mark.
- `ebay-206627552126`: the shop's returns banner and logo (photos 6 and 7 in the listing) were removed; see `photos.json`.
- `vinted-10503713940`: a photo of a dog (photo 6 in the listing's own gallery) was removed; see `photos.json`.
- `ebay-860128293708`: this investigation stopped with an error during live testing; it's included to see whether it still does.
- `ebay-206390698933`: captured before the page-text scoping, so its text runs long; the extra lines are site navigation.

## Cases with missing labels

<!-- missing-labels:start -->
Defect boxes: marked on 0 of the 10 photos needed.

| Case | Photos | Missing | Defect photos marked |
| --- | --- | --- | --- |
| ebay-168811552330 | 6 | identifiable, brand, model, version, styleCode, colourway, size, conditionGrade | 0 |
| ebay-178485489023 | 7 | identifiable, brand, model, version, styleCode, colourway, size, conditionGrade | 0 |
| ebay-198622268078 | 8 | identifiable, brand, model, version, styleCode, colourway, size, conditionGrade | 0 |
| ebay-206390698933 | 4 | identifiable, brand, model, version, styleCode, colourway, size, conditionGrade | 0 |
| ebay-206627552126 | 5 | identifiable, brand, model, version, styleCode, colourway, size, conditionGrade | 0 |
| ebay-206683004216 | 5 | identifiable, brand, model, version, styleCode, colourway, size, conditionGrade | 0 |
| ebay-287724614047 | 8 | identifiable, brand, model, version, styleCode, colourway, size, conditionGrade | 0 |
| ebay-366787843200 | 7 | identifiable, brand, model, version, styleCode, colourway, size, conditionGrade | 0 |
| ebay-820336095090 | 6 | identifiable, brand, model, version, styleCode, colourway, size, conditionGrade | 0 |
| ebay-860128293708 | 8 | identifiable, brand, model, version, styleCode, colourway, size, conditionGrade | 0 |
| vinted-10503713940 | 5 | identifiable, brand, model, version, styleCode, colourway, size, conditionGrade | 0 |
| vinted-10751853310 | 5 | identifiable, brand, model, version, styleCode, colourway, size, conditionGrade | 0 |
<!-- missing-labels:end -->
