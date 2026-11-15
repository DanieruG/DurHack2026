import { useState, type ReactNode } from "react";
import type { CaseDetail } from "@/schemas/api";
import type { CheckName, CheckResult } from "@/schemas/domain";
import { CHECK_NAMES, gbp, PLATFORM_NAMES } from "../../lib/format";
import { caseLabel } from "../../lib/history";
import { conditionView, evidenceLines, leadsView, observedView, priceView, sourceRefs, type ConditionView, type ObservedView, type SourceRef } from "../../lib/evidence";
import { Button, CopyButton, Label, Notice, StatusMark, Tags, Verdict } from "../ui";
import { checkTags, runTotals } from "../../lib/tags";
import { BUY_NEW_MOVE_ID } from "../../lib/offers";
import { AlternativeCards, OfferCards } from "../offers";

const ORDER: CheckName[] = ["condition", "fit", "comfort", "price"];

type RowKey = CheckName | "reasoning";

export type EvidenceDraft = { sellerReply: string; files: File[]; tabTitle: string | null };

export function CaseFile(props: {
  caseId: string;
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
  /** Open a suggested listing from the user's search and investigate it. */
  onInvestigateListing?: (url: string) => void;
  /** Open "How accurate is Sleuth?". */
  onAccuracy?: () => void;
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
  const buyNew = detail.nextMoves.find((m) => m.id === BUY_NEW_MOVE_ID);
  const beforePay = detail.nextMoves.filter((m) => m.kind === "before_you_pay" && m !== buyNew);
  const leads = leadsView(detail);
  const price = props.listing.priceGBP ?? detail.listingFacts?.priceGBP ?? null;
  const title = detail.listingFacts?.title || props.listing.title;

  return (
    <div className="screen">
      <div className="file-head">
        <span className="mono">{caseLabel(props.caseId)}</span>
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
          <EvidenceRow key={c.check} check={c} open={open.has(c.check)} onToggle={() => toggle(c.check)} refs={c.check === "comfort" || c.check === "price" ? sourceRefs(c) : undefined}>
            <CheckBody check={c} detail={detail} onInvestigateListing={props.onInvestigateListing} />
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

      {detail.warningSignals.length > 0 && (
        <section className="block warning-signals" aria-label="Worth checking">
          <h2 className="h2">Worth checking</h2>
          {detail.warningSignals.map((signal) => (
            <article className="warning-signal" key={signal.id}>
              <p className="warning-signal-text">{signal.text}</p>
              {signal.evidence.length > 0 && (
                <ul className="warning-evidence">
                  {signal.evidence.map((e) => (
                    <li key={e.id}>
                      <span>{e.label}</span>
                      {e.quote && <span className="quote">“{e.quote}”</span>}
                    </li>
                  ))}
                </ul>
              )}
            </article>
          ))}
        </section>
      )}

      {leads && (
        <section className="block leads" aria-label="Leads followed">
          <h2 className="h2">Leads followed</h2>
          {leads.items.length > 0 && (
            <ol className="lead-list">
              {leads.items.map((l) => (
                <li key={l.id} className={`lead ${l.state}`}>
                  <p className="lead-reason">{l.reason}</p>
                  <p className="lead-action">{l.action}</p>
                  <p className="lead-outcome">{l.outcome}</p>
                </li>
              ))}
            </ol>
          )}
          {leads.note && <p className="note lead-note">{leads.note}</p>}
        </section>
      )}

      {(questions.length > 0 || beforePay.length > 0 || buyNew) && (
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
          {buyNew && (
            <div className="buy-new">
              <Label>Consider buying new</Label>
              <p className="buy-new-text">{buyNewText(buyNew.text)}</p>
              {detail.newOffers && <OfferCards data={detail.newOffers} />}
            </div>
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

      {detail.run && <p className="totals mono dim">{runTotals(detail.run)}</p>}
      {props.onAccuracy && (
        <button type="button" className="link-quiet" onClick={props.onAccuracy}>
          How accurate is Sleuth?
        </button>
      )}
    </div>
  );
}

/** The move's text without its "Consider buying new:" lead-in (the label above says it). */
function buyNewText(text: string): string {
  const rest = text.replace(/^Consider buying new:\s*/i, "");
  return rest.charAt(0).toUpperCase() + rest.slice(1);
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
      {checkTags(c).length > 0 && <Tags tags={checkTags(c)} />}
      <p className={`ev-line ${props.open ? "" : "clamp"}`}>
        {c.summary}
        {props.refs && props.refs.length > 0 && (
          <span className="refs" aria-label={`${props.refs.length} sources`}>
            {props.refs.slice(0, 8).map((r) => (
              <SourceChip key={r.n} r={r} />
            ))}
          </span>
        )}
      </p>
      {props.open && <div className="ev-body">{props.children}</div>}
    </div>
  );
}

function CheckBody({ check, detail, onInvestigateListing }: { check: CheckResult; detail: CaseDetail; onInvestigateListing?: (url: string) => void }) {
  switch (check.check) {
    case "condition":
      return <ConditionExhibit view={conditionView(check, detail.imageUrls)} />;
    case "comfort": {
      const refs = sourceRefs(check);
      return refs.length ? <SourceList refs={refs} /> : <p className="note">No sources.</p>;
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
          <ObservedExhibit view={observedView(detail.observedComparison)} />
          {detail.newOffers && <OfferCards data={detail.newOffers} />}
          <AlternativeCards data={detail.observedAlternatives} onInvestigate={onInvestigateListing} />
          {sourceRefs(check).length > 0 && <SourceList refs={sourceRefs(check)} />}
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

/** The user's own search survey, inside the Price exhibit: what it was compared with (its cheaper listings are under "Worth looking at"). */
function ObservedExhibit({ view }: { view: ObservedView | null }) {
  if (!view) return null;
  return (
    <div className="observed" aria-label="Your search">
      <Label>Your search</Label>
      {view.lines.map((l) => (
        <p className="note" key={l}>
          {l}
        </p>
      ))}
      <p className="note dim">{view.counts}</p>
    </div>
  );
}

/** A numbered source chip: a real link that opens the source in a new tab (plain text when there is no URL). */
function SourceChip({ r }: { r: SourceRef }) {
  const label = `Source ${r.n}: ${r.title}${r.domain ? `, ${r.domain}` : ""} (opens in a new tab)`;
  return r.url ? (
    <a className="ref ref-link" href={r.url} target="_blank" rel="noreferrer" aria-label={label} title={r.title}>
      {r.n}
    </a>
  ) : (
    <span className="ref" title={r.title}>
      {r.n}
    </span>
  );
}

function SourceList({ refs }: { refs: SourceRef[] }) {
  return (
    <ol className="sources">
      {refs.map((r) => (
        <li key={r.n}>
          <SourceChip r={r} />
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

/**
 * Condition exhibit: a photo switcher with each photo's boxes, and the findings list. Hovering, focusing or clicking a
 * finding switches to its photo and highlights its box; clicking a box highlights its finding. All controls are buttons.
 */
function ConditionExhibit({ view: v }: { view: ConditionView }) {
  const [photo, setPhoto] = useState(v.initialPhoto);
  const [active, setActive] = useState<number | null>(null);
  const shown = v.photos.find((p) => p.index === photo) ?? v.photos[0];
  const pick = (i: number) => {
    setActive(i);
    setPhoto(v.findings[i].photoIndex);
  };
  return (
    <>
      {v.photos.length > 1 && (
        <div className="switcher" role="group" aria-label="Listing photos">
          {v.photos.map((p) => (
            <button
              key={p.index}
              type="button"
              className={`sw ${p.index === shown?.index ? "on" : ""} ${p.boxes.length ? "has" : ""}`}
              aria-pressed={p.index === shown?.index}
              aria-label={`Photo ${p.index + 1}${p.boxes.length ? `, ${p.boxes.length} finding${p.boxes.length === 1 ? "" : "s"}` : ""}`}
              onClick={() => setPhoto(p.index)}
            >
              {p.index + 1}
            </button>
          ))}
        </div>
      )}
      {shown && (
        <figure className="photo">
          {shown.url ? <img src={shown.url} alt={`Listing photo ${shown.index + 1}`} /> : <div className="photo-missing" />}
          {shown.boxes.map((b) => (
            <button
              key={b.finding}
              type="button"
              className={`box ${b.severe ? "severe" : ""} ${b.possible ? "possible" : ""} ${active === b.finding ? "on" : ""} ${b.top < 10 ? "cap-below" : ""} ${b.left + b.width > 60 ? "cap-right" : ""}`}
              style={{ top: `${b.top}%`, left: `${b.left}%`, width: `${b.width}%`, height: `${b.height}%` }}
              aria-pressed={active === b.finding}
              aria-label={b.caption}
              onClick={() => setActive(b.finding)}
            >
              <span className="box-cap">{b.caption}</span>
            </button>
          ))}
          <figcaption className="mono dim">
            Photo {shown.index + 1}
            {v.photos.length > 1 ? ` of ${v.photos.length}` : ""}
          </figcaption>
        </figure>
      )}
      {v.findings.length > 0 && (
        <ul className="findings" aria-label="Findings">
          {v.findings.map((f, i) => (
            <li key={i}>
              <button
                type="button"
                className={`finding ${active === i ? "on" : ""} ${f.possible ? "possible" : ""}`}
                aria-pressed={active === i}
                onMouseEnter={() => pick(i)}
                onFocus={() => pick(i)}
                onClick={() => pick(i)}
              >
                <span className={`finding-mark ${f.possible ? "possible" : ""}`} aria-hidden="true" />
                <span className="finding-text">
                  {f.caption}
                  <span className="dim"> · photo {f.photoIndex + 1}</span>
                  {f.note && <span className="finding-note">{f.note}</span>}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
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
