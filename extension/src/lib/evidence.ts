import type { CaseDetail } from "@/schemas/api";
import type { CheckResult, ConditionFinding, DefectLabel, Evidence, Lead, SampleStats } from "@/schemas/domain";
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

/** One box on a photo. `finding` indexes ConditionView.findings; `possible` (confidence < 0.6) is drawn dashed. */
export type PhotoBox = { top: number; left: number; width: number; height: number; caption: string; severe: boolean; possible: boolean; finding: number };

/** Box2d is [ymin, xmin, ymax, xmax] normalised 0-1000; returned as CSS percentages. */
export function boxStyle(box: [number, number, number, number]): Pick<PhotoBox, "top" | "left" | "width" | "height"> {
  const [ymin, xmin, ymax, xmax] = box.map((v) => Math.min(1000, Math.max(0, v)));
  return { top: ymin / 10, left: xmin / 10, height: Math.max(2, (ymax - ymin) / 10), width: Math.max(2, (xmax - xmin) / 10) };
}

export type FindingItem = { photoIndex: number; caption: string; note: string; possible: boolean; severe: boolean };

export type ConditionView = {
  /** Every listing photo (for the switcher), each with its boxes. */
  photos: { index: number; url: string | null; boxes: PhotoBox[] }[];
  findings: FindingItem[];
  /** The photo to show first: the first one with a finding. */
  initialPhoto: number;
  notes: string[];
  contradictions: string[];
};

export function conditionView(check: CheckResult, imageUrls: string[]): ConditionView {
  const d = (check.details ?? {}) as { findings?: ConditionFinding[]; notVisible?: string[]; contradictions?: string[] };
  const raw = d.findings ?? [];
  const findings: FindingItem[] = raw.map((f) => ({
    photoIndex: f.photoIndex,
    caption: findingCaption(f),
    note: f.note,
    possible: f.confidence < POSSIBLE_BELOW,
    severe: f.severity !== "minor" && f.confidence >= POSSIBLE_BELOW,
  }));
  const indices = [...new Set([...imageUrls.map((_, i) => i), ...raw.map((f) => f.photoIndex)])].sort((a, b) => a - b);
  const photos = indices.map((index) => ({
    index,
    url: imageUrls[index] ?? null,
    boxes: raw.flatMap((f, i) => (f.photoIndex === index ? [{ ...boxStyle(f.box2d), caption: findings[i].caption, severe: findings[i].severe, possible: findings[i].possible, finding: i }] : [])),
  }));
  return {
    photos,
    findings,
    initialPhoto: raw[0]?.photoIndex ?? indices[0] ?? 0,
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
      domain: e.domain ?? domainOf(e.url),
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
    lines.push(`New price ${gbp(d.newPrice.gbp)}, median of ${d.newPrice.sources} UK retailers${d.newPrice.observedOn ? `, checked ${shortDate(d.newPrice.observedOn)}` : ""}.`);
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

// ---------- leads followed ----------

const LEAD_ACTIONS: Record<Lead["type"], string> = {
  deeper_price_comparison: "Compared the price more carefully",
  recheck_identification: "Took a second look at the model",
  recheck_condition_photo: "Looked at a photo again",
  flag_for_seller: "Noted a question for the seller",
};

export type LeadsView = {
  items: { id: string; action: string; reason: string; outcome: string; state: "done" | "problem" }[];
  /** One line: why leads were skipped, or that nothing needed following up. */
  note: string | null;
};

/** Null when no leads were considered (the section is hidden). */
export function leadsView(detail: Pick<CaseDetail, "leads" | "leadsReport">): LeadsView | null {
  const report = detail.leadsReport ?? { considered: detail.leads.length > 0 };
  if (!report.considered && !detail.leads.length) return null;
  const items = detail.leads.map((l) => ({
    id: l.id,
    action: LEAD_ACTIONS[l.type],
    reason: l.reason,
    outcome: l.outcome ?? (l.status === "failed" ? "Couldn't complete this." : l.status === "skipped" ? "Skipped." : "Done."),
    state: l.status === "failed" ? ("problem" as const) : ("done" as const),
  }));
  const note = report.skipped ?? (items.length ? null : "Nothing needed following up.");
  return { items, note };
}
