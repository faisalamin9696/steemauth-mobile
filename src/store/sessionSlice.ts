import { createSlice, type PayloadAction } from "@reduxjs/toolkit";
import type { SessionQrPayload, SignRequest } from "@/lib/protocol";
import type { DecodedOperation } from "@/lib/steem/decoder";

export type ConnectionState =
  | "idle"
  | "connecting"
  | "waiting"
  | "request"
  | "sending"
  | "done"
  | "error";

export interface PendingRequest {
  /** Raw operations as received (needed for signing). */
  ops: unknown[];
  /** Human-readable decode for the approval screen. */
  decoded: DecodedOperation[];
  /** The request id to echo back in the result message. */
  requestId: string;
  /**
   * The request method sent by the app ("requestBroadcast", "authenticate",
   * …). Used to recognise an authenticate op so the app is remembered as a
   * revocable session once approved.
   */
  action?: string;
  sign?: SignRequest;
  /**
   * Arrival time (ms epoch) — the list's visible timestamp. Creation order
   * itself is the arrival order: the plane delivers rows by `seq`, which IS
   * insertion order, so the queue renders oldest-first.
   */
  at: number;
}

/**
 * Is the session's transport healthy? Protocol v3 has exactly one transport
 * (the relay plane), so this is binary: `plane` = joined and pulling,
 * `degraded` = the relay is misbehaving (join error, timeout, failed send)
 * and frames may be delayed until the room recovers. Read-only
 * diagnostics — a status failure must never break a session.
 */
export type SessionTransport = "plane" | "degraded";

interface SessionState {
  connection: ConnectionState;
  session: SessionQrPayload | null;
  /**
   * Front of the queue — what the approval modal shows and what approve /
   * reject target. `null` only when nothing is waiting.
   */
  pending: PendingRequest | null;
  /**
   * EVERY undecided request, oldest first (arrival order == row `seq`
   * order). A client firing several requests at once must not have them
   * silently overwrite each other: they queue here and are decided one by
   * one, front-first; `pending` mirrors `queue[0]`.
   */
  queue: PendingRequest[];
  lastResult: { ok: boolean; message: string; txId?: string; block?: number } | null;
  error: string | null;
  transport: SessionTransport | null;
}

const initialState: SessionState = {
  connection: "idle",
  session: null,
  pending: null,
  queue: [],
  lastResult: null,
  error: null,
  transport: null,
};

const sessionSlice = createSlice({
  name: "session",
  initialState,
  reducers: {
    setConnection(state, action: PayloadAction<ConnectionState>) {
      state.connection = action.payload;
    },
    sessionConnected(state, action: PayloadAction<SessionQrPayload>) {
      state.connection = "waiting";
      state.session = action.payload;
      state.pending = null;
      state.queue = [];
      state.lastResult = null;
      state.error = null;
      state.transport = null;
    },
    /**
     * A request arrived. It APPENDS to the queue (arrival order = row seq
     * order = creation order) instead of overwriting whatever was waiting:
     * several requests at once must render as an oldest-first list, not race
     * each other for the single slot. A replay of an id already waiting is
     * dropped — it is on screen already.
     */
    enqueueRequest(state, action: PayloadAction<PendingRequest>) {
      if (state.queue.some((r) => r.requestId === action.payload.requestId)) {
        return;
      }
      state.queue.push(action.payload);
      if (!state.pending) {
        state.pending = action.payload;
        state.connection = "request";
      }
    },
    /**
     * The front was decided (approved, broadcast, or declined): remove it and
     * promote the next oldest request, or leave `pending` null for the caller
     * to land on the result state. Front-first, strictly ascending.
     */
    dequeueRequest(state, action: PayloadAction<string>) {
      state.queue = state.queue.filter(
        (r) => r.requestId !== action.payload,
      );
      if (state.pending?.requestId === action.payload) {
        state.pending = state.queue[0] ?? null;
        if (state.pending) state.connection = "request";
      }
    },
    sessionSending(state) {
      state.connection = "sending";
    },
    sessionDone(
      state,
      action: PayloadAction<{ ok: boolean; message: string; txId?: string; block?: number }>,
    ) {
      state.connection = "done";
      state.lastResult = action.payload;
      state.pending = null;
      state.queue = [];
    },
    sessionError(state, action: PayloadAction<string>) {
      // Diagnostic/one-message errors (expired request, malformed batch) must
      // NOT wipe what is still waiting: those requests never entered the
      // queue, and the ones that did stay decidable.
      state.connection = "error";
      state.error = action.payload;
    },
    clearSession(state) {
      state.connection = "idle";
      state.session = null;
      state.pending = null;
      state.queue = [];
      state.lastResult = null;
      state.error = null;
      state.transport = null;
    },
    /**
     * Dismiss a decision result (the "Done" buttons) WITHOUT ending the
     * session. The requesting app keeps its half of the session after the
     * first operation — more requests may follow until the QR's `exp` — so
     * this only clears the result card and returns to "waiting" (or "idle"
     * when nothing is connected any more).
     */
    dismissResult(state) {
      state.lastResult = null;
      state.error = null;
      // The queue is untouched: "done" is only ever reached with it empty,
      // and dismissing a result must not swallow a request that arrived after.
      state.connection = state.session ? "waiting" : "idle";
    },
    /**
     * Transport health changed (plane / degraded). Diagnostics for the UI —
     * dispatched best-effort from the session manager, never fatal.
     */
    setTransport(state, action: PayloadAction<SessionTransport>) {
      state.transport = action.payload;
    },
  },
});

export const {
  setConnection,
  sessionConnected,
  enqueueRequest,
  dequeueRequest,
  sessionSending,
  sessionDone,
  sessionError,
  clearSession,
  dismissResult,
  setTransport,
} = sessionSlice.actions;
export default sessionSlice.reducer;
