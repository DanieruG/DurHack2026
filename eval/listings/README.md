# Labelled eval listings

One folder per captured listing: `capture.json`, any photos/screenshots (`*.jpg|png|webp`), and `label.json`
(format in `eval/run.ts`). Folders starting with `_` are ignored (see `_example`). Include some ambiguous
listings labelled `"catalogueModelId": null` so the report can show how often the identify gate correctly refuses.
Labels are written by a person looking at the listing, before running the pipeline.
