import type { IdentityChoice } from "@/schemas/api";
import { IdentityChoiceSchema } from "@/schemas/api";
import { sha256 } from "@/lib/hash";
import { replayDelayMs } from "@/lib/cache";
import type { CaseRow } from "@/lib/store";
import type { Deps } from "./deps";

/**
 * Record/replay for the buyer's answer to "Is this the right item?", so a recorded demo works offline and shows the same
 * pause: in record mode the answer is saved when the buyer gives it; in replay mode, when the same listing pauses, the
 * card is shown (identity_check_needed) and, after a short delay, the recorded answer is applied as if the buyer had given it.
 * Keyed by the case's input hash, which is the same for the same capture and profile. With no recorded answer a replayed
 * case simply waits for the buyer, like a live one. The eval never pauses, so none of this touches its figures.
 */

const NAMESPACE = "identity";

const keyFor = (c: Pick<CaseRow, "inputHash">) => sha256(`identity:${c.inputHash}`);

type Recorded = { choice: IdentityChoice };

/** Record mode: remember the answer given for a paused case. Best effort. */
export async function recordChoice(deps: Deps, c: CaseRow, choice: IdentityChoice): Promise<void> {
  if (!deps.cache.enabled || deps.cache.replaying) return;
  await deps.cache.set(NAMESPACE, keyFor(c), { choice } satisfies Recorded).catch(() => undefined);
}

/** Replay mode: the answer recorded for this case, if there is one. */
export async function recordedChoice(deps: Deps, c: CaseRow): Promise<IdentityChoice | null> {
  if (!deps.cache.replaying) return null;
  const hit = await deps.cache.get<Recorded>(NAMESPACE, keyFor(c));
  const parsed = IdentityChoiceSchema.safeParse(hit?.choice);
  return parsed.success ? parsed.data : null;
}

/** After a replayed case pauses: wait, then apply the recorded answer. Never throws. */
export async function replayRecordedChoice(deps: Deps, caseId: string): Promise<void> {
  try {
    const c = await deps.store.getCase(caseId);
    if (!c || c.status !== "awaiting_confirmation") return;
    const choice = await recordedChoice(deps, c);
    if (!choice) return;
    await new Promise((r) => setTimeout(r, deps.config.replayChoiceDelayMs + (deps.config.replayChoiceDelayMs ? replayDelayMs(keyFor(c)) : 0)));
    const { startConfirm } = await import("./confirm");
    const started = await startConfirm(deps, caseId, choice);
    await started?.done;
  } catch (err) {
    console.error("[sleuth] replaying the recorded answer failed", err);
  }
}
