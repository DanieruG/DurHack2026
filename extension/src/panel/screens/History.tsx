import type { HistoryRow } from "../../lib/history";
import { gbp, PLATFORM_NAMES, shortDate } from "../../lib/format";
import { VERDICTS } from "../../lib/verdicts";
import { Notice } from "../ui";

export function History(props: {
  rows: HistoryRow[];
  loading: boolean;
  error: string | null;
  onOpen: (caseId: string) => void;
  onRemove: (caseId: string) => void;
}) {
  return (
    <div className="screen">
      <h1 className="h1">History</h1>
      <p className="device-note">Your history is stored on this device.</p>

      {props.error && <Notice tone="problem">{props.error}</Notice>}
      {!props.loading && !props.error && props.rows.length === 0 && <p className="lede history-empty">No cases yet. Open a listing and click Investigate.</p>}

      {props.rows.length > 0 && (
        <ol className="history" aria-label="Previous cases">
          {props.rows.map(({ entry, summary: s }) => {
            const verdict = s.verdictLabel ? VERDICTS[s.verdictLabel] : null;
            const meta = [s.priceGBP !== undefined ? gbp(s.priceGBP) : null, PLATFORM_NAMES[s.platform], shortDate(entry.createdAt)].filter(Boolean).join(" · ");
            return (
              <li key={entry.caseId} className="h-item">
                <button type="button" className="h-open" onClick={() => props.onOpen(entry.caseId)}>
                  <span className="thumb">{s.thumbnailUrl ? <img src={s.thumbnailUrl} alt="" /> : null}</span>
                  <span className="h-text">
                    <span className="h-title">{s.title || "Untitled listing"}</span>
                    <span className="h-meta">{meta}</span>
                    <span className="h-stamps">
                      <span className={`stamp t-${verdict?.treatment ?? "pending"}`}>{verdict ? verdict.title : s.status === "investigating" ? "In progress" : "No verdict"}</span>
                      {s.revision > 1 && <span className="stamp-note mono">Reopened · Rev {s.revision}</span>}
                    </span>
                  </span>
                </button>
                <div className="h-actions">
                  {s.pageUrl && (
                    <a className="btn btn-text btn-small" href={s.pageUrl} target="_blank" rel="noreferrer">
                      View listing
                    </a>
                  )}
                  <button type="button" className="btn btn-text btn-small" onClick={() => props.onRemove(entry.caseId)}>
                    Remove from history
                  </button>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
