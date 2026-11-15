import type { CheckResult, Evidence, FitMatch, ListingFacts, SizeSystem, UserNeeds } from "@/schemas/domain";
import type { SizeChart } from "@/schemas/seed";
import { convertSize, formatSize, parseSizeText, sizeIn, type ConvertedSize } from "@/lib/sizes";
import { evidenceIds, unknownCheck } from "../util";

export type FitInput = {
  facts: ListingFacts;
  needs: UserNeeds;
  /** The identified brand (fit only needs the brand, not the exact model). */
  brand: string;
  /** The size chart to use: the catalogue model's own, else the brand's; undefined when we have none. */
  chart: SizeChart | undefined;
  /** All charts, for cross-brand estimates from the user's other saved sizes. */
  charts: SizeChart[];
};

const sameBrand = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Fit check: pure code, exact size-chart lookups only (spec 7.6). */
export function checkFit({ facts, needs, brand, chart, charts }: FitInput): CheckResult {
  const nextId = evidenceIds("fit");
  const listedEv = facts.evidence.filter((e) => e.label.startsWith("Listed size") || e.label.startsWith("Size system") || e.label.startsWith("Size options"));
  // A multi-size listing offers sizes to choose from: fit asks whether the user's size is offered and in stock.
  if (facts.sizeOptions?.options.length && !facts.sizeText) return checkSizeOptions({ facts, needs, brand, chart, charts }, listedEv);
  const parsed = parseSizeText(facts.sizeText, facts.sizeSystem === "unknown" ? undefined : facts.sizeSystem);
  if (!parsed) {
    return unknownCheck("fit", "The listing doesn't state a size, so I can't check the fit.", {
      details: { listed: null, listedSystem: null, userSize: null, match: null },
    });
  }
  if (!chart) {
    return unknownCheck("fit", `I don't have a ${brand} size chart to check the fit against.`, { evidence: listedEv });
  }
  // Never assume a size system: a bare "14" could be UK 14 or US 14, which are a size apart.
  if (parsed.system === "unknown") return unknownSystemFit(parsed.size, { facts, needs, brand, chart, charts }, listedEv);
  const listedSystem: SizeSystem = parsed.system;
  const listedRow = convertSize(parsed.size, listedSystem, chart);
  const listedLabel = formatSize(parsed.size, listedSystem);
  if (!listedRow) {
    return unknownCheck("fit", `${listedLabel} isn't on the ${brand} size chart, so I can't compare it with your size.`, {
      evidence: listedEv,
      details: { listed: facts.sizeText, listedSystem, userSize: null, match: null },
    });
  }

  const evidence: Evidence[] = [...listedEv];
  const chartEv: Evidence = {
    id: nextId(),
    kind: "data_point",
    label: `${brand} size chart: ${formatSize(listedRow.uk, "UK")} = ${formatSize(listedRow.us, "US")} = ${formatSize(listedRow.eu, "EU")} (${listedRow.cm} cm)`,
    value: listedRow.cm,
  };

  const own = needs.sizes.find((s) => sameBrand(s.brand, brand));
  let status: CheckResult["status"];
  let match: FitMatch;
  let summary: string;
  let confidence: number;
  let userSizeLabel: string;

  if (own) {
    const userRow = convertSize(own.size, own.system, chart);
    userSizeLabel = `${formatSize(own.size, own.system)} (${own.brand})`;
    evidence.push({ id: nextId(), kind: "data_point", label: `Your saved ${own.brand} size: ${formatSize(own.size, own.system)}`, value: own.size });
    if (!userRow) {
      return unknownCheck("fit", `Your saved ${userSizeLabel} isn't on the ${brand} chart, so I can't compare.`, { evidence });
    }
    evidence.push(chartEv);
    // Count sizes by UK size, not chart rows: charts skip half sizes at the top (Nike UK 12 -> 13).
    const steps = Math.round(Math.abs(listedRow.uk - userRow.uk) * 2);
    const listedInYours = formatSize(sizeIn(listedRow, own.system), own.system);
    if (steps === 0) {
      status = "pass";
      match = "exact";
      summary = `Listed ${listedLabel} matches your ${brand} size.`;
      confidence = 0.95;
    } else if (steps === 1) {
      status = "warn";
      match = "close";
      summary = `Listed ${listedLabel} (${listedInYours}) is half a size ${listedRow.uk > userRow.uk ? "bigger" : "smaller"} than your ${brand} size.`;
      confidence = 0.9;
    } else {
      status = "fail";
      match = "mismatch";
      summary = `Listed ${listedLabel} (${listedInYours}) is ${steps / 2} sizes ${listedRow.uk > userRow.uk ? "bigger" : "smaller"} than your ${brand} size.`;
      confidence = 0.9;
    }
  } else {
    const other = crossBrand(needs, charts);
    if (!other) {
      return unknownCheck(
        "fit",
        needs.sizes.length
          ? `You haven't saved a ${brand} size and I can't convert your other sizes, so the fit is unknown.`
          : "You haven't saved any sizes, so I can't check the fit.",
        { evidence: [...evidence, chartEv], details: { listed: facts.sizeText, listedSystem, userSize: null, match: null } },
      );
    }
    userSizeLabel = `${formatSize(other.size.size, other.size.system)} (${other.size.brand})`;
    evidence.push(
      { id: nextId(), kind: "data_point", label: `Your saved ${other.size.brand} size: ${formatSize(other.size.size, other.size.system)} (${other.row.cm} cm)`, value: other.row.cm },
      chartEv,
    );
    const deltaCm = Math.round((listedRow.cm - other.row.cm) * 10) / 10;
    if (Math.abs(deltaCm) > 0.8) {
      status = "fail";
      match = "mismatch";
      summary = `Cross-brand estimate: listed ${listedLabel} is about ${Math.abs(deltaCm)} cm ${deltaCm > 0 ? "longer" : "shorter"} than your ${other.size.brand} size.`;
      confidence = 0.6;
    } else {
      status = "warn";
      match = "estimated";
      summary =
        Math.abs(deltaCm) <= 0.25
          ? `Cross-brand estimate: listed ${listedLabel} should be close to your ${other.size.brand} size, but you haven't saved a ${brand} size.`
          : `Cross-brand estimate: listed ${listedLabel} is about half a size ${deltaCm > 0 ? "bigger" : "smaller"} than your ${other.size.brand} size.`;
      confidence = 0.55;
    }
  }

  return {
    check: "fit",
    status,
    summary,
    evidence,
    confidence,
    geminiFeatures: [],
    details: {
      listed: facts.sizeText,
      listedSystem,
      userSize: userSizeLabel,
      match,
      listedUK: listedRow.uk,
    },
  };
}

