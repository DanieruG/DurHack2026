import { describe, expect, it } from "vitest";
import { detectPlatform } from "@/lib/platform";
import { redact } from "@/lib/redact";
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
