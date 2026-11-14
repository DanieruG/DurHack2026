import { describe, expect, it } from "vitest";
import { convertSize, formatSize, parseSizeText, rowForCm } from "@/lib/sizes";
import { fixtureReference } from "./helpers";

const [nike, adidas] = fixtureReference().sizeCharts;

describe("convertSize", () => {
  it("converts between systems on the brand chart", () => {
    expect(convertSize(9, "UK", nike)).toMatchObject({ uk: 9, us: 10, eu: 44, cm: 28 });
    expect(convertSize(10, "US", nike)?.uk).toBe(9);
    expect(convertSize(44, "EU", nike)?.uk).toBe(9);
  });
  it("matches EU thirds within tolerance", () => {
    expect(convertSize(42.67, "EU", adidas)?.uk).toBe(8.5);
    expect(convertSize(42.7, "EU", adidas)?.uk).toBe(8.5);
  });
  it("returns null for sizes not on the chart", () => {
    expect(convertSize(3, "UK", nike)).toBeNull();
    expect(convertSize(9.25, "UK", nike)).toBeNull();
  });
  it("finds the nearest row by cm, within 1 cm", () => {
    expect(rowForCm(28.1, nike)?.uk).toBe(9);
    expect(rowForCm(40, nike)).toBeNull();
  });
});

describe("parseSizeText", () => {
  it.each([
    ["UK 9", { size: 9, system: "UK" }],
    ["Size: UK9.5", { size: 9.5, system: "UK" }],
    ["9 UK", { size: 9, system: "UK" }],
    ["US M 10", { size: 10, system: "US" }],
    ["EU 44 2/3", { size: 44.67, system: "EU" }],
    ["44⅔", { size: 44.67, system: "EU" }],
    ["8½", { size: 8.5, system: "unknown" }],
    ["42", { size: 42, system: "EU" }],
  ])("%s", (text, expected) => {
    expect(parseSizeText(text)).toEqual(expected);
  });
  it("uses the hint for a bare size and returns null with no number", () => {
    expect(parseSizeText("9", "US")).toEqual({ size: 9, system: "US" });
    expect(parseSizeText("one size")).toBeNull();
    expect(parseSizeText(undefined)).toBeNull();
  });
  it("formats sizes", () => {
    expect(formatSize(9, "UK")).toBe("UK 9");
    expect(formatSize(44.67, "EU")).toBe("EU 44 2/3");
    expect(formatSize(9.5, "US")).toBe("US 9.5");
  });
});