export const SIZE_SYSTEM_QUESTION = "Is that a UK or US size?";

/** The user's size for this brand in `system`: their saved size for the brand, else a cross-brand estimate by length. */
function userSizeIn(input: FitInput, system: SizeSystem): { value: number; label: string; estimated: boolean; ev: Evidence[] } | null {
  const { needs, brand, chart, charts } = input;
  const own = needs.sizes.find((s) => sameBrand(s.brand, brand));
  if (own) {
    const ev: Evidence[] = [{ id: "fit_user", kind: "data_point", label: `Your saved ${own.brand} size: ${formatSize(own.size, own.system)}`, value: own.size }];
    if (own.system === system) return { value: own.size, label: formatSize(own.size, system), estimated: false, ev };
    const row = chart ? convertSize(own.size, own.system, chart) : null;
    return row ? { value: sizeIn(row, system), label: formatSize(sizeIn(row, system), system), estimated: false, ev } : null;
  }
  const other = crossBrand(needs, charts);
  if (!other || !chart) return null;
  const near = chart.rows.reduce<SizeChart["rows"][number] | null>((best, r) => (Math.abs(r.cm - other.row.cm) <= 0.25 && (!best || Math.abs(r.cm - other.row.cm) < Math.abs(best.cm - other.row.cm)) ? r : best), null);
  if (!near) return null;
  return {
    value: sizeIn(near, system),
    label: formatSize(sizeIn(near, system), system),
    estimated: true,
    ev: [{ id: "fit_user", kind: "data_point", label: `Your saved ${other.size.brand} size: ${formatSize(other.size.size, other.size.system)} (${other.row.cm} cm)`, value: other.row.cm }],
  };
}

const optionNumber = (v: string) => {
  const p = parseSizeText(v);
  return p ? p.size : NaN;
};

