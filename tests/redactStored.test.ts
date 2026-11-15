import { describe, expect, it } from "vitest";
import { collectIdentifiers, countMatches, redactJson, redactPageText, redactString, redactTextColumn } from "@/lib/redactStored";

// Placeholders only: never real seller names in tests.
const EBAY_PAGE = [
  "Nike Revolution 6",
  "Find similar items from",
  "Samplejo's style closet",
  "Sampleshop Shoes",
  "(228410)",
  "Message",
  "£54.00",
  "Located in: Exampletown, United Kingdom",
  "Estimated by Tue, 17 Nov to AB1 2BD. See details",
  "VAT number: GB 000000000",
  "Reply from: sample_shop_01",
  "Marked down item price reflects all savings. Items provided by sample_shop_01.",
].join("\n");

describe("redaction of stored data", () => {
  it("collects seller identifiers from cards, feedback replies, store headers and store links", () => {
    const ids = collectIdentifiers([EBAY_PAGE, "Make an offer\nsample_seller_02\n18\nFrequent Uploads"], ["https://www.ebay.co.uk/str/samplejosstylecloset?_sacat=1", "https://x.example/?seller=sample_shop_02&a=1"]);
    expect(ids).toEqual(expect.arrayContaining(["Samplejo's style closet", "Sampleshop Shoes", "sample_shop_01", "sample_seller_02", "samplejosstylecloset", "sample_shop_02"]));
    expect(ids).not.toContain("sample_shop_01."); // no trailing full stop from "Items provided by …."
  });

  it("page text: today's redact(), then known identifiers masked anywhere", () => {
    const out = redactPageText(`${EBAY_PAGE}\nThanks from sample_shop_01 and Sampleshop Shoes`, ["sample_shop_01", "Sampleshop Shoes"]);
    expect(countMatches(out, ["sample_shop_01", "Sampleshop", "Samplejo", "Exampletown", "AB1 2BD", "000000000"])).toEqual({});
    expect(out).toContain("Nike Revolution 6");
    expect(out).toContain("£54.00");
  });

  it("JSON strings: identifiers, contacts and identity URL parts masked; ordinary advice kept", () => {
    const ids = ["sample_shop_01"];
    const v = {
      moves: [{ kind: "ask_seller", text: "Ask the seller for a photo of the size label" }],
      evidence: [{ quote: "Sold by sample_shop_01, call 07000 000000", url: "https://itm.ebaydesc.com/itmdesc/1?t=2&seller=sample_shop_01&ver=1" }],
      n: 3,
      store: "https://www.ebay.co.uk/str/sample_shop_01",
    };
    expect(redactJson(v, ids)).toEqual({
      moves: [{ kind: "ask_seller", text: "Ask the seller for a photo of the size label" }],
      evidence: [{ quote: "Sold by [redacted], call [phone number removed]", url: "https://itm.ebaydesc.com/itmdesc/1?t=2&ver=1" }],
      n: 3,
      store: "[link removed]",
    });
    expect(redactString("Retailer: Sample Retail, £50", ids)).toBe("Retailer: Sample Retail, £50");
  });

  it("JSON text columns keep their formatting when nothing changes", () => {
    const text = '{\n  "listings": [{ "title": "Nike Pegasus 40" }]\n}';
    expect(redactTextColumn(text, "observed_listings", ["sample_shop_01"])).toBe(text);
    expect(redactTextColumn('{"title":"by sample_shop_01"}', "observed_listings", ["sample_shop_01"])).toBe('{"title":"by [redacted]"}');
  });

  it("counts matches case-insensitively", () => {
    expect(countMatches("Sample_Shop_01 and sample_shop_01", ["sample_shop_01", "nobody"])).toEqual({ sample_shop_01: 2 });
  });
});
