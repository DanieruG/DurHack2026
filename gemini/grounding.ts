import type { Evidence, EvidenceSourceType } from "@/schemas/domain";

/** A cited web source (for comfort: one SerpApi search result, chunkIndex = its 1-based result number). */
export type GroundedSource = {
  chunkIndex: number;
  url: string;
  title: string;
  domain: string;
  sourceType: EvidenceSourceType;
  /** Verbatim text quoted from this source (comfort: phrases from its search snippet). */
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

export function sourceToEvidence(src: GroundedSource, id: string, observedOn: string, quote?: string): Evidence {
  return {
    id,
    kind: "source",
    label: `${labelFor(src.sourceType)}: ${src.title}`,
    url: src.url,
    ...(src.domain && !/^result-\d+$/.test(src.domain) ? { domain: src.domain } : {}),
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
