import { useState, type ReactNode } from "react";
import type { CheckStatus, VerdictLabel } from "@/schemas/domain";
import { VERDICTS } from "../lib/verdicts";

export function Shell(props: { nav?: ReactNode; children: ReactNode }) {
  return (
    <div className="shell">
      <header className="top">
        <span className="wordmark">Sleuth</span>
        <nav className="top-nav">{props.nav}</nav>
      </header>
      <main className="body">{props.children}</main>
    </div>
  );
}

export function NavLink(props: { onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" className="nav-link" onClick={props.onClick}>
      {props.children}
    </button>
  );
}

export function Button(props: {
  kind?: "primary" | "secondary" | "text";
  onClick?: () => void;
  disabled?: boolean;
  type?: "button" | "submit";
  wide?: boolean;
  small?: boolean;
  children: ReactNode;
}) {
  const { kind = "primary", wide, small } = props;
  return (
    <button
      type={props.type ?? "button"}
      className={`btn btn-${kind}${wide ? " btn-wide" : ""}${small ? " btn-small" : ""}`}
      onClick={props.onClick}
      disabled={props.disabled}
    >
      {props.children}
    </button>
  );
}

export function Label(props: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="label-row">
      <span className="label">{props.children}</span>
      {props.aside}
    </div>
  );
}

export function Meta(props: { children: ReactNode }) {
  return <div className="meta">{props.children}</div>;
}

/** Small square that encodes a check status. Red only for concerns and problems. */
export function StatusMark(props: { status: CheckStatus }) {
  const words: Record<CheckStatus, string> = { pass: "Clear", warn: "Concern", fail: "Problem", unknown: "Unknown" };
  return <span className={`mark mark-${props.status}`} role="img" aria-label={words[props.status]} />;
}

export function Verdict(props: { label: VerdictLabel; headline?: string; badge?: string | null; size?: "lg" | "md" }) {
  const v = VERDICTS[props.label];
  return (
    <section className={`verdict t-${v.treatment} verdict-${props.size ?? "lg"}`} aria-label="Verdict">
      <span className="vmark" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      <div className="vtext">
        <h1 className="vtitle">{v.title}</h1>
        {props.headline && <p className="vline">{props.headline}</p>}
        {props.badge === "out_sleuthed" && <p className="vbadge">Out-sleuthed</p>}
      </div>
    </section>
  );
}

export function CopyButton(props: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      kind="secondary"
      small
      onClick={() => {
        navigator.clipboard?.writeText(props.text).then(
          () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1600);
          },
          () => {},
        );
      }}
    >
      {copied ? "Copied" : "Copy"}
    </Button>
  );
}

/** What a step actually used ("Gemini vision · object detection", "Web search", "cached"). */
export function Tags(props: { tags: string[] }) {
  return (
    <span className="tags" aria-label={`Used: ${props.tags.join(", ")}`}>
      {props.tags.map((t) => (
        <span key={t} className={`tag ${t === "cached" ? "tag-cached" : ""}`}>
          {t}
        </span>
      ))}
    </span>
  );
}

export function Notice(props: { tone?: "problem" | "plain"; children: ReactNode }) {
  return <p className={`notice notice-${props.tone ?? "plain"}`}>{props.children}</p>;
}
