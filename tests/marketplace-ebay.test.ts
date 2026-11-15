// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"disableJavaScriptEvaluation":true,"disableJavaScriptFileLoading":true,"disableCSSFileLoading":true,"disableIframePageLoading":true,"disableComputedStyleRendering":true,"handleDisabledFileLoadingAsSuccess":true}}
import { beforeAll, describe, expect, it } from "vitest";
import { prepareCapture, structuredListing } from "@/extension/src/lib/capture";
import type { RawCapture } from "@/extension/src/lib/capture";
import { ebayPhotoUrl } from "@/lib/marketplace/ebay";
import { CaptureSchema } from "@/schemas/domain";
import { mergeListingFacts } from "@/pipeline/listingData";
import { createCase } from "@/pipeline";
import { collectFixture, EBAY_FIXTURE } from "./listingFixtures";
import { fixtureReference, json, makeDeps, PROFILE } from "./helpers";
import { checkFit } from "@/pipeline/checks/fit";
import { generateNextMoves } from "@/pipeline/nextMoves";

const fixtureReferenceCharts = () => fixtureReference().sizeCharts;

let raw: RawCapture;
beforeAll(() => {
  raw = collectFixture(EBAY_FIXTURE);
});

const GRID_IDS = ["EQkAAeSwZPtqxKQl", "LkkAAeSwS3ZqxKQl", "qyUAAeSwMeZqxKQl", "u8cAAeSwX4hqxKQl", "EnMAAeSwbd5qxKQl", "sogAAeSwoyJqxKQl", "r1MAAeSwp1NqxKQl"];

describe("eBay item page fixture: structured extraction", () => {
  it("reads the JSON-LD core fields", () => {
    const { listing } = structuredListing(raw)!;
    expect(listing.title).toEqual({ value: "Nike Mens Running Trainers revolution 6 next na Lace Up black white UK Size", source: "structured_data" });
    expect(listing.brand).toEqual({ value: "Nike", source: "structured_data" });
    expect(listing.model).toEqual({ value: "Nike Revolution 6 Next Na", source: "structured_data" });
    expect(listing.priceGBP).toEqual({ value: 54, source: "structured_data" });
    expect(listing.listPriceGBP).toEqual({ value: 64, source: "structured_data" });
    expect(listing.condition).toEqual({ value: "New", source: "structured_data" });
    expect(listing.postageGBP).toEqual({ value: 0, source: "structured_data" });
    expect(listing.totalGBP).toEqual({ value: 54, source: "structured_data" });
  });

  it("pairs every item specifics label with its value", () => {
    const { listing } = structuredListing(raw)!;
    expect(listing.itemSpecifics).toEqual([
      { label: "Condition", value: expect.stringMatching(/^New with box: This item is brand new/), source: "page_field" },
      { label: "Brand", value: "Nike", source: "page_field" },
      { label: "Colour", value: "Multicoloured", source: "page_field" },
      { label: "Department", value: "Men", source: "page_field" },
      { label: "Product Line", value: "Nike Revolution 6 Next Na", source: "page_field" },
      { label: "Model", value: "Nike Revolution 6 Next Na", source: "page_field" },
      { label: "Country of Origin", value: "China", source: "page_field" },
      { label: "Upper Material", value: "Mesh", source: "page_field" },
      { label: "Type", value: "Trainer", source: "page_field" },
      { label: "Insole Material", value: "Synthetic", source: "page_field" },
      { label: "Lining Material", value: "Synthetic", source: "page_field" },
      { label: "Outsole Material", value: "Rubber", source: "page_field" },
      { label: "Shoe Width", value: "Standard", source: "page_field" },
    ]);
    expect(listing.colour).toEqual({ value: "Multicoloured", source: "page_field" });
    expect(listing.material).toEqual({ value: "Mesh", source: "page_field" });
    expect(listing.styleCode).toBeUndefined(); // not on this listing
  });

  it("takes all 7 photos from the gallery grid, full size, including the lazy-loaded one (data-src only)", () => {
    const lazy = raw.fields!.grid.find((g) => !g.src);
    expect(lazy?.dataSrc).toContain("r1MAAeSwp1NqxKQl");
    const { capture, preview } = prepareCapture(raw);
    expect(capture.imageUrls).toEqual(GRID_IDS.map((id) => `https://i.ebayimg.com/images/g/${id}/s-l1600.jpg`));
    expect(capture.listing?.photos).toEqual({ captured: 7, shown: 7 });
    expect(preview.photoCount).toBe(7);
    // JSON-LD lists only 5 of them, which is why it is never used for photos.
    const ld = JSON.parse(raw.embedded!.jsonLd.find((t) => t.includes('"Product"'))!);
    expect(ld.image).toHaveLength(5);
  });

  it("builds the full-size URL from the image id", () => {
    expect(ebayPhotoUrl("https://i.ebayimg.com/images/g/r1MAAeSwp1NqxKQl/s-l140.webp")).toEqual({ id: "r1MAAeSwp1NqxKQl", url: "https://i.ebayimg.com/images/g/r1MAAeSwp1NqxKQl/s-l1600.jpg" });
    expect(ebayPhotoUrl("https://i.ebayimg.com/thumbs/images/g/abc/s-l140.webp")).toBeNull();
  });

  it("reads the 9 size options and their stock flags from the page state (the page only says 'Select')", () => {
    const { listing } = structuredListing(raw)!;
    expect(listing.sizeOptions).toEqual({
      label: "UK Shoe Size",
      system: "UK",
      source: "structured_data",
      options: ["7", "7.5", "8", "8.5", "9", "9.5", "10", "11", "11.5"].map((value) => ({ value, outOfStock: false })),
    });
    expect(listing.size).toBeUndefined(); // size is a choice, not a fact
  });

  it("records that the seller's description (an itm.ebaydesc.com iframe) wasn't captured", () => {
    expect(structuredListing(raw)!.listing.notes).toEqual(["Seller description not captured"]);
  });

  it("sends a capture that passes the API schema", () => {
    const { capture } = prepareCapture(raw);
    expect(CaptureSchema.safeParse(capture).success).toBe(true);
    expect(capture.listing?.title?.value).toMatch(/^Nike Mens Running Trainers/);
  });
});