/** Multi-size listings (eBay variations): is the user's size offered, and is it in stock? */
function checkSizeOptions(input: FitInput, listedEv: Evidence[]): CheckResult {
  const opts = input.facts.sizeOptions!;
  const offered = opts.options.map((o) => o.value);
  const base = { sizeOptions: true, offered, listed: null, listedSystem: opts.system === "unknown" ? null : opts.system };
  if (opts.system === "unknown") {
    return {
      check: "fit",
      status: "warn",
      summary: `Size system not stated: the listing offers sizes ${offered.join(", ")} without saying UK, US or EU.`,
      evidence: listedEv,
      confidence: 0.4,
      geminiFeatures: [],
      details: { ...base, sizeSystemUnknown: true, match: null, userSize: null },
    };
  }
  const system = opts.system;
  const user = userSizeIn(input, system);
  if (!user) {
    return unknownCheck(
      "fit",
      input.needs.sizes.length ? `You haven't saved a ${input.brand} size I can compare with the ${opts.label.toLowerCase()} options.` : "You haven't saved any sizes, so I can't check the fit.",
      { evidence: listedEv, details: { ...base, match: null, userSize: null } },
    );
  }
  const option = opts.options.find((o) => Math.abs(optionNumber(o.value) - user.value) < 0.01);
  const range = `${formatSize(Math.min(...offered.map(optionNumber).filter(Number.isFinite)), system)} to ${formatSize(Math.max(...offered.map(optionNumber).filter(Number.isFinite)), system)}`;
  const evidence = [...listedEv, ...user.ev];
  const details = { ...base, userSize: user.label, estimated: user.estimated };
  if (!option) {
    return { check: "fit", status: "fail", summary: `Your size (${user.label}) isn't offered: this listing has ${range}.`, evidence, confidence: user.estimated ? 0.6 : 0.9, geminiFeatures: [], details: { ...details, match: "mismatch", available: false } };
  }
  if (option.outOfStock) {
    return { check: "fit", status: "fail", summary: `Your size (${user.label}) is out of stock.`, evidence, confidence: user.estimated ? 0.6 : 0.9, geminiFeatures: [], details: { ...details, match: "mismatch", available: false, outOfStock: true } };
  }
  return {
    check: "fit",
    status: user.estimated ? "warn" : "pass",
    summary: user.estimated
      ? `Your size is probably ${user.label} (a cross-brand estimate), and it's available.`
      : `Your size (${user.label}) is available.`,
    evidence,
    confidence: user.estimated ? 0.55 : 0.9,
    geminiFeatures: [],
    details: { ...details, match: user.estimated ? "estimated" : "exact", available: true, selectSize: user.label },
  };
}

/** A single listed size with no system: warn, say what each reading would mean, and ask the seller. */
function unknownSystemFit(size: number, input: FitInput, listedEv: Evidence[]): CheckResult {
  const { chart, brand } = input;
  const readings: string[] = [];
  const own = input.needs.sizes.find((s) => sameBrand(s.brand, brand));
  if (chart && own) {
    const userRow = convertSize(own.size, own.system, chart);
    for (const sys of ["UK", "US"] as const) {
      const row = convertSize(size, sys, chart);
      if (!row || !userRow) continue;
      const diff = Math.abs(row.uk - userRow.uk);
      readings.push(`as ${formatSize(size, sys)} it ${diff === 0 ? "matches your size" : `is ${diff === 0.5 ? "half a size" : diff === 1 ? "a size" : `${diff} sizes`} ${row.uk > userRow.uk ? "bigger" : "smaller"}`}`);
    }
  }
  return {
    check: "fit",
    status: "warn",
    summary: `Size system not stated: the listing says size ${size} without UK, US or EU${readings.length ? ` (${readings.join("; ")})` : ""}.`,
    evidence: listedEv,
    confidence: 0.4,
    geminiFeatures: [],
    details: { listed: input.facts.sizeText, listedSystem: null, sizeSystemUnknown: true, userSize: own ? formatSize(own.size, own.system) : null, match: null },
  };
}

function crossBrand(needs: UserNeeds, charts: SizeChart[]): { size: UserNeeds["sizes"][number]; row: ConvertedSize } | null {
  for (const s of needs.sizes) {
    const chart = charts.find((c) => sameBrand(c.brand, s.brand));
    if (!chart) continue;
    const row = convertSize(s.size, s.system, chart);
    if (row) return { size: s, row };
  }
  return null;
}

export type SizingAdvice = "runs_small" | "runs_large" | "true_to_size" | "unclear";

/** Comfort's review sizing advice may turn a fit pass into warn (spec 7.6). */
export function applyReviewSizingNote(fit: CheckResult, advice: SizingAdvice | undefined, note: string | undefined): CheckResult {
  if (!advice || advice === "unclear" || advice === "true_to_size") {
    return note && advice === "true_to_size" ? { ...fit, details: { ...fit.details, reviewSizingNote: note } } : fit;
  }
  const words = advice === "runs_small" ? "run small" : "run large";
  const next: CheckResult = { ...fit, details: { ...fit.details, reviewSizingNote: note ?? `Reviews say these ${words}.` } };
  if (fit.status === "pass") {
    next.status = "warn";
    next.summary = `${fit.summary} Reviews say these ${words}, so your usual size may not fit the same.`;
  }
  return next;
}
