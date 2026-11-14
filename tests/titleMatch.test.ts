import { describe, expect, it } from "vitest";
import { loadSeedFiles } from "@/lib/seedData";
import {
  canonicalVersion,
  catalogueTokens,
  chartForBrand,
  deriveTokens,
  extractSize,
  matchTitle,
  normaliseTitle,
  toUK,
  withoutSize,
} from "@/lib/titleMatch";
import { fixtureReference } from "./helpers";

const seed = loadSeedFiles();
const model = (id: string) => catalogueTokens(seed.catalogue.find((m) => m.id === id)!);
const nike = fixtureReference().sizeCharts.find((c) => c.id === "nike-mens")!;

describe("title normalisation", () => {
  it.each([
    ["Men's NIKE Air Zoom Pegasus 40 Trainers - BNWT, Black/White", "nike pegasus 40"],
    ["Womens adidas ULTRA BOOST Light shoes", "adidas ultraboost light"],
    ["New Balance 550 RARE genuine", "newbalance 550"],
    ["NB 1080v13 Fresh Foam", "newbalance 1080 v13 fresh foam"],
    ["Nike Pegasus40 sneakers!!", "nike pegasus 40"],
    ["Hoka One One Clifton 9", "hoka clifton 9"],
    ["Nike Pegasus Trail Gore-Tex", "nike pegasus trail goretex"],
    ["Nike Air Force One '07", "nike air force 1 07"],
    ["  Nike   AM90   authentic ", "nike air max 90"],
  ])("%s", (title, expected) => {
    expect(normaliseTitle(title)).toBe(expected);
  });

  it("keeps decimals inside numbers only", () => {
    expect(normaliseTitle("Gel-Kayano 30. Size 9.5.")).toBe("gel kayano 30 9.5");
  });
});

describe("size extraction", () => {
  it.each([
    ["Nike Pegasus 40 UK 9", { system: "UK", value: 9, assumed: false }],
    ["Nike Pegasus uk9", { system: "UK", value: 9, assumed: false }],
    ["Pegasus 40 size 9", { system: "UK", value: 9, assumed: true }],
    ["Pegasus 40 9UK", { system: "UK", value: 9, assumed: false }],
    ["Pegasus 40 us 10", { system: "US", value: 10, assumed: false }],
    ["Pegasus 40 EU 43", { system: "EU", value: 43, assumed: false }],
    ["Pegasus 40 eur44.5", { system: "EU", value: 44.5, assumed: false }],
    ["Pegasus 40 size 44", { system: "EU", value: 44, assumed: true }],
    ["Pegasus 40 UK 8½", { system: "UK", value: 8.5, assumed: false }],
    ["Pegasus 40 UK Shoe Size: 10", { system: "UK", value: 10, assumed: false }],
    ["Pegasus 40 size 9 UK", { system: "UK", value: 9, assumed: false }],
  ])("%s", (title, expected) => {
    expect(extractSize(title)).toMatchObject(expected);
  });

  it("doesn't read the model number as a size", () => {
    expect(extractSize("Nike Pegasus 40 uk 9")).toMatchObject({ system: "UK", value: 9 });
    expect(extractSize("Nike Pegasus 40")).toBeNull();
    expect(extractSize("Nike Air Max 90 trainers")).toBeNull();
  });

  it("reads a bare size field only when asked (a card's size text)", () => {
    expect(extractSize("43")).toBeNull();
    expect(extractSize("43", { bareOk: true })).toMatchObject({ system: "EU", value: 43, assumed: true });
    expect(extractSize("9.5", { bareOk: true })).toMatchObject({ system: "UK", value: 9.5 });
  });

  it("removes the size from the title so it isn't read as a version", () => {
    expect(withoutSize("Hoka Clifton UK 9").replace(/\s+/g, " ").trim()).toBe("hoka clifton");
  });

  it("converts to UK on the brand's chart", () => {
    expect(toUK({ system: "UK", value: 9 }, undefined)).toBe(9);
    expect(toUK({ system: "US", value: 10 }, nike)).toBe(9);
    expect(toUK({ system: "EU", value: 43 }, nike)).toBe(8.5);
    expect(toUK({ system: "EU", value: 43 }, undefined)).toBeNull();
    expect(toUK({ system: "EU", value: 60 }, nike)).toBeNull();
    expect(chartForBrand("NIKE", fixtureReference().sizeCharts)?.id).toBe("nike-mens");
    expect(chartForBrand("New Balance", seed.sizeCharts)?.id).toBe("newbalance-mens");
  });
});

