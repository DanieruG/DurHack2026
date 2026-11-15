import { useRef } from "react";
import { CHECK_NAMES, elapsed } from "../../lib/format";
import { caseLabel } from "../../lib/history";
import { offersSlot, segments, type Investigation } from "../../lib/progress";
import { OffersSlot, TopResultsList } from "../offers";
import type { TopResultsBlock } from "../../lib/survey";
import { Button, Notice, Tags } from "../ui";
import type { IdentityChoice } from "@/schemas/api";
import { IdentityCard } from "./IdentityCard";

export function Investigating(props: {
  caseId: string;
  title: string;
  inv: Investigation;
  lost?: boolean;
  onRetry?: () => void;
  /** Answer the "Is this the right item?" card. */
  onConfirm?: (choice: IdentityChoice) => void;
  /** The answer already sent: the card locks and the investigation continues below it. */
  answered?: IdentityChoice | null;
  confirmError?: string | null;
  /** Other good listings from the buyer's search, shown while the case runs or waits. */
  topResults?: TopResultsBlock | null;
  onInvestigateListing?: (url: string) => void;
}) {
  const { inv } = props;
  const segs = segments(inv);
  const doneCount = segs.filter((s) => s.done).length;
  const status = inv.revision > 1 ? "Reopened" : "Investigating";
  const offers = offersSlot(inv);
  // Once answered, the card stays (locked) for the rest of the run so nothing below it moves.
  const asked = useRef(inv.identityCheck);
  if (inv.identityCheck) asked.current = inv.identityCheck;
  const question = inv.identityCheck ?? (props.answered ? asked.current : null);

  return (
    <div className="screen">
      <p className="kicker">{props.title}</p>
      <h1 className="h1 case-no">{caseLabel(props.caseId)}</h1>
      <p className="status-line">
        {status}
        {segs.length ? ` · ${doneCount} of ${segs.length}` : ""}
      </p>

      {segs.length > 0 && (
        <div className="strip" role="progressbar" aria-valuemin={0} aria-valuemax={segs.length} aria-valuenow={doneCount}>
          {segs.map((s) => (
            <span key={s.check} className={s.done ? "seg done" : "seg"} title={CHECK_NAMES[s.check]} />
          ))}
        </div>
      )}

      {question && props.onConfirm && <IdentityCard question={question} onConfirm={props.onConfirm} answered={props.answered} error={props.confirmError} />}

      <ol className="log" aria-live="polite">
        {inv.log.map((l) => (
          <li key={l.key} className={`log-line ${l.kind} ${l.state}`}>
            <span className="log-t mono">{elapsed(l.at - inv.startedAt)}</span>
            <span className="log-m" aria-hidden="true" />
            <span className="log-text">
              {l.text}
              {l.note && <span className="log-note">{l.note}</span>}
              {l.tags && l.tags.length > 0 && <Tags tags={l.tags} />}
            </span>
          </li>
        ))}
      </ol>

      {offers.show && <OffersSlot data={offers.data} />}

      {props.topResults && props.topResults.results.length > 0 && (
        <TopResultsList results={props.topResults.results} platformName={props.topResults.platformName} heading="Other high-potential results" footnote={props.topResults.footnote} onInvestigate={props.onInvestigateListing} />
      )}

      {(inv.fatal || props.lost) && (
        <div className="foot">
          <Notice tone="problem">{inv.fatal ?? "Lost the connection to the Sleuth server."}</Notice>
          {props.onRetry && (
            <Button kind="secondary" wide onClick={props.onRetry}>
              Try again
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
