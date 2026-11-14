import { describe, expect, it } from "vitest";
import { excludeOutliers, formatDateRange, percentile, sampleEvidenceLabel, sampleStats } from "@/lib/priceSample";
import { fixtureReference } from "./helpers";

const samples = fixtureReference().priceSamples;

describe("sampleStats + outlier rule", () => {
  it("excludes samples above 3x or below 1/3 of the median", () => {
    expect(excludeOutliers([10, 50, 50, 50, 200])).toEqual({ kept: [50, 50, 50], excluded: 2 });
    expect(excludeOutliers([50, 150, 16.67]).excluded).toBe(0); // boundaries are kept
  });
  it("computes stats after exclusion", () => {
    const s = sampleStats(samples, "nike-pegasus-40")!;
    expect(s.n).toBe(12);
    expect(s.excluded).toBe(1);
    expect(s.median).toBe(46.5);
    expect(s.p10).toBe(35.3);
    expect(s.p25).toBe(39.5);
    expect(s.p75).toBe(52.75);
    expect(s.p90).toBe(57.7);
    expect(s.collectedOn).toEqual({ from: "2026-11-03", to: "2026-11-10" });
    expect(s.placeholder).toBe(false);
  });
  it("requires n >= 5 (Source A unavailable otherwise)", () => {
    expect(sampleStats(samples, "nike-pegasus-40", "worn")).toBeNull(); // 4 worn samples
    expect(sampleStats(samples, "unknown-model")).toBeNull();
  });
  it("restricts by condition (outlier rule applied within the subset)", () => {
    const rows = [40, 42, 44, 46, 48, 90, 95].map((p, i) => ({ ...samples[0], priceGBP: p, condition: i < 5 ? ("like_new" as const) : ("worn" as const) }));
    expect(sampleStats(rows, "nike-pegasus-40", "like_new")).toMatchObject({ n: 5, median: 44 });
    expect(sampleStats(rows, "nike-pegasus-40", "worn")).toBeNull();
    // like_new subset of the fixture: 5 rows, but one is a 400 outlier -> only 4 remain -> unavailable
    expect(sampleStats(samples, "nike-pegasus-40", "like_new")).toBeNull();
  });
  it("percentile interpolates linearly", () => {
    expect(percentile([1, 2, 3, 4], 50)).toBe(2.5);
    expect(percentile([5], 90)).toBe(5);
  });
  it("labels evidence with count and date, flagging placeholder data", () => {
    const s = sampleStats(samples, "nike-pegasus-40")!;
    expect(sampleEvidenceLabel(s)).toBe("Compared with 12 listings sampled on 3–10 Nov");
    expect(sampleEvidenceLabel({ ...s, collectedOn: { from: "2026-11-10", to: "2026-11-10" } })).toBe("Compared with 12 listings sampled on 10 Nov");
    expect(sampleEvidenceLabel({ ...s, placeholder: true })).toContain("placeholder data");
    expect(formatDateRange("2026-10-28", "2026-11-10")).toBe("28 Oct – 10 Nov");
  });
});
