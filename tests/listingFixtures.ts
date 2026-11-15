import fs from "node:fs";
import path from "node:path";
import { collectListing, type RawCapture } from "@/extension/src/lib/capture";

/**
 * Saved listing pages (tests/fixtures/listings), with every seller username, seller id, avatar, business address and the
 * signed-in user's name and postcode replaced by placeholders. Load them in a happy-dom test file with scripts disabled:
 *
 *   // @vitest-environment happy-dom
 *   // @vitest-environment-options {"settings":{"disableJavaScriptEvaluation":true,...}}
 */
export const EBAY_FIXTURE = {
  file: "ebay-206627552126.html",
  url: "https://www.ebay.co.uk/itm/206627552126?_skw=nike+revolution+8&itmmeta=01M7EDGMFS9CJSP6HM7CMJX4KY&hash=item301bf63b7e:g:EQkAAeSwZPtqxKQl",
  /** Placeholders standing in for the seller's identity and the signed-in buyer's details. */
  seller: ["sample_shop_01", "sampleshop01", "Sampleshop"],
  account: ["sample_buyer_01", "Alex", "AB1 2BD"],
} as const;

export const VINTED_FIXTURE = {
  file: "vinted-10798990503.html",
  url: "https://www.vinted.co.uk/items/10798990503-grey-nike-p6000-mens-size-14?referrer=catalog",
  seller: ["sample_seller_02", "9000000001", "01_00000_FixtureAvatarPhotoId00000", "FixtureAvatarPhotoId"],
  account: [] as string[],
} as const;

const cache = new Map<string, string>();

export function fixtureHtml(file: string): string {
  if (!cache.has(file)) cache.set(file, fs.readFileSync(path.join(__dirname, "fixtures", "listings", file), "utf8"));
  return cache.get(file)!;
}

/** Put a saved page into the happy-dom document at its URL. `edit` may change the HTML first. */
export function loadPage(fixture: { file: string; url: string }, edit: (html: string) => string = (h) => h): void {
  (window as unknown as { happyDOM: { setURL(u: string): void } }).happyDOM.setURL(fixture.url);
  const html = edit(fixtureHtml(fixture.file));
  document.documentElement.innerHTML = html.replace(/^[\s\S]*?<html[^>]*>/i, "").replace(/<\/html>[\s\S]*$/i, "");
}

/** Run the extension's in-page collector on a saved page. */
export function collectFixture(fixture: { file: string; url: string }, edit?: (html: string) => string): RawCapture {
  loadPage(fixture, edit);
  return collectListing();
}
