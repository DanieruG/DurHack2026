import type { SizeSystem } from "@/schemas/domain";
import type { SizeChart, SizeRow } from "@/schemas/seed";

export type ConvertedSize = SizeRow & { index: number };

const KEY: Record<SizeSystem, keyof SizeRow> = { UK: "uk", US: "us", EU: "eu" };
// EU sizes come in thirds (44 2/3) and charts round them, so they need a wider tolerance.
const TOLERANCE: Record<SizeSystem, number> = { UK: 0.01, US: 0.01, EU: 0.35 };

/**
 * Convert a size in one system to the brand's full chart row. Exact code, no model involved.
 * Returns null when the size isn't on the chart.
 */
export function convertSize(size: number, system: SizeSystem, chart: SizeChart): ConvertedSize | null {
  const key = KEY[system];
  let best: ConvertedSize | null = null;
  let bestDelta = Infinity;
  chart.rows.forEach((row, index) => {
    const delta = Math.abs(row[key] - size);
    if (delta <= TOLERANCE[system] && delta < bestDelta) {
      best = { ...row, index };
      bestDelta = delta;
    }
  });
  return best;
}

/** Nearest chart row for a foot length in cm (cross-brand estimates). */
export function rowForCm(cm: number, chart: SizeChart): ConvertedSize | null {
  let best: ConvertedSize | null = null;
  let bestDelta = Infinity;
  chart.rows.forEach((row, index) => {
    const delta = Math.abs(row.cm - cm);
    if (delta < bestDelta) {
      best = { ...row, index };
      bestDelta = delta;
    }
  });
  return bestDelta <= 1 ? best : null;
}

export function sizeIn(row: SizeRow, system: SizeSystem): number {
  return row[KEY[system]];
}

const FRACTIONS: Record<string, number> = { "½": 0.5, "⅓": 1 / 3, "⅔": 2 / 3, "¼": 0.25, "¾": 0.75 };

export type ParsedSize = { size: number; system: SizeSystem | "unknown" };

/**
 * Parse listing size text such as "UK 9", "9.5", "EU 44 2/3", "44⅔", "US M 10", "Size: 8½ (EU 42.5)".
 * Returns the first size found, preferring one with an explicit system.
 */
export function parseSizeText(text: string | undefined, hintSystem?: SizeSystem | "unknown"): ParsedSize | null {
  if (!text) return null;
  const normalised = text
    .replace(/[½⅓⅔¼¾]/g, (m) => ` ${FRACTIONS[m]}`)
    .replace(/(\d+)\s+(\d)\/(\d)/g, (_, a, b, c) => String(Number(a) + Number(b) / Number(c)))
    .replace(/(\d+)\s+0?\.(\d+)/g, "$1.$2")
    .replace(/(\d)\s+(0\.\d+)/g, (_, a, b) => String(Number(a) + Number(b)));

  const withSystem = /\b(UK|US|EU|EUR)(?![a-z])[\s:]*(?:[MW]\s*)?(\d{1,2}(?:\.\d+)?)/i.exec(normalised);
  if (withSystem) {
    const sys = withSystem[1].toUpperCase() === "EUR" ? "EU" : (withSystem[1].toUpperCase() as SizeSystem);
    return { size: round(Number(withSystem[2])), system: sys };
  }
  const trailing = /(\d{1,2}(?:\.\d+)?)\s*(UK|US|EU)(?![a-z])/i.exec(normalised);
  if (trailing) return { size: round(Number(trailing[1])), system: trailing[2].toUpperCase() as SizeSystem };

  const bare = /(\d{1,2}(?:\.\d+)?)/.exec(normalised);
  if (!bare) return null;
  const size = round(Number(bare[1]));
  if (!(size > 0 && size < 60)) return null;
  let system: SizeSystem | "unknown" = hintSystem ?? "unknown";
  // A bare number of 35+ can only be EU for adult trainers.
  if (system === "unknown" && size >= 35) system = "EU";
  return { size, system };
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

export function formatSize(size: number, system: SizeSystem): string {
  const whole = Math.floor(size);
  const frac = size - whole;
  if (system === "EU" && Math.abs(frac - 2 / 3) < 0.05) return `EU ${whole} 2/3`;
  if (system === "EU" && Math.abs(frac - 1 / 3) < 0.05) return `EU ${whole} 1/3`;
  return `${system} ${Number.isInteger(size) ? size : size.toFixed(1)}`;
}
