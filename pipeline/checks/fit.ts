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
  const listedEv = facts.evidence.filter((e) => e.label.startsWith("Listed size"));
  const parsed = parseSizeText(facts.sizeText, facts.sizeSystem === "unknown" ? undefined : facts.sizeSystem);
  if (!parsed) {
    return unknownCheck("fit", "The listing doesn't state a size, so I can't check the fit.", {
      details: { listed: null, listedSystem: null, userSize: null, match: null },
    });
  }
  if (!chart) {
    return unknownCheck("fit", `I don't have a ${brand} size chart to check the fit against.`, { evidence: listedEv });
  }
  const assumedSystem = parsed.system === "unknown";
  const listedSystem: SizeSystem = assumedSystem ? "UK" : parsed.system as SizeSystem;
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
    const steps = Math.abs(listedRow.index - userRow.index);
    const listedInYours = formatSize(sizeIn(listedRow, own.system), own.system);
    if (steps === 0) {
      status = "pass";
      match = "exact";
      summary = `Listed ${listedLabel} matches your ${brand} size.`;
      confidence = 0.95;
    } else if (steps === 1) {
      status = "warn";
      match = "close";
      summary = `Listed ${listedLabel} (${listedInYours}) is half a size ${listedRow.index > userRow.index ? "bigger" : "smaller"} than your ${brand} size.`;
      confidence = 0.9;
    } else {
      status = "fail";
      match = "mismatch";
      summary = `Listed ${listedLabel} (${listedInYours}) is ${steps / 2} sizes ${listedRow.index > userRow.index ? "bigger" : "smaller"} than your ${brand} size.`;
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

  if (assumedSystem) {
    if (status === "pass") status = "warn";
    summary += " The listing doesn't say UK, US or EU, so I assumed UK.";
    confidence = Math.min(confidence, 0.6);
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
      listedSystemAssumed: assumedSystem,
      userSize: userSizeLabel,
      match,
      listedUK: listedRow.uk,
    },
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
