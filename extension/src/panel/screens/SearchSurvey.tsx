import type { SearchPage } from "../../lib/survey";
import { PLATFORM_NAMES } from "../../lib/format";
import { explainResults, type ResultCounts, type TopResult } from "../../lib/topResults";
import { TopResultsList } from "../offers";
import { useEffect, useState } from "react";
import { Button, Notice } from "../ui";

/** Results shown per page on the search screen ("Show next 8"). */
export const RESULTS_PAGE = 8;

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
  /** What was read and what was left out, for the line under the heading (never silent). */
  counts?: ResultCounts | null;
  /** The "Colour or look" for this search, asked here so it can shape the results before one is picked. */
  colour?: string;
  onColour?: (colour: string) => void;
  /** Thumbnails being read for colour ("Checking photos 12/24"), while it runs. */
  photoProgress?: { done: number; total: number } | null;
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
      {props.onColour && <ColourBox value={props.colour ?? ""} onChange={props.onColour} progress={props.photoProgress ?? null} />}

      <p className="note">Sleuth reads the results on this page by itself. When you investigate a listing, it compares it with the others it saw.</p>

      {props.summary && (
        <section className="block survey-result" aria-live="polite">
          <p className="survey-summary">{props.summary}</p>
          {props.added !== null && <p className="note dim">{props.added === 0 ? "No new listings since your last survey." : `${props.added} new listing${props.added === 1 ? "" : "s"} added.`}</p>}
          <p className="note dim">Scroll or load more results, then read the page again to add them.</p>
        </section>
      )}

      {props.top && props.top.length > 0 ? (
        <TopResultsList
          results={props.top}
          platformName={PLATFORM_NAMES[page.platform]}
          heading="Top results from this search"
          pageSize={RESULTS_PAGE}
          onInvestigate={props.onInvestigate}
          footnote="Best value first, from the listings Sleuth saw. None has been investigated."
        />
      ) : (
        !props.summary && <p className="note dim">Reading the results on this page…</p>
      )}
      {props.counts && props.counts.read > 0 && (
        <p className="note dim results-explain" aria-live="polite">
          {explainResults(props.counts)}
        </p>
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

/** "Colour or look", before a listing is picked: results re-rank as you type (after a short pause). */
function ColourBox(props: { value: string; onChange: (v: string) => void; progress: { done: number; total: number } | null }) {
  const [draft, setDraft] = useState(props.value);
  // A different search brings its own saved colour.
  useEffect(() => setDraft(props.value), [props.value]);
  useEffect(() => {
    if (draft === props.value) return;
    const t = setTimeout(() => props.onChange(draft), COLOUR_DEBOUNCE_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);
  return (
    <section className="block search-colour">
      <label className="field-label" htmlFor="search-colour">
        Colour or look
      </label>
      <input id="search-colour" className="input" maxLength={100} placeholder="e.g. all white, nothing neon" value={draft} onChange={(e) => setDraft(e.target.value)} aria-describedby="search-colour-hint" />
      <p className="note dim field-hint" id="search-colour-hint" aria-live="polite">
        {props.progress ? `Checking photos ${props.progress.done}/${props.progress.total}…` : "Sleuth ranks the results by this, and checks it again when you investigate one."}
      </p>
    </section>
  );
}

export const COLOUR_DEBOUNCE_MS = 400;
