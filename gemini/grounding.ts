import type { Evidence, EvidenceSourceType } from "@/schemas/domain";
import type { GroundingMeta } from "./client";

export type GroundedSource = {
  chunkIndex: number;
  url: string;
  title: string;
  domain: string;
  sourceType: EvidenceSourceType;
  /** Exact response text segments this source supports. */
  segments: string[];
};

const INDEPENDENT_REVIEW = [
  "runrepeat.com", "runnersworld.com", "runnersworld.co.uk", "believeintherun.com", "doctorsofrunning.com",
  "solereview.com", "roadtrailrun.com", "irunfar.com", "outdoorgearlab.com", "marathonhandbook.com",
  "runningshoesguru.com", "trustedreviews.com", "techradar.com", "t3.com", "wired.com", "wired.co.uk",
  "theguardian.com", "independent.co.uk", "telegraph.co.uk", "gq.com", "gq-magazine.co.uk", "esquire.com",
  "menshealth.com", "womenshealthmag.com", "verywellfit.com", "runningmagazine.ca", "fleetfeet.com",
  "weartesters.com", "sneakerfreaker.com", "highsnobiety.com", "complex.com", "hypebeast.com",
  "reddit.com", "youtube.com", "trustpilot.com", "coachweb.com", "livescience.com", "tomsguide.com",
  "runnerclick.com", "kicksonfire.com", "nicekicks.com", "sneakernews.com", "outsideonline.com",
];
const RETAILER = [
  "sportsshoes.com", "prodirectsport.com", "prodirectrunning.com", "jdsports.co.uk", "footlocker.co.uk",
  "footlocker.com", "zalando.co.uk", "amazon.co.uk", "amazon.com", "johnlewis.com", "schuh.co.uk",
  "office.co.uk", "size.co.uk", "endclothing.com", "runnersneed.com", "wiggle.com", "wiggle.co.uk",
  "sportsdirect.com", "asos.com", "very.co.uk", "argos.co.uk", "decathlon.co.uk", "startfitness.co.uk",
  "millets.co.uk", "cotswoldoutdoor.com", "allbeauty.com", "selfridges.com", "harrods.com", "next.co.uk",
  "zappos.com", "runningwarehouse.com", "runningwarehouse.eu", "sportpursuit.com", "mandmdirect.com",
  "tkmaxx.com", "kickgame.co.uk", "offspring.co.uk", "footasylum.com", "sneakersnstuff.com", "goat.com",
  "stockx.com", "flannels.com", "frasers.com", "houseoffraser.co.uk", "idealo.co.uk", "pricerunner.com",
  "google.com", "klarna.com",
];
const MANUFACTURER = [
  "nike.com", "adidas.co.uk", "adidas.com", "newbalance.co.uk", "newbalance.com", "asics.com", "hoka.com",
  "brooksrunning.com", "saucony.com", "on.com", "on-running.com", "puma.com", "salomon.com", "vans.co.uk",
  "vans.com", "converse.com", "reebok.co.uk", "reebok.com", "mizuno.com", "altrarunning.com",
  "drmartens.com", "clarks.co.uk", "veja-store.com", "allbirds.co.uk", "allbirds.com",
];

function matchesDomain(domain: string, list: string[]): boolean {
  return list.some((d) => domain === d || domain.endsWith("." + d));
}

/** Gemini API grounding chunks give a redirect URI; the title is usually the source domain. */
export function sourceDomain(chunk: { uri?: string; title?: string; domain?: string }): string {
  const candidates = [chunk.domain, chunk.title, chunk.uri];
  for (const c of candidates) {
    if (!c) continue;
    const m = /([a-z0-9-]+(?:\.[a-z0-9-]+)+)/i.exec(c.replace(/^https?:\/\//, ""));
    if (m && !/vertexaisearch|googleusercontent|grounding-api-redirect/.test(m[1])) return m[1].toLowerCase().replace(/^www\./, "");
  }
  return (chunk.title ?? "").toLowerCase();
}

/**
 * Domain heuristics first; the model's own hint is only used when the heuristic says "other",
 * and can never upgrade a known manufacturer/retailer domain to "independent_review".
 */
export function classifySource(domain: string, modelHint?: EvidenceSourceType): EvidenceSourceType {
  if (matchesDomain(domain, MANUFACTURER)) return "manufacturer";
  if (matchesDomain(domain, RETAILER)) return "retailer";
  if (matchesDomain(domain, INDEPENDENT_REVIEW)) return "independent_review";
  if (modelHint && modelHint !== "price_sample") return modelHint;
  return "other";
}

/** Parse grounding metadata into sources with the exact text segments each one supports. */
export function groundingSources(
  meta: GroundingMeta | undefined,
  hints: Record<string, EvidenceSourceType> = {},
): GroundedSource[] {
  const chunks = meta?.groundingChunks ?? [];
  const sources: GroundedSource[] = chunks.map((c, i) => {
    const web = c.web ?? {};
    const domain = sourceDomain(web);
    return {
      chunkIndex: i,
      url: web.uri ?? "",
      title: web.title ?? domain,
      domain,
      sourceType: classifySource(domain, hints[domain]),
      segments: [],
    };
  });
  for (const s of meta?.groundingSupports ?? []) {
    const text = s.segment?.text?.trim();
    if (!text) continue;
    for (const idx of s.groundingChunkIndices ?? []) {
      const src = sources[idx];
      if (src && !src.segments.includes(text)) src.segments.push(text);
    }
  }
  return sources.filter((s) => s.url);
}

/** Sources supporting a given line of the response text (segment overlap by text). */
export function sourcesForLine(sources: GroundedSource[], line: string): GroundedSource[] {
  const l = line.trim();
  if (!l) return [];
  return sources.filter((s) => s.segments.some((seg) => l.includes(seg) || seg.includes(l)));
}

export function sourceToEvidence(src: GroundedSource, id: string, observedOn: string, quote?: string): Evidence {
  return {
    id,
    kind: "source",
    label: `${labelFor(src.sourceType)}: ${src.title}`,
    url: src.url,
    title: src.title,
    sourceType: src.sourceType,
    quote: quote ?? src.segments[0],
    observedOn,
  };
}

function labelFor(t: EvidenceSourceType): string {
  switch (t) {
    case "independent_review":
      return "Independent review";
    case "manufacturer":
      return "Manufacturer";
    case "retailer":
      return "Retailer";
    case "price_sample":
      return "Price sample";
    default:
      return "Source";
  }
}

/** Parse "SOURCETYPES | runrepeat.com=independent_review; nike.com=manufacturer" hint lines. */
export function parseSourceTypeHints(text: string): Record<string, EvidenceSourceType> {
  const out: Record<string, EvidenceSourceType> = {};
  const line = text.split("\n").find((l) => /^\s*SOURCETYPES\s*\|/i.test(l));
  if (!line) return out;
  for (const pair of line.split("|")[1].split(/[;,]/)) {
    const [d, t] = pair.split("=").map((x) => x?.trim().toLowerCase());
    if (d && (t === "independent_review" || t === "manufacturer" || t === "retailer" || t === "other")) {
      out[d.replace(/^www\./, "")] = t;
    }
  }
  return out;
}
