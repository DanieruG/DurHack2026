import { useState, type ReactNode } from "react";
import type { CaseDetail } from "@/schemas/api";
import type { CheckName, CheckResult } from "@/schemas/domain";
import { caseNumber, CHECK_NAMES, gbp, PLATFORM_NAMES } from "../../lib/format";
import { conditionView, evidenceLines, priceView, sourceRefs, type SourceRef } from "../../lib/evidence";
import { Button, CopyButton, Label, Notice, StatusMark, Verdict } from "../ui";

const ORDER: CheckName[] = ["condition", "fit", "comfort", "price"];

type RowKey = CheckName | "reasoning";

export type EvidenceDraft = { sellerReply: string; files: File[]; tabTitle: string | null };

export function CaseFile(props: {
  number: number;
  detail: CaseDetail;
  listing: { title: string; priceGBP: number | null };
  initialOpen?: RowKey[];
  addEvidence: {
    busy: boolean;
    error: string | null;
    /** Capture the active tab (e.g. the seller conversation) as extra evidence. Returns its title. */
    onCaptureTab: () => Promise<string | null>;
    onSubmit: (d: EvidenceDraft) => void;
  };
  initialAdding?: boolean;
}) {
  const { detail } = props;
  const [open, setOpen] = useState<Set<RowKey>>(new Set(props.initialOpen ?? []));
  const [adding, setAdding] = useState(props.initialAdding ?? false);
  const toggle = (k: RowKey) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });

  const byName = new Map(detail.checks.map((c) => [c.check, c]));
  const identify = byName.get("identify");
  const rows = [...(identify && identify.status !== "pass" ? [identify] : []), ...ORDER.map((n) => byName.get(n)).filter((c): c is CheckResult => !!c)];
  const questions = detail.nextMoves.filter((m) => m.kind === "ask_seller");
  const beforePay = detail.nextMoves.filter((m) => m.kind === "before_you_pay");
  const price = props.listing.priceGBP ?? detail.listingFacts?.priceGBP ?? null;
  const title = detail.listingFacts?.title || props.listing.title;

  return (
    <div className="screen">
      <div className="file-head">
        <span className="mono">{caseNumber(props.number)}</span>
        {detail.revision > 1 && <span className="mono dim">Rev {detail.revision}</span>}
      </div>
      <p className="kicker">{[title, price !== null ? gbp(price) : null, PLATFORM_NAMES[detail.platform]].filter(Boolean).join(" · ")}</p>

      {detail.verdict ? (
        <Verdict label={detail.verdict.label} headline={detail.verdict.headline} badge={detail.verdict.badge} />
      ) : (
        <Verdict label="not_enough_evidence" headline="The investigation didn't reach a verdict." />
      )}

      <section className="evidence" aria-label="Evidence">
        {rows.map((c) => (
          <EvidenceRow key={c.check} check={c} open={open.has(c.check)} onToggle={() => toggle(c.check)} refs={c.check === "comfort" ? sourceRefs(c) : undefined}>
            <CheckBody check={c} detail={detail} />
          </EvidenceRow>
        ))}
        {detail.verdict?.explanation && (
          <div className={`ev ${open.has("reasoning") ? "open" : ""}`}>
            <button type="button" className="ev-head" aria-expanded={open.has("reasoning")} onClick={() => toggle("reasoning")}>
              <span className="mark mark-none" aria-hidden="true" />
              <span className="ev-name">Reasoning</span>
              <span className="ev-toggle" aria-hidden="true">{open.has("reasoning") ? "−" : "+"}</span>
            </button>
            {open.has("reasoning") && <p className="ev-body prose">{detail.verdict.explanation}</p>}
          </div>
        )}
      </section>

      {(questions.length > 0 || beforePay.length > 0) && (
        <section className="block next">
          <h2 className="h2">Your next move</h2>
          {questions.map((q) => (
            <div className="ask" key={q.id}>
              <p className="ask-q">{q.text}</p>
              <CopyButton text={q.text} />
            </div>
          ))}
          {beforePay.length > 0 && (
            <>
              <Label>Before you pay</Label>
              <ul className="checklist">
                {beforePay.map((m) => (
                  <li key={m.id}>{m.text}</li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}

      {adding ? (
        <AddEvidence {...props.addEvidence} onCancel={() => setAdding(false)} />
      ) : (
        <div className="foot">
          <Button kind="secondary" wide onClick={() => setAdding(true)} disabled={detail.status === "investigating"}>
            Add evidence
          </Button>
        </div>
      )}
    </div>
  );
}

function EvidenceRow(props: { check: CheckResult; open: boolean; onToggle: () => void; refs?: SourceRef[]; children: ReactNode }) {
  const c = props.check;
  return (
    <div className={`ev ${props.open ? "open" : ""}`}>
      <button type="button" className="ev-head" aria-expanded={props.open} onClick={props.onToggle}>
        <StatusMark status={c.status} />
        <span className="ev-name">{CHECK_NAMES[c.check]}</span>
        <span className="ev-toggle" aria-hidden="true">{props.open ? "−" : "+"}</span>
      </button>
      <p className={`ev-line ${props.open ? "" : "clamp"}`}>
        {c.summary}
        {props.refs && props.refs.length > 0 && (
          <span className="refs" aria-label={`${props.refs.length} sources`}>
            {props.refs.slice(0, 5).map((r) => (
              <span className="ref" key={r.n}>
                {r.n}
              </span>
            ))}
          </span>
        )}
      </p>
      {props.open && <div className="ev-body">{props.children}</div>}
    </div>
  );
}

function CheckBody({ check, detail }: { check: CheckResult; detail: CaseDetail }) {
  switch (check.check) {
    case "condition": {
      const v = conditionView(check, detail.imageUrls);
      return (
        <>
          {v.photos.map((p) => (
            <figure className="photo" key={p.index}>
              {p.url ? <img src={p.url} alt={`Listing photo ${p.index + 1}`} /> : <div className="photo-missing" />}
              {p.boxes.map((b, i) => (
                <span
                  key={i}
                  className={`box ${b.severe ? "severe" : ""} ${b.top < 10 ? "cap-below" : ""} ${b.left + b.width > 60 ? "cap-right" : ""}`}
                  style={{ top: `${b.top}%`, left: `${b.left}%`, width: `${b.width}%`, height: `${b.height}%` }}
                >
                  <span className="box-cap">{b.caption}</span>
                </span>
              ))}
              <figcaption className="mono dim">Photo {p.index + 1}</figcaption>
            </figure>
          ))}
          {v.contradictions.map((t) => (
            <p className="note problem" key={t}>
              {t}
            </p>
          ))}
          {v.notes.map((t) => (
            <p className="note" key={t}>
              {t}
            </p>
          ))}
        </>
      );
    }
    case "comfort": {
      const refs = sourceRefs(check);
      if (!refs.length) return <p className="note">No sources.</p>;
      return (
        <ol className="sources">
          {refs.map((r) => (
            <li key={r.n}>
              <span className="ref">{r.n}</span>
              <div>
                {r.url ? (
                  <a href={r.url} target="_blank" rel="noreferrer">
                    {r.title}
                  </a>
                ) : (
                  <span>{r.title}</span>
                )}
                {r.domain && <span className="dim"> · {r.domain}</span>}
                {r.quote && <p className="quote">“{r.quote}”</p>}
              </div>
            </li>
          ))}
        </ol>
      );
    }
    case "price": {
      const v = priceView(check);
      return (
        <>
          {v.strip && (
            <div className="range" aria-label="Where this price sits among sampled listings">
              <div className="range-track">
                <span className="range-wide" style={{ left: `${v.strip.p10}%`, width: `${v.strip.p90 - v.strip.p10}%` }} />
                <span className="range-mid" style={{ left: `${v.strip.p25}%`, width: `${v.strip.p75 - v.strip.p25}%` }} />
                <span className="range-median" style={{ left: `${v.strip.median}%` }} />
                <span className={`range-this ${check.status === "pass" ? "" : "problem"}`} style={{ left: `${v.strip.listing}%` }}>
                  <span className="range-this-cap mono">{v.listing !== undefined ? gbp(v.listing) : ""}</span>
                </span>
              </div>
              <div className="range-ends mono dim">
                <span style={{ left: `${v.strip.p10}%` }}>{v.strip.lowLabel}</span>
                <span style={{ left: `${v.strip.p90}%` }}>{v.strip.highLabel}</span>
              </div>
            </div>
          )}
          {v.lines.map((l) => (
            <p className="note" key={l}>
              {l}
            </p>
          ))}
        </>
      );
    }
    default:
      return (
        <>
          {evidenceLines(check).map((l) => (
            <p className="note" key={l}>
              {l}
            </p>
          ))}
        </>
      );
  }
}

function AddEvidence(props: {
  busy: boolean;
  error: string | null;
  onCaptureTab: () => Promise<string | null>;
  onSubmit: (d: EvidenceDraft) => void;
  onCancel: () => void;
}) {
  const [reply, setReply] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [tabTitle, setTabTitle] = useState<string | null>(null);
  const ready = !!reply.trim() || files.length > 0 || !!tabTitle;

  return (
    <section className="block add" aria-label="Add evidence">
      <h2 className="h2">Add evidence</h2>
      <label className="field-label" htmlFor="seller-reply">
        Seller's reply
      </label>
      <textarea id="seller-reply" className="input area" rows={3} maxLength={4000} value={reply} onChange={(e) => setReply(e.target.value)} />

      <div className="add-sources">
        <label className="btn btn-text file-pick">
          {files.length ? `${files.length} photo${files.length === 1 ? "" : "s"} attached` : "Attach photos"}
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp"
            multiple
            onChange={(e) => setFiles([...(e.target.files ?? [])].slice(0, 6))}
          />
        </label>
        <Button kind="text" onClick={async () => setTabTitle(await props.onCaptureTab())}>
          {tabTitle ? "Tab captured" : "Use current tab"}
        </Button>
      </div>
      {tabTitle && <p className="note">{tabTitle}</p>}

      <div className="foot">
        {props.error && <Notice tone="problem">{props.error}</Notice>}
        <Button wide disabled={!ready || props.busy} onClick={() => props.onSubmit({ sellerReply: reply, files, tabTitle })}>
          {props.busy ? "Reopening" : "Reopen case"}
        </Button>
        <Button kind="text" wide onClick={props.onCancel}>
          Cancel
        </Button>
      </div>
    </section>
  );
}
