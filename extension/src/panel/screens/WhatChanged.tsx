import type { CaseDiff, CheckStatus } from "@/schemas/domain";
import { describeDiff } from "../../lib/changes";
import { caseNumber, STATUS_WORDS } from "../../lib/format";
import { VERDICTS } from "../../lib/verdicts";
import { Button, Label, StatusMark, Verdict } from "../ui";

const asStatus = (s: string): CheckStatus => (s in STATUS_WORDS ? (s as CheckStatus) : "unknown");

export function WhatChanged(props: { number: number; diff: CaseDiff; headline?: string; onOpenFile: () => void }) {
  const { diff } = props;
  const { line, changes } = describeDiff(diff);
  const moved = diff.verdict.before !== diff.verdict.after;

  return (
    <div className="screen">
      <div className="file-head">
        <span className="mono">{caseNumber(props.number)}</span>
        <span className="mono dim">Rev {diff.toRevision}</span>
      </div>
      <p className="kicker">What changed</p>

      {moved && <p className="was">{VERDICTS[diff.verdict.before].title}</p>}
      <Verdict label={diff.verdict.after} headline={line} />

      {changes.length > 0 && (
        <section className="block">
          <Label>Findings</Label>
          <ul className="changes">
            {changes.map((c) => (
              <li key={c.check}>
                <span className="ch-name">{c.name}</span>
                <span className="ch-move">
                  <StatusMark status={asStatus(c.before)} />
                  <span className="dim">{STATUS_WORDS[asStatus(c.before)]}</span>
                  <span className="arrow" aria-label="to">→</span>
                  <StatusMark status={asStatus(c.after)} />
                  <span>{STATUS_WORDS[asStatus(c.after)]}</span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {props.headline && <p className="lede">{props.headline}</p>}

      <div className="foot">
        <Button wide onClick={props.onOpenFile}>
          Open case file
        </Button>
      </div>
    </div>
  );
}
