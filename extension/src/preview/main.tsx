import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { VerdictLabel } from "@/schemas/domain";
import { VERDICT_ORDER } from "../lib/verdicts";
import { CaseFile } from "../panel/screens/CaseFile";
import { CaseReady } from "../panel/screens/CaseReady";
import { SearchSurvey } from "../panel/screens/SearchSurvey";
import { Investigating } from "../panel/screens/Investigating";
import { ProfileScreen } from "../panel/screens/Profile";
import { WhatChanged } from "../panel/screens/WhatChanged";
import { NavLink, Shell, Verdict } from "../panel/ui";
import { CASE_FILE, DIFF, investigationInProgress, LISTING, PROFILE, TRAINER_URL } from "./fixtures";

const noop = () => {};

function Panel(props: { n: string; name: string; nav?: ReactNode; children: ReactNode }) {
  return (
    <div className="pv-col">
      <p className="pv-cap">
        <span>{props.n}</span> {props.name}
      </p>
      <div className="pv-panel">
        <Shell nav={props.nav}>{props.children}</Shell>
      </div>
    </div>
  );
}

function ListingPage() {
  return (
    <div className="pv-col pv-col-page">
      <p className="pv-cap">
        <span>00</span> Listing tab
      </p>
      <div className="pv-page">
        <div className="pv-url">
          <span className="pv-dots">
            <i />
            <i />
            <i />
          </span>
          <span className="pv-addr">marketplace listing · Nike Pegasus 40</span>
        </div>
        <div className="pv-listing">
          <img className="pv-hero" src={TRAINER_URL} alt="" />
          <div className="pv-thumbs">
            {[0, 1, 2, 3, 4].map((i) => (
              <img key={i} src={TRAINER_URL} alt="" className={i ? "" : "on"} />
            ))}
          </div>
          <h1>Nike Pegasus 40</h1>
          <p className="pv-price">£42.00</p>
          <dl>
            <div>
              <dt>Size</dt>
              <dd>UK 9</dd>
            </div>
            <div>
              <dt>Condition</dt>
              <dd>Good</dd>
            </div>
            <div>
              <dt>Colour</dt>
              <dd>Grey</dd>
            </div>
          </dl>
          <p className="pv-desc">Worn a handful of times, still loads of life left. Comfy for long days. Smoke-free home, posted next day.</p>
          <span className="pv-buy">Buy now</span>
        </div>
      </div>
    </div>
  );
}

const VERDICT_LINES: Record<VerdictLabel, string> = {
  hidden_gem: "Fits, well under typical price, and clean in every photo.",
  worth_a_look: "Heel close-up shows light wear only. Condition upgraded.",
  proceed_with_caution: "Good fit and fair price, but check the heel before buying.",
  overpriced: "At £68 it costs about what it does new.",
  wrong_fit: "Listed UK 8. That's a full size under your Nike size.",
  not_enough_evidence: "Couldn't confirm the exact model from the photos.",
};

function App() {
  const inv = investigationInProgress();
  return (
    <div className="pv">
      <header className="pv-head">
        <h1>Detective Sleuth</h1>
        <p>Chrome side panel, 380 px. Every screen below is the shipping component, rendered with fixture data.</p>
      </header>

      <div className="pv-row">
        <ListingPage />
        <Panel n="01" name="Profile">
          <ProfileScreen profile={PROFILE} apiBase="http://localhost:3000" firstRun onSave={noop} />
        </Panel>
        <Panel n="01b" name="Search survey" nav={<NavLink onClick={noop}>Profile</NavLink>}>
          <SearchSurvey
            page={{ platform: "vinted", query: "nike pegasus 40", key: "vinted:nike pegasus 40" }}
            summary="Surveyed 38 listings · 21 in your size · 6 couldn't be matched to a model yet"
            added={12}
            busy={false}
            error={null}
            onSurvey={noop}
          />
        </Panel>
        <Panel n="02" name="Case ready" nav={<NavLink onClick={noop}>Profile</NavLink>}>
          <CaseReady
            state={{ kind: "listing", preview: LISTING }}
            profile={PROFILE}
            onFile={null}
            busy={false}
            error={null}
            onInvestigate={noop}
            onOpenCase={noop}
            onEditProfile={noop}
            onAllow={noop}
            surveyNote="Compared with your survey of “nike pegasus 40” (38 listings)"
          />
        </Panel>
        <Panel n="03" name="Investigation in progress" nav={<NavLink onClick={noop}>New case</NavLink>}>
          <Investigating caseId="cmpreview000042" title="Nike Pegasus 40 · £42" inv={inv} />
        </Panel>
        <Panel n="04" name="Case file" nav={<NavLink onClick={noop}>New case</NavLink>}>
          <CaseFile
            caseId="cmpreview000042"
            detail={CASE_FILE}
            listing={{ title: LISTING.title, priceGBP: 42 }}
            initialOpen={["condition", "price"]}
            addEvidence={{ busy: false, error: null, onCaptureTab: async () => null, onSubmit: noop }}
            onInvestigateListing={noop}
          />
        </Panel>
        <Panel n="05" name="What changed" nav={<NavLink onClick={noop}>New case</NavLink>}>
          <WhatChanged caseId="cmpreview000042" diff={DIFF} onOpenFile={noop} />
        </Panel>
      </div>

      <section className="pv-verdicts">
        <p className="pv-cap">
          <span>06</span> Verdicts
        </p>
        <div className="pv-vgrid">
          {VERDICT_ORDER.map((v) => (
            <div className="pv-vcell" key={v}>
              <Verdict label={v} headline={VERDICT_LINES[v]} badge={v === "hidden_gem" ? "out_sleuthed" : null} />
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
