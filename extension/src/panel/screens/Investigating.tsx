import { CHECK_NAMES, elapsed } from "../../lib/format";
import { caseLabel } from "../../lib/history";
import { segments, type Investigation } from "../../lib/progress";
import { Button, Notice, Tags } from "../ui";

export function Investigating(props: {
  caseId: string;
  title: string;
  inv: Investigation;
  lost?: boolean;
  onRetry?: () => void;
}) {
  const { inv } = props;
  const segs = segments(inv);
  const doneCount = segs.filter((s) => s.done).length;
  const status = inv.revision > 1 ? "Reopened" : "Investigating";

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