describe("eBay: page data first, Gemini for the gaps", () => {
  it("keeps the page data's values and sources over Gemini's, and marks Gemini's own fields", () => {
    const { listing } = structuredListing(raw)!;
    const facts = mergeListingFacts(
      {
        platform: "ebay",
        photoCount: 7,
        title: "Nike Revolution 8 trainers",
        brandText: "Nike",
        modelText: "Revolution 8",
        sizeText: "UK 9",
        sizeSystem: "UK",
        priceGBP: 45,
        conditionClaims: ["Brand new"],
        evidence: [
          { id: "ext_1", kind: "data_point", label: "Model (read from the listing, not an exact quote)", value: "Revolution 8" },
          { id: "ext_2", kind: "data_point", label: "Listed size (read from the listing, not an exact quote)", value: "UK 9" },
        ],
      },
      listing,
    );
    expect(facts).toMatchObject({ title: listing.title!.value, modelText: "Nike Revolution 6 Next Na", priceGBP: 54, postageGBP: 0, totalGBP: 54, totalIncludes: ["postage"] });
    expect(facts.sizeText).toBeUndefined(); // multi-size: no listed size
    expect(facts.sizeOptions?.options).toHaveLength(9);
    expect(facts.conditionClaims[0]).toBe("New");
    expect(facts.fieldSources).toMatchObject({ title: "structured_data", brand: "structured_data", model: "structured_data", price: "structured_data", condition: "structured_data", colour: "page_field", sizeOptions: "structured_data", sizeSystem: "structured_data" });
    expect(facts.evidence.some((e) => e.value === "Revolution 8" || e.value === "UK 9")).toBe(false);
  });

  it("sends the page data to Gemini as known facts; the search hint never overrides the listing's model", async () => {
    const { capture } = prepareCapture(raw);
    const identifyRevision = (modelName: string, confidence: number) => () =>
      json({ brand: "Nike", brandConfidence: 0.95, modelName, catalogueModelId: null, confidence, reasons: "Title", evidence: [{ kind: "quote", label: "Title", quote: "revolution 6 next na" }], photoModel: null });
    const extract = () => json({ title: null, brandText: "Nike", modelText: null, sizeText: null, sizeSystem: null, price: null, currency: null, conditionClaims: [], evidence: [] });

    const run = async (searchQuery: string | undefined, modelName: string, confidence: number) => {
      const deps = makeDeps({ handlers: { extract, identify: identifyRevision(modelName, confidence) }, images: {} });
      const { caseId, done } = await createCase(deps, { capture: { ...capture, ...(searchQuery ? { searchQuery } : {}) }, profile: PROFILE, screenshots: [] });
      await done;
      const c = (await deps.store.getCase(caseId))!;
      const prompt = deps.calls.find((x) => x.stage === "extract")!.contents.flatMap((x) => x.parts).map((p) => ("text" in p ? p.text : "")).join("\n");
      return { c, prompt };
    };

    const plain = await run(undefined, "Revolution 6 Next Nature", 0.85);
    const hinted = await run("nike revolution 8", "Revolution 6 Next Nature", 0.85);
    expect(plain.prompt).toContain("Already read from this listing's own page data");
    expect(plain.prompt).toContain("- Model: Nike Revolution 6 Next Na");
    expect(hinted.prompt).toContain('searching "nike revolution 8"');
    expect(hinted.c.identify?.modelName).toBe("Revolution 6 Next Nature");
    expect(hinted.c.identify?.confidence).toBe(plain.c.identify?.confidence); // the hint never raises confidence
    expect(hinted.c.listingFacts?.modelText).toBe("Nike Revolution 6 Next Na");
    // "Multicoloured" in the item specifics is too generic: the colour comes from the title.
    expect(hinted.c.listingFacts?.listingColour).toMatchObject({ names: ["black", "white"], source: "title" });

    // Even if Gemini followed the search, a model named only by the search stays below "likely" (0.75).
    const followed = await run("nike revolution 8", "Revolution 8", 0.9);
    expect(followed.c.identify?.modelName).toBe("Revolution 8");
    expect(followed.c.identify!.confidence).toBeLessThan(0.75);
  });
});

