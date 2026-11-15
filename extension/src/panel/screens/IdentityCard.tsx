import { useEffect, useId, useRef, useState } from "react";
import type { IdentityChoice, IdentityOption } from "@/schemas/api";
import { choiceLabel, confidenceText, type IdentityQuestion } from "../../lib/identity";
import { Button } from "../ui";

const ONE_LINE = "I'm not sure which version this is. Confirming helps me search for the right prices.";

type Pick = "best_guess" | "alt-0" | "alt-1" | "custom";

/**
 * "Is this the right item?": the best guess, each alternative, "Something else", Continue and a quieter Skip.
 * Real radio buttons in a fieldset; focus moves to the card's heading when it appears and a live region says Sleuth needs
 * input. Once answered it stays on screen (inputs locked, the answer named) so the page below doesn't jump.
 */
export function IdentityCard(props: {
  question: IdentityQuestion;
  onConfirm: (choice: IdentityChoice) => void;
  /** The answer that was sent, once it has been: the card locks and says what Sleuth is continuing with. */
  answered?: IdentityChoice | null;
  /** A finished case ("Not right?"): no Skip, and the one-liner is about correcting. */
  correcting?: boolean;
  onCancel?: () => void;
  error?: string | null;
}) {
  const { question: q, answered } = props;
  const id = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const [pick, setPick] = useState<Pick>("best_guess");
  const [custom, setCustom] = useState({ brand: q.bestGuess.brand ?? "", model: "", version: "" });
  const locked = !!answered;

  useEffect(() => {
    heading.current?.focus();
  }, []);

  const customOk = custom.brand.trim() !== "" && custom.model.trim() !== "";
  const canContinue = !locked && (pick !== "custom" || customOk);

  const choice = (): IdentityChoice => {
    if (pick === "best_guess") return { choice: "best_guess" };
    if (pick === "custom") return { choice: "custom", brand: custom.brand.trim(), model: custom.model.trim(), ...(custom.version.trim() ? { version: custom.version.trim() } : {}) };
    return { choice: "alternative", index: pick === "alt-0" ? 0 : 1 };
  };

  const radio = (value: Pick, label: string, kind: string, o?: IdentityOption) => {
    const rid = `${id}-${value}`;
    return (
      <div className="choice" key={value}>
        <input type="radio" id={rid} name={`${id}-pick`} value={value} checked={pick === value} disabled={locked} onChange={() => setPick(value)} aria-describedby={o ? `${rid}-d` : undefined} />
        <label htmlFor={rid}>
          <span className="choice-name">{label}</span>
          <span className="choice-kind mono">{kind}</span>
        </label>
        {o && (
          <span className="choice-detail" id={`${rid}-d`}>
            {confidenceText(o.confidence)}
            {o.evidence.length > 0 ? ` · ${o.evidence.join("; ")}` : ""}
          </span>
        )}
      </div>
    );
  };

  return (
    <section className="identity-card" aria-labelledby={`${id}-h`}>
      {/* A live region, always present, so a screen reader announces the need for input as soon as the card appears. */}
      <p className="sr-only" role="status">
        {locked ? "Thanks. Sleuth is continuing." : "Sleuth needs your input: is this the right item?"}
      </p>
      <h2 className="h2" id={`${id}-h`} tabIndex={-1} ref={heading}>
        Is this the right item?
      </h2>
      <p className="identity-guess">{q.headline}</p>

      <fieldset className="choices" disabled={locked}>
        <legend className="sr-only">Which item is this?</legend>
        {radio("best_guess", q.bestGuess.label, "Best guess", q.bestGuess)}
        {q.alternatives.map((a, i) => radio(i === 0 ? "alt-0" : "alt-1", a.label, "Could also be", a))}
        {radio("custom", "Something else", "")}
        {pick === "custom" && (
          <div className="custom-fields">
            <label className="field-label" htmlFor={`${id}-brand`}>
              Brand
            </label>
            <input id={`${id}-brand`} className="input" value={custom.brand} disabled={locked} onChange={(e) => setCustom({ ...custom, brand: e.target.value })} autoComplete="off" />
            <label className="field-label" htmlFor={`${id}-model`}>
              Model
            </label>
            <input id={`${id}-model`} className="input" value={custom.model} disabled={locked} onChange={(e) => setCustom({ ...custom, model: e.target.value })} autoComplete="off" placeholder="e.g. Pegasus 41" />
            <label className="field-label" htmlFor={`${id}-version`}>
              Version <span className="dim">(optional)</span>
            </label>
            <input id={`${id}-version`} className="input" value={custom.version} disabled={locked} onChange={(e) => setCustom({ ...custom, version: e.target.value })} autoComplete="off" />
          </div>
        )}
      </fieldset>

      <p className="note identity-why">{props.correcting ? "Pick the right one and I'll check it again." : ONE_LINE}</p>
      {props.error && (
        <p className="note problem" role="alert">
          {props.error}
        </p>
      )}

      <div className="identity-actions">
        {locked ? (
          <p className="identity-continuing" aria-live="polite">
            Continuing with {choiceLabel(q, answered!)}…
          </p>
        ) : (
          <>
            <Button disabled={!canContinue} onClick={() => props.onConfirm(choice())}>
              Continue
            </Button>
            {!props.correcting && (
              <Button kind="text" onClick={() => props.onConfirm({ choice: "skip" })}>
                Skip
              </Button>
            )}
            {props.correcting && props.onCancel && (
              <Button kind="text" onClick={props.onCancel}>
                Cancel
              </Button>
            )}
          </>
        )}
      </div>
    </section>
  );
}
