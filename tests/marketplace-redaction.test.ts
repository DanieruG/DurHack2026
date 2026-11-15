// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"disableJavaScriptEvaluation":true,"disableJavaScriptFileLoading":true,"disableCSSFileLoading":true,"disableIframePageLoading":true,"disableComputedStyleRendering":true,"handleDisabledFileLoadingAsSuccess":true}}
import { describe, expect, it } from "vitest";
import { prepareCapture, structuredListing } from "@/extension/src/lib/capture";
import { identifierVariants, scrubIdentifiers, scrubUrl } from "@/lib/marketplace/redactSeller";
import { redact } from "@/lib/redact";
import { createCase } from "@/pipeline";
import { collectFixture, EBAY_FIXTURE, VINTED_FIXTURE } from "./listingFixtures";
import { makeDeps, PROFILE } from "./helpers";

/** Seller and account details in the fixtures (placeholders standing in for the real ones). */
const EBAY_FORBIDDEN = [
  ...EBAY_FIXTURE.seller,
  ...EBAY_FIXTURE.account,
  "Sample Footwear",
  "Example Road",
  "Exampletown",
  "01000000000",
  "contact@seller.example",
  "eu-rep@seller.example",
  "Sample EU Representative",
  "seller=",
  "0xgAAFIXTURE0000",
  "positive Feedback",
  "Feedback left by buyer",
  "VAT number",
];
const VINTED_FORBIDDEN = [...VINTED_FIXTURE.seller, "Frequent Uploads", "Regularly lists", "Last seen"];

const found = (haystack: string, needles: readonly string[]) => needles.filter((n) => new RegExp(`(^|[^A-Za-z0-9_])${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9_])`, "i").test(haystack));

async function storedCase(capture: ReturnType<typeof prepareCapture>["capture"]) {
  const deps = makeDeps({ images: {} });
  const { caseId, done } = await createCase(deps, { capture, profile: PROFILE, screenshots: [] });
  await done;
  const c = await deps.store.getCase(caseId);
  const inputs = await deps.store.getInputs(caseId, { withData: false });
  const prompts = deps.calls.map((x) => JSON.stringify(x.contents));
  return JSON.stringify({ c, inputs, events: deps.hub.events(caseId), prompts });
}

describe("redaction: eBay fixture", () => {
  it("the capture contains none of the seller's or the signed-in buyer's details", () => {
    const raw = collectFixture(EBAY_FIXTURE);
    // They are on the page (in links, the description iframe URL, page state and the seller card)...
    expect(found(raw.pageText + raw.embedded!.scripts.join(""), ["sample_shop_01", "Sampleshop", "AB1 2BD", "Exampletown"])).toHaveLength(4);
    expect(structuredListing(raw)!.sellerIds).toEqual(expect.arrayContaining(["sample_shop_01", "sampleshop01", "Sampleshop Shoes"]));
    expect(raw.fields!.account).toEqual(expect.arrayContaining(["Alex", "sample_buyer_01"]));
    // ...and nowhere in what is sent.
    const { capture, preview } = prepareCapture(raw);
    expect(found(JSON.stringify({ capture, preview }), EBAY_FORBIDDEN)).toEqual([]);
    expect(capture.pageUrl).toBe("https://www.ebay.co.uk/itm/206627552126");
    expect(capture.pageText).toContain("Nike Mens Running Trainers revolution 6 next na Lace Up black white UK Size");
    expect(capture.pageText).toContain("Item specifics");
  });

  it("removes the greeting when the header shows the signed-in name", () => {
    const raw = collectFixture(EBAY_FIXTURE, (html) => html.replace('<span id="gh-ident-srvr-name"></span>', '<span id="gh-ident-srvr-name">Alex</span>'));
    expect(raw.pageText).toMatch(/Hi Alex!/);
    expect(found(JSON.stringify(prepareCapture(raw).capture), ["Alex"])).toEqual([]);
  });

  it("the stored case, its inputs, its events and every Gemini prompt contain none of them", async () => {
    const { capture } = prepareCapture(collectFixture(EBAY_FIXTURE));
    expect(found(await storedCase(capture), EBAY_FORBIDDEN)).toEqual([]);
  });
});

describe("redaction: Vinted fixture", () => {
  it("the capture contains none of the seller's details (username, id, avatar, badges, activity)", () => {
    const raw = collectFixture(VINTED_FIXTURE);
    expect(found(raw.pageText, ["sample_seller_02", "Frequent Uploads", "Last seen"])).toHaveLength(3);
    expect(structuredListing(raw)!.sellerIds).toEqual(expect.arrayContaining(["sample_seller_02", "9000000001", "01_00000_FixtureAvatarPhotoId00000"]));
    const { capture, preview } = prepareCapture(raw);
    expect(found(JSON.stringify({ capture, preview }), VINTED_FORBIDDEN)).toEqual([]);
    expect(capture.pageUrl).toBe("https://www.vinted.co.uk/items/10798990503-grey-nike-p6000-mens-size-14");
    expect(capture.pageText).toContain("Pre worn but still in great condition");
  });

  it("the stored case contains none of them", async () => {
    const { capture } = prepareCapture(collectFixture(VINTED_FIXTURE));
    expect(found(await storedCase(capture), VINTED_FORBIDDEN)).toEqual([]);
  });
});

describe("redaction helpers", () => {
  it("masks identifiers inline, drops their own lines and the count after them, and spares longer words", () => {
    const ids = identifierVariants(["Sampleshop Shoes", "jo_99"], { title: "Nike Revolution 6" });
    expect(ids).toEqual(["Sampleshop Shoes", "Sampleshop", "jo_99"]);
    expect(scrubIdentifiers("Title\nSampleshop Shoes\n(228410)\nWelcome to the Sampleshop Store\nAsk jo_99 or jo_999", ids)).toBe("Title\nWelcome to the [redacted] Store\nAsk [redacted] or jo_999");
  });

  it("never removes a display name's first word when it's part of the listing (a shop called 'Nike Outlet')", () => {
    expect(identifierVariants(["Nike Outlet"], { brand: "Nike" })).toEqual(["Nike Outlet"]);
  });

  it("drops seller and user parameters from URLs", () => {
    expect(scrubUrl("https://itm.ebaydesc.com/itmdesc/1?t=2&seller=jo_99&ver=1")).toBe("https://itm.ebaydesc.com/itmdesc/1?t=2&ver=1");
    expect(scrubUrl("https://www.ebay.co.uk/str/jo99shop", ["jo99shop"])).toBeNull();
  });

  it("masks UK postcodes and run-on greetings", () => {
    expect(redact("Estimated by Tue, 17 Nov to AB1 2BD. See details").text).toBe("Estimated by Tue, 17 Nov to [postcode removed]. See details");
    expect(redact("Hi Alex!Hello. Sign in\nNike Revolution 6").text).toBe("Nike Revolution 6");
  });
});
