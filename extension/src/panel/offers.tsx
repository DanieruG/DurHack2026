import { useState, type ReactNode } from "react";
import type { NewOffer, NewOffers, ObservedAlternative, ObservedAlternatives } from "@/schemas/domain";
import { gbp, PLATFORM_NAMES } from "../lib/format";
import { colourLabel, differenceText, notEnoughLine, offerLabel, offersFootnote, OFFERS_SHOWN, openableOffers, safeHref, safeThumbnail } from "../lib/offers";
import { alternativeLabel, alternativesView, ALTERNATIVES_TITLE, alternativeTags, POSTAGE_LABEL, sizeLabel } from "../lib/alternatives";
import type { TopResult } from "../lib/topResults";
import { Button, Label } from "./ui";

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

/**
 * The card both new-price offers and surveyed listings use: thumbnail, a two-line title, where it's from, the difference
 * from this listing, then the price column. The whole card opens `href` in a new tab. Without an action the card is
 * itself the one link; with one (Investigate) the title link is stretched over the card and the button sits above it,
 * so there is still exactly one link and no control inside a link.
 */
export function ListingCard(props: {
  href: string;
  label: string;
  thumbnailUrl?: string;
  title: string;
  source: ReactNode;
  difference: string;
  extra?: ReactNode;
  side: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  const body = (
    <>
      <OfferThumb url={props.thumbnailUrl} />
      <span className="offer-text">
        {props.action ? (
          <a className="offer-title offer-link" href={props.href} target="_blank" rel="noopener noreferrer" aria-label={props.label}>
            {props.title}
          </a>
        ) : (
          <span className="offer-title">{props.title}</span>
        )}
        <span className="offer-retailer">{props.source}</span>
        <span className="offer-diff">{props.difference}</span>
        {props.extra}
      </span>
      <span className="offer-side">
        {props.side}
        {props.action}
      </span>
    </>
  );
  const cls = `offer${props.className ? ` ${props.className}` : ""}`;
  return props.action ? (
    <div className={`${cls} offer-has-action`}>{body}</div>
  ) : (
    <a className={cls} href={props.href} target="_blank" rel="noopener noreferrer" aria-label={props.label}>
      {body}
    </a>
  );
}

/** One retailer offer: the whole card is a single link to the retailer page, opening in a new tab. */
function OfferCard({ offer: o }: { offer: NewOffer }) {
  return (
    <ListingCard
      href={safeHref(o.url)!}
      label={offerLabel(o)}
      thumbnailUrl={o.thumbnailUrl}
      title={o.title}
      source={o.retailer}
      difference={differenceText(o.differenceGBP)}
      side={
        <>
          <span className="offer-price">{gbp(o.priceGBP)}</span>
          <span className={`offer-colour offer-colour-${o.colourMatch ?? "unknown"}`} title={o.colourEvidence}>
            {colourLabel(o)}
          </span>
          {o.isLowest && <span className="tag offer-lowest">Lowest</span>}
        </>
      }
    />
  );
}

/** One cheaper listing from the user's survey: opens the listing in a new tab; Investigate opens it and investigates it. */
function AlternativeCard({ alt: a, onInvestigate }: { alt: ObservedAlternative; onInvestigate?: (url: string) => void }) {
  const size = sizeLabel(a);
  const href = safeHref(a.url)!;
  return (
    <ListingCard
      className="alt"
      href={href}
      label={alternativeLabel(a)}
      thumbnailUrl={a.thumbnailUrl}
      title={a.title}
      source={
        <>
          {PLATFORM_NAMES[a.platform]} · <span className={size.flag ? "flag" : ""}>{size.text}</span>
        </>
      }
      difference={differenceText(a.differenceGBP)}
      extra={
        <span className="offer-tags">
          {alternativeTags(a).map((t, i) => (
            <span key={t.text} className={t.flag ? "flag" : ""}>
              {i > 0 ? " · " : ""}
              {t.text}
            </span>
          ))}
        </span>
      }
      side={
        <>
          <span className="offer-price">{gbp(a.priceGBP)}</span>
          <span className="offer-colour">{POSTAGE_LABEL}</span>
        </>
      }
      action={
        <Button kind="secondary" small label={`Investigate ${a.title}`} onClick={() => onInvestigate ? onInvestigate(href) : window.open(href, "_blank", "noopener")}>
          Investigate
        </Button>
      }
    />
  );
}

/**
 * "Worth looking at", under the Price exhibit: cheaper listings from the user's own survey, three cards then "Show all",
 * and the line saying where they came from. One quiet line instead when there was no survey, or nothing qualified.
 */
export function AlternativeCards({ data, onInvestigate }: { data: ObservedAlternatives | null | undefined; onInvestigate?: (url: string) => void }) {
  const [all, setAll] = useState(false);
  const view = alternativesView(data);
  return (
    <section className="alts" aria-label={ALTERNATIVES_TITLE}>
      <Label>{ALTERNATIVES_TITLE}</Label>
      {view.kind === "empty" ? (
        <p className="offers-note dim">{view.line}</p>
      ) : (
        <div className="offers">
          <ul className="offer-list" aria-label="Cheaper listings from your search">
            {(all ? view.alternatives : view.alternatives.slice(0, OFFERS_SHOWN)).map((a) => (
              <li key={a.listingId}>
                <AlternativeCard alt={a} onInvestigate={onInvestigate} />
              </li>
            ))}
          </ul>
          {view.alternatives.length > OFFERS_SHOWN && (
            <button type="button" className="btn btn-text offers-more" aria-expanded={all} onClick={() => setAll((x) => !x)}>
              {all ? "Show fewer" : `Show all ${view.alternatives.length}`}
            </button>
          )}
          {view.footnote && <p className="offers-note dim">{view.footnote}</p>}
        </div>
      )}
    </section>
  );
}

/**
 * The best-value listings from the buyer's own search (see lib/topResults.ts): thumbnail, title, price, size and why it was
 * picked, each opening the listing in a new tab, with an Investigate button. Not investigated, not compared with this pair.
 */
export function TopResultsList({
  results,
  platformName,
  heading,
  onInvestigate,
  footnote,
  pageSize,
}: {
  results: TopResult[];
  platformName: string;
  heading: string;
  onInvestigate?: (url: string) => void;
  footnote?: string | null;
  /** Page through the results ("Show next 8") instead of "Show all". */
  pageSize?: number;
}) {
  const [all, setAll] = useState(false);
  const [page, setPage] = useState(0);
  const usable = results.filter((r) => safeHref(r.card.url));
  if (!usable.length) return null;
  const pages = pageSize ? Math.ceil(usable.length / pageSize) : 1;
  const here = Math.min(page, pages - 1);
  const shown = pageSize ? usable.slice(here * pageSize, (here + 1) * pageSize) : all ? usable : usable.slice(0, TOP_SHOWN);
  return (
    <section className="alts top-results" aria-label={heading}>
      <Label>{heading}</Label>
      <div className="offers">
        <ul className="offer-list" aria-label={`${heading}, best value first`}>
          {shown.map((r) => {
            const href = safeHref(r.card.url)!;
            return (
              <li key={r.card.id}>
                <ListingCard
                  href={href}
                  label={`${r.card.title}, ${gbp(r.card.price ?? 0)}, ${r.reason}, opens in a new tab`}
                  thumbnailUrl={r.card.thumbnailUrl}
                  title={r.card.title}
                  source={`${platformName} · ${r.sizeLabel}`}
                  difference={r.reason}
                  side={<span className="offer-price">{gbp(r.card.price ?? 0)}</span>}
                  action={
                    <Button kind="secondary" small label={`Investigate ${r.card.title}`} onClick={() => (onInvestigate ? onInvestigate(href) : window.open(href, "_blank", "noopener"))}>
                      Investigate
                    </Button>
                  }
                />
              </li>
            );
          })}
        </ul>
        {pageSize && pages > 1 && (
          <div className="offers-pager">
            {here < pages - 1 && (
              <button type="button" className="btn btn-text offers-more" onClick={() => setPage(here + 1)}>
                {`Show next ${Math.min(pageSize, usable.length - (here + 1) * pageSize)}`}
              </button>
            )}
            {here > 0 && (
              <button type="button" className="btn btn-text offers-more" onClick={() => setPage(0)}>
                Back to top
              </button>
            )}
            <span className="dim mono pager-count">{`${here * pageSize + 1}-${Math.min((here + 1) * pageSize, usable.length)} of ${usable.length}`}</span>
          </div>
        )}
        {!pageSize && usable.length > TOP_SHOWN && (
          <button type="button" className="btn btn-text offers-more" aria-expanded={all} onClick={() => setAll((x) => !x)}>
            {all ? "Show fewer" : `Show all ${usable.length}`}
          </button>
        )}
        {footnote && <p className="offers-note dim">{footnote}</p>}
      </div>
    </section>
  );
}

/** Cards shown before "Show all". */
export const TOP_SHOWN = 5;

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
      {data.colourNote && <p className="offers-note">{data.colourNote}.</p>}
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