describe("eBay: fit against the size options", () => {
  const charts = () => fixtureReferenceCharts();
  const factsWith = (edit?: (o: { value: string; outOfStock: boolean }[]) => { value: string; outOfStock: boolean }[]) => {
    const listing = structuredListing(raw)!.listing;
    const sizeOptions = { ...listing.sizeOptions!, options: edit ? edit(listing.sizeOptions!.options) : listing.sizeOptions!.options };
    return mergeListingFacts({ platform: "ebay", photoCount: 7, conditionClaims: [], evidence: [] }, { ...listing, sizeOptions });
  };
  const fit = (f: ReturnType<typeof factsWith>) =>
    checkFit({ facts: f, needs: { sizes: [{ brand: "Nike", size: 9, system: "UK" }], priorities: [], wearTolerance: "light", extraPriorities: [], assumptions: [] }, brand: "Nike", chart: charts().find((c) => c.brand === "Nike"), charts: charts() });

  it("UK 9 offered and in stock: pass, and the next move says to select it", async () => {
    const r = fit(factsWith());
    expect(r).toMatchObject({ status: "pass", summary: "Your size (UK 9) is available." });
    expect(r.details).toMatchObject({ sizeOptions: true, available: true, selectSize: "UK 9" });
    const moves = await generateNextMoves(null, { checks: [r], leads: [], label: "worth_a_look", platform: "ebay" });
    expect(moves.find((m) => m.id === "nm_select_size")).toEqual({ id: "nm_select_size", kind: "before_you_pay", text: "Select UK 9 before buying.", relatesTo: ["fit"] });
    expect(moves.some((m) => m.kind === "ask_seller" && m.relatesTo.includes("fit"))).toBe(false);
  });

  it("UK 9 offered but out of stock: fail", () => {
    const r = fit(factsWith((o) => o.map((x) => (x.value === "9" ? { ...x, outOfStock: true } : x))));
    expect(r).toMatchObject({ status: "fail", summary: "Your size (UK 9) is out of stock." });
  });

  it("UK 9 not offered: fail", () => {
    const r = fit(factsWith((o) => o.filter((x) => x.value !== "9")));
    expect(r).toMatchObject({ status: "fail", summary: "Your size (UK 9) isn't offered: this listing has UK 7 to UK 11.5." });
  });
});
