import type { CheckResult, ConditionFinding, DefectLabel, Evidence, SampleStats } from "@/schemas/domain";
import { domainOf, gbp, shortDate } from "./format";

const DEFECT_WORDS: Record<DefectLabel, string> = {
  outsole_wear: "outsole wear",
  heel_wear: "heel wear",
  upper_creasing: "creasing",
  stitching_damage: "stitching damage",
  discolouration: "discolouration",
  tear_or_hole: "tear or hole",
  sole_separation: "sole separation",
  dirt_or_staining: "staining",
};

const POSSIBLE_BELOW = 0.6;

export function findingCaption(f: Pick<ConditionFinding, "label" | "severity" | "confidence">): string {
  const lead = f.confidence < POSSIBLE_BELOW ? "Possible" : f.severity[0].toUpperCase() + f.severity.slice(1);
  return `${lead} ${DEFECT_WORDS[f.label]}`;
}

/** "inside lining" -> "Inside lining not shown." */
export function notShownNote(area: string): string {
  const a = area.trim().replace(/[.]$/, "");
  return `${a[0].toUpperCase()}${a.slice(1)} not shown.`;
}

export type PhotoBox = { top: number; left: number; width: number; height: number; caption: string; severe: boolean };

/** Box2d is [ymin, xmin, ymax, xmax] normalised 0-1000; returned as CSS percentages. */
export function boxStyle(box: [number, number, number, number]): Omit<PhotoBox, "caption" | "severe"> {
  const [ymin, xmin, ymax, xmax] = box.map((v) => Math.min(1000, Math.max(0, v)));
  return { top: ymin / 10, left: xmin / 10, height: Math.max(2, (ymax - ymin) / 10), width: Math.max(2, (xmax - xmin) / 10) };
}

export type ConditionView = {
  photos: { index: number; url: string | null; boxes: PhotoBox[] }[];
  notes: string[];
  contradictions: string[];
};

export function conditionView(check: CheckResult, imageUrls: string[]): ConditionView {
  const d = (check.details ?? {}) as { findings?: ConditionFinding[]; notVisible?: string[]; contradictions?: string[] };
  const byPhoto = new Map<number, PhotoBox[]>();
  for (const f of d.findings ?? []) {
    const boxes = byPhoto.get(f.photoIndex) ?? [];
    boxes.push({ ...boxStyle(f.box2d), caption: findingCaption(f), severe: f.severity !== "minor" && f.confidence >= POSSIBLE_BELOW });
    byPhoto.set(f.photoIndex, boxes);
  }
  const photos = [...byPhoto.entries()]
    .sort(([a], [b]) => a - b)
    .map(([index, boxes]) => ({ index, url: imageUrls[index] ?? null, boxes }));
  if (!photos.length && imageUrls[0]) photos.push({ index: 0, url: imageUrls[0], boxes: [] });
  return {
    photos,
    notes: (d.notVisible ?? []).filter((a) => a !== "all areas").map(notShownNote),
    contradictions: d.contradictions ?? [],
  };
}

export type SourceRef = { n: number; title: string; domain: string; url?: string; quote?: string; type?: Evidence["sourceType"] };

export function sourceRefs(check: CheckResult): SourceRef[] {
  return check.evidence
    .filter((e) => e.kind === "source" || e.url)
    .map((e, i) => ({
      n: i + 1,
      title: e.title ?? e.label,
      domain: domainOf(e.url),
      url: e.url,
      quote: e.quote,
      type: e.sourceType,
    }));
}

export type PriceView = {
  listing?: number;
  sample?: SampleStats;
  lines: string[];
  /** Positions on a 0-100 scale for the range strip. */
  strip?: { p10: number; p25: number; median: number; p75: number; p90: number; listing: number; lowLabel: string; highLabel: string };
};

export function priceView(check: CheckResult): PriceView {
  const d = (check.details ?? {}) as {
    listingPriceGBP?: number;
    sample?: SampleStats;
    newPrice?: { gbp: number; sources: number; observedOn?: string };
  };
  const lines: string[] = [];
  if (d.sample) {
    const when = d.sample.collectedOn.from === d.sample.collectedOn.to
      ? shortDate(d.sample.collectedOn.to)
      : `${shortDate(d.sample.collectedOn.from)}–${shortDate(d.sample.collectedOn.to)}`;
    lines.push(`Compared with ${d.sample.n} listings sampled ${when}.${d.sample.placeholder ? " Placeholder data, not real listings." : ""}`);
  }
  if (d.newPrice) {
    lines.push(`New price ${gbp(d.newPrice.gbp)} at ${d.newPrice.sources} retailer${d.newPrice.sources === 1 ? "" : "s"}${d.newPrice.observedOn ? `, checked ${shortDate(d.newPrice.observedOn)}` : ""}.`);
  }
  let strip: PriceView["strip"];
  if (d.sample && d.listingPriceGBP !== undefined) {
    const s = d.sample;
    const lo = Math.min(s.p10, d.listingPriceGBP) * 0.9;
    const hi = Math.max(s.p90, d.listingPriceGBP) * 1.1;
    const pos = (v: number) => ((v - lo) / (hi - lo)) * 100;
    strip = {
      p10: pos(s.p10),
      p25: pos(s.p25),
      median: pos(s.median),
      p75: pos(s.p75),
      p90: pos(s.p90),
      listing: pos(d.listingPriceGBP),
      lowLabel: gbp(Math.round(s.p10)),
      highLabel: gbp(Math.round(s.p90)),
    };
  }
  return { listing: d.listingPriceGBP, sample: d.sample, lines, strip };
}

/** Fit and identity evidence is already worded by the backend ("Your saved Nike size: UK 9"). */
export function evidenceLines(check: CheckResult): string[] {
  const d = (check.details ?? {}) as { reviewSizingNote?: string };
  const lines = check.evidence.filter((e) => e.kind !== "source").map((e) => (e.quote ? `${e.label}: “${e.quote}”` : e.label));
  if (d.reviewSizingNote) lines.push(d.reviewSizingNote);
  return lines;
}
