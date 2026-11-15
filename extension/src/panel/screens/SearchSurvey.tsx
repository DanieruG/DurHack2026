import type { SearchPage } from "../../lib/survey";
import { PLATFORM_NAMES } from "../../lib/format";
import type { TopResult } from "../../lib/topResults";
import { TopResultsList } from "../offers";
import { Button, Notice } from "../ui";

export const SURVEY_STORAGE_NOTE = "Your surveys are stored on this device";

/**
 * A marketplace search results page: one click surveys the listings shown. Surveying again (after scrolling or loading
 * more) adds the new cards to the same survey.
 */
export function SearchSurvey(props: {
  page: SearchPage;
  /** "Surveyed 38 listings · 21 in your size · 6 couldn't be matched to a model yet", once surveyed. */
  summary: string | null;
  /** Cards added by the latest click (shown after a repeat survey). */
  added: number | null;
  busy: boolean;
  error: string | null;
  onSurvey: () => void;
  /** The best-value results from the survey so far (lib/topResults.ts). */
  top?: TopResult[];
  onInvestigate?: (url: string) => void;
}) {
  const { page } = props;
  return (
    <div className="screen">
      <h1 className="h1">Search results</h1>
      <p className="lede">
        {PLATFORM_NAMES[page.platform]}
        {page.query ? ` · “${page.query}”` : ""}
      </p>
      <p className="note">Sleuth reads the results on this page by itself. When you investigate a listing, it compares it with the others it saw.</p>

      {props.summary && (
        <section className="block survey-result" aria-live="polite">
          <p className="survey-summary">{props.summary}</p>
          {props.added !== null && <p className="note dim">{props.added === 0 ? "No new listings since your last survey." : `${props.added} new listing${props.added === 1 ? "" : "s"} added.`}</p>}
          <p className="note dim">Scroll or load more results, then read the page again to add them.</p>
        </section>
      )}

      {props.top && props.top.length > 0 ? (
        <TopResultsList results={props.top} platformName={PLATFORM_NAMES[page.platform]} heading="Top results from this search" onInvestigate={props.onInvestigate} footnote="Best value first, from the listings Sleuth saw. None has been investigated." />
      ) : (
        !props.summary && <p className="note dim">Reading the results on this page…</p>
      )}

      <div className="foot">
        {props.error && <Notice tone="problem">{props.error}</Notice>}
        <Button wide onClick={props.onSurvey} disabled={props.busy}>
          {props.busy ? "Reading" : "Read this page again"}
        </Button>
        <p className="note dim survey-storage">{SURVEY_STORAGE_NOTE}.</p>
      </div>
    </div>
  );
}
