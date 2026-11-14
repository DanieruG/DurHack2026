import { describe, expect, it } from "vitest";
import { detectPlatform } from "@/lib/platform";
import fs from "node:fs";
import path from "node:path";
import { redact, sellerUsernames } from "@/lib/redact";
import { prepareText } from "@/pipeline/intake";
import { PAGE_TEXT } from "./helpers";

describe("detectPlatform", () => {
  it.each([
    ["https://www.vinted.co.uk/items/123-nike", "vinted"],
    ["https://vinted.fr/items/1", "vinted"],
    ["https://www.facebook.com/marketplace/item/1", "facebook"],
    ["https://www.ebay.co.uk/itm/1", "ebay"],
    ["https://m.ebay.com/itm/1", "ebay"],
    ["https://www.depop.com/products/x", "depop"],
    ["https://notvinted.com/items/1", "other"],
    ["https://vinted.co.uk.evil.com/x", "other"],
    ["not a url", "other"],
    [undefined, "other"],
  ])("%s -> %s", (url, platform) => expect(detectPlatform(url)).toBe(platform));
});

describe("redact", () => {
  it("removes seller identity blocks and handles", () => {
    const { text, removedLines } = redact(PAGE_TEXT + "\nMessage me @jane.doe or jane@example.com or 07700 900123");
    expect(text).not.toMatch(/jane_doe_99|Member since|★|120 reviews|jane\.doe|example\.com|07700/);
    expect(text).toContain("Size: UK 9");
    expect(text).toContain("£38.00");
    expect(removedLines).toBeGreaterThanOrEqual(3);
  });
  it("drops the line after a seller header", () => {
    expect(redact("Seller\nsneakerqueen\nSize UK 8").text).toBe("Size UK 8");
  });
  it("masks inline seller labels mid-line", () => {
    expect(redact("Hi! They're UK 9. Seller: jane_doe_99 thanks").text).toBe("Hi! They're UK 9. Seller: [redacted] thanks");
  });
  it("handles empty input", () => expect(redact(undefined)).toEqual({ text: "", removedLines: 0 }));
});

describe("redact: eBay seller block (saved eBay page)", () => {
  const page = fs.readFileSync(path.join(__dirname, "fixtures", "ebay-listing.txt"), "utf8");

  it("finds the seller's username from the seller card", () => {
    expect(sellerUsernames(page.split("\n"))).toEqual(["seller_x"]);
  });

  it("removes the username, the seller card, the seller section and the viewer's name; keeps the listing", () => {
    const { text } = redact(page + "\nDescription: collection from seller_x's house only.");
    expect(text).not.toMatch(/seller_x/i);
    expect(text).not.toContain("Hi Shopper!");
    for (const gone of ["Joined Aug 2023", "Registered as a private seller", "Seller's other items", "Feedback left by buyer", "b***r (10)", "Save seller"]) expect(text).not.toContain(gone);
    expect(text).not.toMatch(/^\(75\)$/m);
    expect(text).not.toMatch(/^Private$/m);
    expect(text).toContain("collection from [redacted]'s house only.");
    for (const kept of ["Adidas Gym Shoes", "£31.90or Best Offer", "Pre-owned - Good", "UK Shoe Size", "adidas Gym"]) expect(text).toContain(kept);
  });

  it("does not treat an ordinary word above a count as a username", () => {
    expect(sellerUsernames(["Reviews", "(120)", "Watchers", "(3)"])).toEqual([]);
    expect(redact("Reviews\n(120)\nGreat shoes").text).toContain("Great shoes");
  });

  it("redaction runs before storage and before Gemini: prepareText on the eBay page", () => {
    const { pageText } = prepareText({ pageUrl: "https://www.ebay.co.uk/itm/100000000001", pageText: page });
    expect(pageText).not.toMatch(/seller_x|Hi Shopper/);
  });
});
