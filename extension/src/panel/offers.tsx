import { useState } from "react";
import type { NewOffer, NewOffers } from "@/schemas/domain";
import { gbp } from "../lib/format";
import { differenceText, notEnoughLine, offerLabel, offersFootnote, OFFERS_SHOWN, openableOffers, safeHref, safeThumbnail } from "../lib/offers";

/** Product thumbnail, or a plain block when there is none or it fails to load. */
function OfferThumb({ url }: { url?: string }) {
  const [failed, setFailed] = useState(false);
  const src = safeThumbnail(url);
  if (!src || failed) return <span className="offer-thumb offer-thumb-none" aria-hidden="true" />;
  return (
    <span className="offer-thumb" aria-hidden="true">
      <img src={src} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} />
    </span>
  );
}

/** One retailer offer: the whole card is a single link to the retailer page, opening in a new tab. */
function OfferCard({ offer: o }: { offer: NewOffer }) {
  return (
    <a className="offer" href={safeHref(o.url)!} target="_blank" rel="noopener noreferrer" aria-label={offerLabel(o)}>
      <OfferThumb url={o.thumbnailUrl} />
      <span className="offer-text">
        <span className="offer-title">{o.title}</span>
        <span className="offer-retailer">{o.retailer}</span>
        <span className="offer-diff">{differenceText(o.differenceGBP)}</span>
      </span>
      <span className="offer-side">
        <span className="offer-price">{gbp(o.priceGBP)}</span>
        {o.isLowest && <span className="tag offer-lowest">Lowest</span>}
      </span>
    </a>
  );
}

/** Up to three offer cards, "Show all" for the rest, and the date and caveats line. */
export function OfferCards({ data }: { data: NewOffers }) {
  const [all, setAll] = useState(false);
  const offers = openableOffers(data);
  if (!offers.length) return null;
  const shown = all ? offers : offers.slice(0, OFFERS_SHOWN);
  const notEnough = notEnoughLine(data);
  return (
    <div className="offers">
      <ul className="offer-list" aria-label="New prices from UK retailers">
        {shown.map((o) => (
          <li key={`${o.retailer}|${o.url}`}>
            <OfferCard offer={o} />
          </li>
        ))}
      </ul>
      {offers.length > OFFERS_SHOWN && (
        <button type="button" className="btn btn-text offers-more" aria-expanded={all} onClick={() => setAll((x) => !x)}>
          {all ? "Show fewer offers" : `Show all ${offers.length} offers`}
        </button>
      )}
      {notEnough && <p className="offers-note">{notEnough}</p>}
      <p className="offers-note dim">{offersFootnote(data.checkedOn)}</p>
    </div>
  );
}

/**
 * The live slot on the investigation screen: reserved (fixed height, placeholder cards) from the moment the price check
 * starts, so the cards drop in place when new_offers arrives without moving anything.
 */
export function OffersSlot({ data }: { data: NewOffers | null }) {
  return (
    <section className="offers-slot" aria-label="New prices" aria-busy={!data}>
      <p className="label">New prices</p>
      {data ? (
        <OfferCards data={data} />
      ) : (
        <div className="offers" aria-hidden="true">
          <ul className="offer-list">
            {Array.from({ length: OFFERS_SHOWN }, (_, i) => (
              <li key={i}>
                <span className="offer offer-pending" />
              </li>
            ))}
          </ul>
          <p className="offers-note dim">Checking UK retailers</p>
        </div>
      )}
    </section>
  );
}
