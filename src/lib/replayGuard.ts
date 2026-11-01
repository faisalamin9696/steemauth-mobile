/**
 * Request replay gate — at most ONE decision per request id per session.
 *
 * Why this exists (protocol v3): the relay is at-least-once. A replay
 * can deliver a `request` the user has ALREADY approved or rejected, and a
 * re-show after a decision is how a "second broadcast" would happen. The gate
 * records ids the moment they are decided (approve broadcast ok / reject) and
 * refuses every later dispatch of the same id for the life of the session.
 *
 * Deliberately NOT a "first dispatch wins" gate: while a request is still
 * undecided, redelivering it is a *re-show* (same id → same pending state),
 * which is exactly what the web's resume-after-refresh re-send needs after the
 * phone process restarts. Only DECIDED ids are terminal.
 *
 * Pure TS by contract — `src/lib/*` is imported by the web package's
 * cross-check suites, so no React Native, no store, no network.
 */

export interface RequestGate {
  /** False once this id has been decided - the caller must not dispatch it. */
  shouldDispatch(id: string): boolean;
  /** Terminal: this id was approved (and broadcast) or rejected. */
  decide(id: string): void;
  /** New session: forget everything. */
  reset(): void;
  /** Diagnostic count of decided ids (never exposes ids or payloads). */
  readonly decided: number;
  /** The decided ids themselves - persisted with the session so a process
   *  death cannot turn a re-delivered, already-decided request into a second
   *  dispatch. Ids only; payloads never. */
  ids(): string[];
  /** Re-seed after a resume: ids decided before the restart stay decided. */
  hydrate(ids: string[]): void;
}

export function createRequestGate(): RequestGate {
  const decided = new Set<string>();
  return {
    shouldDispatch(id: string): boolean {
      if (!id) return false; // an id-less request cannot be tracked safely
      return !decided.has(id);
    },
    decide(id: string): void {
      if (id) decided.add(id);
    },
    reset(): void {
      decided.clear();
    },
    get decided(): number {
      return decided.size;
    },
    ids(): string[] {
      return [...decided];
    },
    hydrate(ids: string[]): void {
      for (const id of ids) if (id) decided.add(id);
    },
  };
}
