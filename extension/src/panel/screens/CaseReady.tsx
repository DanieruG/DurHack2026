import { useState } from "react";
import type { Profile } from "@/schemas/domain";
import type { ListingPreview } from "../../lib/capture";
import type { CaseSummary } from "@/schemas/domain";
import { gbp, PLATFORM_NAMES, WEAR_NAMES } from "../../lib/format";
import { caseLabel } from "../../lib/history";
import { VERDICTS } from "../../lib/verdicts";
import { Button, Label, Notice } from "../ui";
import type { SearchPage } from "../../lib/survey";

export type ReadyState =
  | { kind: "loading" }
  | { kind: "listing"; preview: ListingPreview }
  | { kind: "no_listing" }
  | { kind: "no_access"; host: string; origin: string }
  | { kind: "search"; page: SearchPage };

export function ListingHead(props: { preview: Pick<ListingPreview, "title" | "priceGBP" | "platform" | "photoCount" | "thumbnail"> }) {
  const p = props.preview;
  const meta = [p.priceGBP !== null ? gbp(p.priceGBP) : null, PLATFORM_NAMES[p.platform], `${p.photoCount} photo${p.photoCount === 1 ? "" : "s"}`]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className="listing">
      <div className="thumb">{p.thumbnail ? <img src={p.thumbnail} alt="" /> : null}</div>
      <div className="listing-text">
        <h2 className="listing-title">{p.title}</h2>
        <p className="listing-meta">{meta}</p>
      </div>
    </div>
  );
}

/** Which saved sizes matter for this listing: the brand named in the title, else the usual size, else all of them. */
export function relevantSizes(profile: Profile, title: string): string {
  const t = title.toLowerCase();
  const own = profile.sizes.filter((s) => t.includes(s.brand.toLowerCase()));
  const usual = profile.defaultSize ? `Usual ${profile.defaultSize.system ?? "UK"} ${profile.defaultSize.size}` : null;
  if (!own.length && usual) return usual;
  return (own.length ? own : profile.sizes).map((s) => `${s.brand} ${s.system ?? "UK"} ${s.size}`).join(" · ");
}

export function CaseReady(props: {
  state: ReadyState;
  profile: Profile;
  onFile: CaseSummary | null;
  busy: boolean;
  error: string | null;
  defaultNote?: string;
  onInvestigate: (note: string) => void;
  onOpenCase: (c: CaseSummary) => void;
  onEditProfile: () => void;
  onAllow: (origin: string) => void;
  /** Set when a search survey on this platform will go with the case. */
  surveyNote?: string | null;
}) {
  const [note, setNote] = useState(props.defaultNote ?? "");
  const s = props.state;

  if (s.kind === "loading" || s.kind === "search") return <div className="screen" />;
  if (s.kind === "no_listing") {
    return (
      <div className="screen">
        <h1 className="h1">Open a listing</h1>
        <p className="lede">Go to a second-hand listing, then come back here.</p>
      </div>
    );
  }
  if (s.kind === "no_access") {
    return (
      <div className="screen">
        <h1 className="h1">Allow this site</h1>
        <p className="lede">Sleuth reads a listing only when you ask it to.</p>
        <div className="foot">
          <Button wide onClick={() => props.onAllow(s.origin)}>
            Allow on {s.host}
          </Button>
        </div>
      </div>
    );
  }

  const { profile } = props;
  const preview = s.preview;
  const rows: [string, string][] = [
    ["Size", relevantSizes(profile, preview.title) || "None saved"],
    ...(profile.priorities.length ? ([["Priority", profile.priorities.map((p, i) => (i ? p : p[0].toUpperCase() + p.slice(1))).join(", ")]] as [string, string][]) : []),
    ...(profile.budgetGBP ? ([["Budget", gbp(profile.budgetGBP)]] as [string, string][]) : []),
    ["Wear", WEAR_NAMES[profile.wearTolerance].label],
  ];

  return (
    <div className="screen">
      <ListingHead preview={preview} />

      {props.onFile && (
        <button type="button" className="on-file" onClick={() => props.onOpenCase(props.onFile!)}>
          <span className="mono">{caseLabel(props.onFile.id)}</span>
          <span>{props.onFile.verdictLabel ? VERDICTS[props.onFile.verdictLabel].title : "In progress"}</span>
          <span className="on-file-go">Open</span>
        </button>
      )}

      <section className="block">
        <Label
          aside={
            <button type="button" className="nav-link" onClick={props.onEditProfile}>
              Edit
            </button>
          }
        >
          Your needs
        </Label>
        <dl className="facts">
          {rows.map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="block">
        <label className="field-label" htmlFor="case-note">
          Anything else for this one?
        </label>
        <textarea id="case-note" className="input area" rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
      </section>

      <div className="foot">
        {props.surveyNote && <p className="note dim">{props.surveyNote}</p>}
        {props.error && <Notice tone="problem">{props.error}</Notice>}
        <Button wide onClick={() => props.onInvestigate(note)} disabled={props.busy}>
          {props.busy ? "Opening case" : "Investigate"}
        </Button>
      </div>
    </div>
  );
}
