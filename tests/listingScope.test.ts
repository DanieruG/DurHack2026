import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { scopeListingImages, scopeListingText } from "@/lib/listingScope";

const EBAY_PAGE = fs.readFileSync(path.join(__dirname, "fixtures", "ebay-listing.txt"), "utf8");

describe("listing scope: page text", () => {
  it("keeps the eBay listing's own sections and drops navigation and other listings", () => {
    const { text, removedLines } = scopeListingText(EBAY_PAGE, "ebay");
    expect(removedLines).toBeGreaterThan(0);
    // Own listing
    for (const own of ["Adidas Gym Shoes", "£31.90or Best Offer", "Pre-owned - Good", "UK Shoe Size", "Product Line", "adidas Gym"]) expect(text).toContain(own);
    // Other listings, site navigation, the viewer's name, seller feedback
    for (const foreign of ["Dropset", "Runfalcon", "Stan Smith", "Hi Shopper!", "Antiques", "Related searches", "Feedback left by buyer"]) expect(text).not.toContain(foreign);
    expect(text.length).toBeLessThan(EBAY_PAGE.length / 2);
  });

  it("drops 'You may also like' blocks on other platforms until an own heading", () => {
    const page = ["Nike Pegasus 40", "£38.00", "Size: UK 9", "You may also like", "Nike Air Max 90 £60", "Adidas Samba £45", "Description", "Worn twice, no box.", "x".repeat(220)].join("\n");
    const { text } = scopeListingText(page, "vinted");
    expect(text).toContain("Worn twice");
    expect(text).not.toContain("Air Max 90");
  });

  it("leaves text alone when scoping would leave almost nothing (unrecognised layout)", () => {
    const page = ["Similar items", "y".repeat(400)].join("\n");
    expect(scopeListingText(page, "other").text).toBe(page);
  });
});

describe("listing scope: images", () => {
  it("eBay: drops other listings' /thumbs/ images and keeps the largest size of each photo, in page order", () => {
    const urls = [
      "https://i.ebayimg.com/images/g/AS4AAeSw505qR4He/s-l400.jpg",
      "https://i.ebayimg.com/images/g/AS4AAeSw505qR4He/s-l1600.webp",
      "https://i.ebayimg.com/images/g/yvcAAeSwts9qR4Hg/s-l1600.webp",
      "https://i.ebayimg.com/thumbs/images/g/Rp0AAeSwY-tq4Nzq/s-l500.jpg",
      "https://i.ebayimg.com/images/g/obUAAeSwn0ZqR4Hf/s-l1600.webp",
    ];
    expect(scopeListingImages(urls, "ebay")).toEqual([
      "https://i.ebayimg.com/images/g/AS4AAeSw505qR4He/s-l1600.webp",
      "https://i.ebayimg.com/images/g/yvcAAeSwts9qR4Hg/s-l1600.webp",
      "https://i.ebayimg.com/images/g/obUAAeSwn0ZqR4Hf/s-l1600.webp",
    ]);
  });

  it("other platforms: only de-duplicates", () => {
    expect(scopeListingImages(["https://a.example/1.jpg", "https://a.example/1.jpg", "https://a.example/2.jpg"], "vinted")).toEqual(["https://a.example/1.jpg", "https://a.example/2.jpg"]);
  });
});
