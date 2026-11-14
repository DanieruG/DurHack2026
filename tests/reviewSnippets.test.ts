import { describe, expect, it } from "vitest";
import { independentSites, reviewRows, reviewTopics, snippetsFromResults } from "@/lib/reviewSnippets";
import { comfortFromSnippets } from "@/pipeline/checks/comfort";
import type { WebResult } from "@/lib/webSearch";

describe("review snippets from SerpApi results", () => {
  it("tags topics from the snippet's own words, in the fallback's format", () => {
    expect(reviewTopics("Comfortable for long days on your feet. Fits true to size.")).toEqual(["positive:comfort", "positive:all-day comfort", "sizing:true_to_size"]);
    expect(reviewTopics("The toe box is narrow and it runs half a size small.")).toEqual(["negative:wide fit", "sizing:runs_small"]);
    expect(reviewTopics("Not comfortable at all, quite stiff.")).toEqual(["negative:comfort"]);
    expect(reviewTopics("Not very durable: the sole came off after a month")).toContain("negative:durability");
    expect(reviewTopics("A great looking shoe.")).toEqual([]);
    // Rating-widget scale labels are not opinions.
    expect(reviewTopics("How comfortable was this product? 88% between Uncomfortable and Very Comfortable. UncomfortableVery Comfortable.")).toEqual(["positive:comfort"]);
  });

  it("stores the real URL behind Google redirects, classifies the site, and skips unresolved redirects", () => {
    const results: WebResult[] = [
      { index: 1, title: "Clifton 9 review", link: "https://www.google.co.uk/goto?url=A", domain: "runbryanrun.com", snippet: "Plush and comfortable." },
      { index: 2, title: "Clifton 9", link: "https://www.hoka.com/clifton-9", domain: "hoka.com", snippet: "Our most cushioned." },
      { index: 3, title: "Post", link: "https://www.google.co.uk/goto?url=B", domain: "", snippet: "Comfy." },
      { index: 4, title: "No snippet", link: "https://runrepeat.com/x", domain: "runrepeat.com", snippet: "" },
    ];
    const s = snippetsFromResults("hoka-clifton-9", results, { "https://www.google.co.uk/goto?url=A": "https://runbryanrun.com/2023-hoka-clifton-9-review/" });
    expect(s.map((x) => [x.url, x.sourceType])).toEqual([
      ["https://runbryanrun.com/2023-hoka-clifton-9-review/", "other"],
      ["https://www.hoka.com/clifton-9", "manufacturer"],
    ]);
    expect(s[0]).toMatchObject({ modelId: "hoka-clifton-9", title: "Clifton 9 review", text: "Plush and comfortable.", topics: ["positive:comfort"] });
  });

  it("rows have the seed's deterministic ids, and feed the comfort fallback", () => {
    const snippets = snippetsFromResults("nike-pegasus-40", [
      { index: 1, title: "RunRepeat", link: "https://runrepeat.com/p40", domain: "runrepeat.com", snippet: "Comfortable for long runs." },
      { index: 2, title: "Runner's World", link: "https://www.runnersworld.com/p40", domain: "runnersworld.com", snippet: "Comfortable, true to size." },
    ]);
    expect(reviewRows(snippets).map((r) => r.id)).toEqual(reviewRows(snippets).map((r) => r.id));
    expect(reviewRows(snippets)[0].id).toMatch(/^rs_[0-9a-f]{20}_0$/);
    expect(independentSites(snippets)).toBe(2);
    const r = comfortFromSnippets(snippets, { sizes: [], priorities: ["all-day comfort"], wearTolerance: "light", extraPriorities: [], assumptions: [] }, "2026-11-14");
    expect(r).toMatchObject({ status: "pass", details: { fallback: true, reviewSizing: "true_to_size" } });
  });
});
