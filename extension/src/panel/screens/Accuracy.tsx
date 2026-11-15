import { useEffect, useState } from "react";
import { figureText, HEADLINE_IDS, honestLine, type PublicEvalSummary } from "@/schemas/eval";
import { shortDate } from "../../lib/format";

type State = { kind: "loading" } | { kind: "none" } | { kind: "error"; message: string } | { kind: "ready"; summary: PublicEvalSummary };

/** "How accurate is Sleuth?": the headline eval figures with their sample sizes, the test date and an honest caveat. */
export function Accuracy(props: { load: () => Promise<PublicEvalSummary | null> }) {
  const [state, setState] = useState<State>({ kind: "loading" });
  useEffect(() => {
    let live = true;
    props
      .load()
      .then((summary) => live && setState(summary ? { kind: "ready", summary } : { kind: "none" }))
      .catch((err: Error) => live && setState({ kind: "error", message: err.message }));
    return () => {
      live = false;
    };
  }, [props.load]);

  return (
    <div className="screen accuracy">
      <h1 className="h1">How accurate is Sleuth?</h1>
      {state.kind === "loading" && <p className="note dim">Loading the test results…</p>}
      {state.kind === "none" && <p className="note">No test results yet.</p>}
      {state.kind === "error" && <p className="notice notice-problem">{state.message}</p>}
      {state.kind === "ready" && (
        <>
          <dl className="accuracy-figures">
            {HEADLINE_IDS.map((id) => (
              <div className="accuracy-row" key={id}>
                <dt>{state.summary.headline[id].label}</dt>
                <dd className="mono">{figureText(state.summary.headline[id])}</dd>
              </div>
            ))}
          </dl>
          <p className="note">{honestLine(state.summary.cases)}</p>
          <p className="note dim">
            Tested {shortDate(state.summary.runAt)} {state.summary.runAt.slice(0, 4)}.
          </p>
        </>
      )}
    </div>
  );
}
