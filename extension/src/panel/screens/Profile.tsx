import { useState } from "react";
import type { Profile, SizeSystem, WearTolerance } from "@/schemas/domain";
import { WEAR_NAMES } from "../../lib/format";
import { Button, Label } from "../ui";

type SizeRow = { brand: string; system: SizeSystem; size: string };

const WEAR_ORDER: WearTolerance[] = ["none", "light", "moderate", "any"];

export function ProfileScreen(props: {
  profile: Profile | null;
  apiBase: string;
  firstRun: boolean;
  onSave: (p: Profile, apiBase: string) => Promise<void> | void;
}) {
  const p = props.profile;
  const [usual, setUsual] = useState<Omit<SizeRow, "brand">>({ system: p?.defaultSize?.system ?? "UK", size: p?.defaultSize ? String(p.defaultSize.size) : "" });
  const [sizes, setSizes] = useState<SizeRow[]>(p?.sizes.map((s) => ({ brand: s.brand, system: s.system ?? "UK", size: String(s.size) })) ?? []);
  const [priorities, setPriorities] = useState((p?.priorities ?? []).join(", "));
  const [budget, setBudget] = useState(p?.budgetGBP ? String(p.budgetGBP) : "");
  const [wear, setWear] = useState<WearTolerance>(p?.wearTolerance ?? "light");
  const [apiBase, setApiBase] = useState(props.apiBase);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const setRow = (i: number, patch: Partial<SizeRow>) => setSizes((rows) => rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const save = async () => {
    const cleanSizes = sizes
      .map((r) => ({ brand: r.brand.trim(), system: r.system, size: Number(r.size) }))
      .filter((r) => r.brand && Number.isFinite(r.size) && r.size > 0);
    const budgetGBP = Number(budget);
    const usualSize = Number(usual.size);
    const profile: Profile = {
      ...(usual.size && Number.isFinite(usualSize) && usualSize > 0 ? { defaultSize: { size: usualSize, system: usual.system } } : {}),
      sizes: cleanSizes,
      priorities: priorities.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 12),
      ...(budget && Number.isFinite(budgetGBP) && budgetGBP > 0 ? { budgetGBP } : {}),
      wearTolerance: wear,
    };
    if (!profile.sizes.length && !profile.defaultSize) {
      setError("Add your usual size, or a size for a brand.");
      return;
    }
    setError(null);
    setSaving(true);
    try {
      await props.onSave(profile, apiBase.trim());
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="screen">
      <h1 className="h1">Your profile</h1>

      <section className="block">
        <Label>Your usual size</Label>
        <div className="size-row size-row-usual">
          <select className="input select" aria-label="Usual size system" value={usual.system} onChange={(e) => setUsual((u) => ({ ...u, system: e.target.value as SizeSystem }))}>
            <option>UK</option>
            <option>US</option>
            <option>EU</option>
          </select>
          <input
            className="input num"
            aria-label="Usual size"
            inputMode="decimal"
            placeholder="9"
            value={usual.size}
            onChange={(e) => setUsual((u) => ({ ...u, size: e.target.value.replace(/[^\d.]/g, "") }))}
          />
        </div>
        <p className="hint">Used for any brand you haven't added below.</p>
      </section>

      <section className="block">
        <Label>Sizes by brand</Label>
        <div className="sizes">
          {sizes.map((r, i) => (
            <div className="size-row" key={i}>
              <input
                className="input"
                aria-label="Brand"
                placeholder="Brand"
                value={r.brand}
                onChange={(e) => setRow(i, { brand: e.target.value })}
              />
              <select className="input select" aria-label="Size system" value={r.system} onChange={(e) => setRow(i, { system: e.target.value as SizeSystem })}>
                <option>UK</option>
                <option>US</option>
                <option>EU</option>
              </select>
              <input
                className="input num"
                aria-label="Size"
                inputMode="decimal"
                placeholder="9"
                value={r.size}
                onChange={(e) => setRow(i, { size: e.target.value.replace(/[^\d.]/g, "") })}
              />
              <button
                type="button"
                className="remove"
                aria-label={`Remove ${r.brand || "size"}`}
                onClick={() => setSizes((rows) => rows.filter((_, j) => j !== i))}
              >
                ×
              </button>
            </div>
          ))}
        </div>
        <Button kind="text" onClick={() => setSizes((rows) => [...rows, { brand: "", system: "UK", size: "" }])}>
          Add a brand size
        </Button>
      </section>

      <section className="block">
        <Label>Priorities</Label>
        <input className="input" placeholder="All-day comfort, wide fit" value={priorities} onChange={(e) => setPriorities(e.target.value)} />
      </section>

      <section className="block">
        <Label>Budget</Label>
        <div className="prefix">
          <span>£</span>
          <input className="input num" inputMode="decimal" placeholder="60" value={budget} onChange={(e) => setBudget(e.target.value.replace(/[^\d.]/g, ""))} />
        </div>
      </section>

      <section className="block">
        <Label>Wear tolerance</Label>
        <div className="segmented" role="radiogroup" aria-label="Wear tolerance">
          {WEAR_ORDER.map((w) => (
            <button key={w} type="button" role="radio" aria-checked={wear === w} className={wear === w ? "on" : ""} onClick={() => setWear(w)}>
              {WEAR_NAMES[w].label}
            </button>
          ))}
        </div>
        <p className="hint">{WEAR_NAMES[wear].hint}</p>
      </section>

      <details className="server">
        <summary>Server</summary>
        <input className="input mono" aria-label="Server address" value={apiBase} onChange={(e) => setApiBase(e.target.value)} />
      </details>

      <footer className="foot">
        {error && <p className="notice notice-problem">{error}</p>}
        <p className="device-note">Stays on this device.</p>
        <Button wide onClick={save} disabled={saving}>
          {props.firstRun ? "Save" : "Save changes"}
        </Button>
      </footer>
    </div>
  );
}