describe("match levels", () => {
  const peg40 = model("nike-pegasus-40");
  it.each([
    ["Nike Air Zoom Pegasus 40 UK 9", "exact"],
    ["NIKE PEGASUS 40 mens running trainers size 9", "exact"],
    ["Nike Pegasis 40 uk 10", "exact"], // one-letter typo on a family token of 5+ letters
    ["Nike Pegasus trainers size 9", "version_unknown"],
    ["Nike Zoom Pegasus white", "version_unknown"],
    ["Nike Pegasus 39 uk 9", "different_version"],
    ["Nike Pegasus 41", "different_version"], // never a typo on the version
    ["Nike Pegasus Trail 4", "none"],
    ["Nike Pegasus 40 GS kids", "none"],
    ["Nike Pegasus 40 Shield", "none"],
    ["Nike Pegasus Turbo", "none"],
    ["Pegasus 40 uk 9", "none"], // no brand
    ["Nike running shoes uk 9", "none"], // names no model
    ["Nike Pgasus 40", "exact"],
    ["Nike Pegsaus 40", "none"], // a transposition is two edits
  ])("%s -> %s", (title, level) => {
    expect(matchTitle(title, peg40).level).toBe(level);
  });

  it("handles spelling variants, glued versions and roman numerals", () => {
    expect(matchTitle("Nike Airmax 90", model("nike-air-max-90")).level).toBe("exact");
    expect(matchTitle("AM90 Nike", model("nike-air-max-90")).level).toBe("exact");
    expect(matchTitle("Nike Air Max 95", model("nike-air-max-90")).level).toBe("different_version");
    expect(matchTitle("New Balance Fresh Foam X 1080v13 UK 9", model("new-balance-1080-v13")).level).toBe("exact");
    expect(matchTitle("NB 1080 v12", model("new-balance-1080-v13")).level).toBe("different_version");
    expect(matchTitle("adidas Ultra Boost Light", model("adidas-ultraboost-light")).level).toBe("exact");
    expect(matchTitle("Hoka One One Clifton UK 9", model("hoka-clifton-9")).level).toBe("version_unknown");
    expect(matchTitle("Hoka Clifton 9 size 10", model("hoka-clifton-9")).level).toBe("exact");
    expect(matchTitle("Asics Gel Kayano 30", model("asics-gel-kayano-30")).level).toBe("exact");
    expect(matchTitle("adidas Samba XLG", model("adidas-samba-og")).level).toBe("none");
  });

  it("derives tokens for models outside the catalogue", () => {
    const t = deriveTokens("Saucony", "Endorphin Speed 4");
    expect(t).toMatchObject({ brand: "saucony", family: ["endorphin", "speed"], version: "4" });
    expect(t.exclude).toContain("gtx");
    expect(matchTitle("Saucony Endorphin Speed IV", t).level).toBe("exact");
    expect(matchTitle("Saucony Endorphin Speed 3", t).level).toBe("different_version");
    expect(matchTitle("Saucony Endorphin Speed", t).level).toBe("version_unknown");
    // A model whose own name has an exclusion word keeps it as a family word.
    expect(deriveTokens("Nike", "Pegasus Trail 4")).toMatchObject({ family: ["pegasus", "trail"], version: "4" });
    expect(matchTitle("Nike Pegasus Trail 4", deriveTokens("Nike", "Pegasus Trail 4")).level).toBe("exact");
  });

  it("allows a typo only on family tokens of 5 or more letters", () => {
    const dunk = deriveTokens("Nike", "Dunk Low");
    expect(matchTitle("Nike Dunk Low", dunk).level).toBe("exact");
    expect(matchTitle("Nike Dank Low", dunk).level).toBe("none");
  });

  it("compares versions canonically", () => {
    expect(canonicalVersion("v13")).toBe("13");
    expect(canonicalVersion("IV")).toBe("4");
    expect(canonicalVersion("07")).toBe("7");
  });

  it("every catalogue entry has tokens and matches its own name", () => {
    for (const m of seed.catalogue) {
      expect(m.matchTokens, m.id).toBeTruthy();
      expect(matchTitle(`${m.brand} ${m.name}`, catalogueTokens(m)).level, m.id).toBe("exact");
    }
  });
});
