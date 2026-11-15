import { detectPlatform } from "@/lib/platform";
import type { ExtractedListing, MarketplacePage } from "./common";
import { extractEbay } from "./ebay";
import { extractVinted } from "./vinted";

export type { ExtractedListing, MarketplacePage, PageFields, EmbeddedScripts } from "./common";

/** This listing's fields from the page's own data, for the platforms we read structurally; null elsewhere. */
export function extractListing(page: MarketplacePage): ExtractedListing | null {
  switch (detectPlatform(page.pageUrl)) {
    case "ebay":
      return extractEbay(page);
    case "vinted":
      return extractVinted(page);
    default:
      return null;
  }
}
