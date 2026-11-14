import { SseEventSchemas, type SseEventData, type SseEventName } from "@/schemas/api";

export type SseEvent = { id: string; revision: number; event: SseEventName; data: unknown };
export type Emit = <E extends SseEventName>(event: E, data: SseEventData<E>) => void;

type CaseBuffer = {
  revision: number;
  seq: number;
  events: SseEvent[];
  subscribers: Set<(e: SseEvent) => void>;
  touched: number;
};

const BUFFER_TTL_MS = 2 * 60 * 60_000;

/**
 * Per-case event buffer. Events for the current revision are kept so a late stream subscriber
 * misses nothing; subscribers stay attached across revisions (reopen progress arrives on the same stream).
 * Single process only (demo scale).
 */
export class EventHub {
  private buffers = new Map<string, CaseBuffer>();

  constructor(private readonly now: () => number = Date.now) {}

  private buffer(caseId: string): CaseBuffer {
    let b = this.buffers.get(caseId);
    if (!b) {
      b = { revision: 0, seq: 0, events: [], subscribers: new Set(), touched: this.now() };
      this.buffers.set(caseId, b);
    }
    return b;
  }

  /** Start buffering a new revision (drops the previous revision's buffered events). */
  startRevision(caseId: string, revision: number): void {
    const b = this.buffer(caseId);
    b.revision = revision;
    b.seq = 0;
    b.events = [];
    b.touched = this.now();
    this.prune();
  }

  emitter(caseId: string): Emit {
    return (event, data) => this.emit(caseId, event, data);
  }

  emit<E extends SseEventName>(caseId: string, event: E, data: SseEventData<E>): void {
    const parsed = SseEventSchemas[event].safeParse(data);
    if (!parsed.success) {
      console.error(`[events] ${event} does not match its contract`, parsed.error.issues);
    }
    const b = this.buffer(caseId);
    const e: SseEvent = { id: `${b.revision}:${++b.seq}`, revision: b.revision, event, data };
    b.events.push(e);
    b.touched = this.now();
    for (const fn of b.subscribers) {
      try {
        fn(e);
      } catch {
        /* a broken subscriber must not break the pipeline */
      }
    }
  }

  has(caseId: string): boolean {
    return this.buffers.has(caseId) && this.buffers.get(caseId)!.revision > 0;
  }

  /** Buffered events for the current revision, plus a live subscription. */
  subscribe(caseId: string, fn: (e: SseEvent) => void): { buffered: SseEvent[]; revision: number; unsubscribe: () => void } {
    const b = this.buffer(caseId);
    b.subscribers.add(fn);
    return { buffered: [...b.events], revision: b.revision, unsubscribe: () => b.subscribers.delete(fn) };
  }

  events(caseId: string): SseEvent[] {
    return [...(this.buffers.get(caseId)?.events ?? [])];
  }

  private prune() {
    const t = this.now();
    for (const [id, b] of this.buffers) {
      if (b.subscribers.size === 0 && t - b.touched > BUFFER_TTL_MS) this.buffers.delete(id);
    }
  }
}

export function serializeSse(e: { id?: string; event: string; data: unknown }): string {
  const lines = JSON.stringify(e.data).split("\n").map((l) => `data: ${l}`).join("\n");
  return `${e.id ? `id: ${e.id}\n` : ""}event: ${e.event}\n${lines}\n\n`;
}

/** Event ids are "<revision>:<seq>"; true when `id` comes after `lastEventId`. */
export function isAfter(id: string, lastEventId: string | null): boolean {
  if (!lastEventId) return true;
  const [r1, s1] = id.split(":").map(Number);
  const [r2, s2] = lastEventId.split(":").map(Number);
  if (!Number.isFinite(r2) || !Number.isFinite(s2)) return true;
  return r1 > r2 || (r1 === r2 && s1 > s2);
}
