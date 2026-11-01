/**
 * Session orchestration: bridges the QR-scanned session, the relay plane
 * (protocol v3 — token-authenticated rooms with sequenced logs + replay)
 * and the local signing pipeline.
 */
import {
  appOrigin,
  assertMessageForSession,
  openMessage,
  sealMessage,
  type SessionMessage,
  type SessionQrPayload,
} from "@/lib/protocol";
import { store } from "@/store";
import {
  clearSession,
  sessionConnected,
  sessionDone,
  sessionError,
  enqueueRequest,
  dequeueRequest,
  sessionSending,
  type PendingRequest,
  setTransport,
  type SessionTransport,
} from "@/store/sessionSlice";
import { logActivity, markSynced, type ActivityEntry } from "@/store/activitySlice";
import {
  removeConnectedApp,
  upsertConnectedApp,
} from "@/store/connectedAppsSlice";
import { blockedReason, notifySessionDenied } from "@/lib/originGuard";
import { setActiveAccount } from "@/store/accountsSlice";
import { normalizeOrigin } from "@/store/blockedOriginsSlice";
import { pushActivity } from "@/lib/activityStore";
import {
  fetchSessionStatus,
  recordSession,
  revokeSession,
  SESSION_GRANT_TTL_MS,
} from "@/lib/sessionsStore";
import { validateOperationBatch } from "@/lib/steem/decoder";
import { connectMessagePlane } from "@/lib/messagePlane";
import { createRequestGate } from "@/lib/replayGuard";
import {
  deletePersistedSession,
  loadPersistedSession,
  savePersistedSession,
} from "@/lib/sessionPersistence";
import { broadcastOperations } from "@/lib/steem/transaction";
import { signMessage } from "@/lib/steem/keys";
import type { Operation } from "@/lib/steem/serializer";

/** Log locally, then mirror to Supabase when configured. */
function recordActivity(entry: ActivityEntry) {
  store.dispatch(logActivity(entry));
  if (!entry.synced) {
    void pushActivity(entry).then((ok) => {
      if (ok) store.dispatch(markSynced(entry.id));
    });
  }
}

let teardown: (() => void) | null = null;
/** Transport-agnostic outbound send (opaque payload to the room peer). */
let sendFn: ((payload: unknown) => Promise<void>) | null = null;
let current: SessionQrPayload | null = null;
let pendingRequestId: string | null = null;
/**
 * In-flight approval claim for the at-most-once guard: set synchronously at
 * the top of approvePendingOperations and released in its finally. Module
 * scope on purpose — it must outlive any one React surface (the same request
 * can be approved from the session screen, the approvals tab, or the browser
 * sheet, and the biometric unlock chain runs before the UI disables itself).
 */
let approvingId: string | null = null;
/**
 * The QR's `exp` is the single bound on a session's life (armed in
 * connectSession, cleared in disconnectSession). UI actions — Close, lock,
 * dismissing a result — deliberately do NOT end a session: the requesting
 * app keeps its half after the first operation and may send follow-up
 * requests until the code itself expires, and killing the room here is
 * exactly how approvals went missing while rows piled up in the table.
 */
let expiryTimer: ReturnType<typeof setTimeout> | null = null;
/**
 * At most one DECISION per request id for the life of a session (protocol v3
 * replays are at-least-once): a request the user already approved or rejected
 * is never dispatched — and therefore never broadcast — a second time.
 * Undecided redeliveries still pass: that is a re-show, which is what the
 * web's resume-after-refresh re-send relies on.
 */
const requestGate = createRequestGate();

/** Best-effort transport status: only dispatch when the value actually changes. */
function setT(transport: SessionTransport): void {
  if (store.getState().session.transport !== transport) {
    store.dispatch(setTransport(transport));
  }
}

/** Human label for an ops batch, e.g. "vote" or "3 operations". */
function describeOps(ops: unknown[]): string {
  if (ops.length === 1) {
    const first = ops[0];
    if (Array.isArray(first) && typeof first[0] === "string") return first[0];
  }
  return `${ops.length} operations`;
}

/** Omit that distributes over the SessionMessage union. */
type OutboundMessage = SessionMessage extends infer M
  ? M extends { sid: string }
    ? Omit<M, "sid"> & { sid?: string }
    : M
  : never;

function send(message: OutboundMessage) {
  if (!current || !sendFn) return;
  const full = { ...message, sid: current.sid } as SessionMessage;
  sendFn(sealMessage(full, current.k)).catch((e) => {
    // Best effort (frontend also has QR expiry), but never SILENT — a lost
    // grant or dead table must be visible in logs, like recordSession.
    console.warn(
      "[steemauth] outbound message failed:",
      e instanceof Error ? e.message : e,
    );
  });
}

/**
 * Write-through: the live session + decided ids must survive a process death
 * (Android freezer, swipe-away) so the connection can come back on next
 * launch — see sessionPersistence for the security boundary.
 */
/**
 * A request arrived: APPEND it (creation order == arrival order == row seq)
 * and, when it becomes the front, make it the id endSession / cancel speak
 * for. Several requests at once queue up instead of overwriting each other.
 */
function queueRequest(entry: PendingRequest): void {
  const hadFront = !!store.getState().session.pending;
  store.dispatch(enqueueRequest(entry));
  if (!hadFront) {
    pendingRequestId = store.getState().session.pending?.requestId ?? null;
  }
}

function persistCurrent(): void {
  if (!current) return;
  void savePersistedSession({ payload: current, decided: requestGate.ids() });
}

function handleMessage(raw: unknown) {
  const session = current;
  // Targeted session: the QR named the account it is for. If the user
  // switched accounts by hand mid-session, every message re-asserts the
  // target BEFORE validation, so requests always run against the right key
  // instead of failing an expected-account check.
  if (session?.account && store.getState().accounts.activeUsername !== session.account) {
    const linked = store
      .getState()
      .accounts.accounts.some((a) => a.username.toLowerCase() === session.account);
    if (linked) store.dispatch(setActiveAccount(session.account));
  }
  if (!session) {
    // Never silent: a row arriving for a session this device no longer holds
    // is exactly the failure class that hid approvals while the table grew —
    // logcat must show it (metadata only; payloads are never logged).
    console.warn(
      "[steemauth] message dropped — no active session on this device",
    );
    return;
  }
  // Encrypt-then-MAC: envelopes failing HMAC verification or decryption are
  // dropped silently — a malicious relay has nothing it can inject.
  let message: SessionMessage | null = openMessage(raw, session.k);
  if (!message) return;
  try {
    assertMessageForSession(message, session.sid);
  } catch {
    return; // foreign session traffic
  }

  switch (message.type) {
    case "request": {
      // Replay guard FIRST: a row redelivered after its decision (or from an
      // earlier session) must never reach the approval screen again — the
      // screen re-showing a decided request is how it gets broadcast twice.
      if (!requestGate.shouldDispatch(message.id)) {
        console.log("[steemauth] replay ignored - request already decided:", message.id);
        return;
      }
      if (message.exp && Date.now() > message.exp) {
        store.dispatch(sessionError("This request has expired."));
        return;
      }
      const account = store.getState().accounts.activeUsername ?? undefined;

      // Off-chain signing: there is nothing to broadcast, so the operation
      // whitelist does not apply. The approval screen must show `sign.data`
      // verbatim — that text is exactly what the user is putting their key to.
      if (message.sign) {
        if (message.ops?.length) {
          const reason =
            "This request is malformed — it cannot sign and broadcast at once.";
          store.dispatch(sessionError(reason));
          send({ type: "result", id: message.id, ok: false, error: reason });
          return;
        }
        if (!message.sign.data) {
          const reason = "This request is missing the text to sign.";
          store.dispatch(sessionError(reason));
          send({ type: "result", id: message.id, ok: false, error: reason });
          return;
        }
        // Login-challenge re-assert (defense in depth for authenticate()):
        // a structured challenge that claims THIS session must carry THIS
        // session's verified origin (appOrigin = src ?? url). The package
        // signs the verified src; a mismatch means someone built a challenge
        // for our sid with a foreign Origin line — spoofable login-proof
        // material — and it must never reach the signing surface.
        const claimedSid = /(?:^|\n)Session: ([^\r\n]+)/.exec(message.sign.data);
        if (claimedSid && claimedSid[1] === session.sid) {
          const claimedOrigin = /(?:^|\n)Origin: ([^\r\n]+)/.exec(message.sign.data);
          const expectedOrigin = appOrigin(session);
          if (claimedOrigin && expectedOrigin && claimedOrigin[1] !== expectedOrigin) {
            const reason =
              "This sign-in challenge claims this session but a different origin — refused.";
            console.warn("[steemauth] sign challenge refused — origin mismatch");
            store.dispatch(sessionError(reason));
            send({ type: "result", id: message.id, ok: false, error: reason });
            return;
          }
        }
        queueRequest({
          ops: [],
          decoded: [],
          requestId: message.id,
          action: message.action,
          sign: message.sign,
          at: Date.now(),
        });
        break;
      }

      const result = validateOperationBatch(message.ops, {
        expectedAccount: account,
      });
      if (!result.ok) {
        const reason = result.error ?? "Invalid request.";
        store.dispatch(sessionError(reason));
        send({ type: "result", id: message.id, ok: false, error: reason });
        return;
      }
      queueRequest({
        ops: message.ops,
        decoded: result.decoded,
        requestId: message.id,
        action: message.action,
        at: Date.now(),
      });
      break;
    }
    case "cancel":
      // Explicit + visible: the requesting app closed the live session (its
      // "Phone connected" control) - the watch card drops, not idles.
      console.log("[steemauth] session ended by the requesting app");
      pendingRequestId = null;
      store.dispatch(clearSession());
      disconnectSession();
      // The peer ended the session — nothing to resume on next launch.
      void deletePersistedSession();
      break;
    case "ping":
      send({ type: "pong" });
      break;
    default:
      break;
  }
}

/**
 * Start (or restart) the realtime channel for a scanned session.
 *
 * Returns `null` once the transport is opening, or the reason the scan was
 * refused. The blocklist is checked FIRST — before a single socket opens —
 * so a blocked origin never gets to touch the relay.
 */
export function connectSession(
  payload: SessionQrPayload,
  opts?: {
    /** Hydrated decided ids (process-death resume) — reseeds the gate. */
    decided?: string[];
    /** Fires when the relay room has actually joined (ready can flow). */
    onSubscribed?: () => void;
  },
): string | null {
  const reason = blockedReason(
    appOrigin(payload),
    store.getState().blockedOrigins.origins,
  );
  if (reason) {
    // The frontend may already be sitting in the room waiting — tell it, so
    // it fails fast instead of hanging until the QR expires.
    notifySessionDenied(payload, reason);
    store.dispatch(sessionError(reason));
    return reason;
  }

  // Targeted session: the QR names the account it expects. Linked -> make it
  // the active account BEFORE the ready handshake, so the phone announces it
  // and every request validates against the right key - no manual switching
  // for multi-account users. Not linked -> refuse with an actionable reason.
  if (payload.account) {
    const accounts = store.getState().accounts;
    const linked = accounts.accounts.some(
      (a) => a.username.toLowerCase() === payload.account,
    );
    if (!linked) {
      const reason = `This request targets @${payload.account}, which is not in SteemAuth on this device.`;
      // Never silent: a refusal leaves no row in the table, so logcat is the
      // only place it can be diagnosed.
      console.warn("[steemauth] session refused:", reason);
      notifySessionDenied(payload, reason);
      store.dispatch(sessionError(reason));
      return reason;
    }
    if (accounts.activeUsername !== payload.account) {
      store.dispatch(setActiveAccount(payload.account));
    }
  }

  // Re-scan of the SAME still-valid QR: the replay gate's decided ids are
  // session-scoped knowledge — a reconnect must not forget decisions already
  // made, or a redelivered row re-dispatches an approved request for a second
  // broadcast. Capture before disconnectSession() resets the gate.
  const preservedDecided =
    current && current.sid === payload.sid ? requestGate.ids() : undefined;

  disconnectSession();
  // Resuming: re-seed the decided ids BEFORE the plane subscribes, so the
  // replay pull can never re-dispatch a request decided before the restart.
  if (opts?.decided?.length) requestGate.hydrate(opts.decided);
  else if (preservedDecided?.length) requestGate.hydrate(preservedDecided);
  current = payload;
  store.dispatch(sessionConnected(payload));

  // Protocol v3: the QR IS the transport contract — `rm`/`tk` are the relay
  // room and the phone's token (validated while parsing the QR), and every
  // message, including this `ready` handshake, travels as a sealed row in
  // the room log. No second transport exists.
  if (!payload.rt || !payload.rm || !payload.tk) {
    // Unreachable for QRs that passed parseSessionQr; a guard for
    // programmatically-constructed payloads only.
    const reason =
      "This QR has no relay room (rt/rm/tk) — update the requesting app to a v3 build.";
    store.dispatch(sessionError(reason));
    return reason;
  }

  const plane = connectMessagePlane({
    rt: payload.rt,
    rm: payload.rm,
    tk: payload.tk,
    sid: payload.sid,
    onMessage: handleMessage,
    // No wall-clock watermark: every QR mints a FRESH room, so no honest row
    // can predate the session in it, and decided ids are re-seeded above.
    // The old page-clock `ts` watermark compared CLIENT time to the SERVER's
    // created_at and permanently dropped legitimate early frames whenever the
    // minting page ran ahead of the server (accepted skew was 60s).
    onStatus: (status) => {
      // Best effort, never fatal: diagnostics for the UI only.
      if (status === "connected") {
        setT("plane");
        opts?.onSubscribed?.();
      } else if (status === "failed") {
        console.warn("[steemauth] relay plane failed", "- replay retries on reconnect");
        setT("degraded");
      }
    },
  });
  // A failed send is a delayed frame at worst, so mark the session degraded
  // (warn, never throw) and let the channel recover — rejoin + pull-replay
  // delivers whatever was missed while the socket was down.
  sendFn = async (p) => {
    try {
      await plane.send(p);
      setT("plane");
    } catch (e) {
      setT("degraded");
      console.warn(
        "[steemauth] relay send failed:",
        e instanceof Error ? e.message : e,
      );
    }
  };
  teardown = () => plane.close();
  setT("plane");

  // The session lives exactly as long as the QR says (`payload.exp`). Close,
  // lock and result dismissal no longer tear it down — follow-up operations
  // from the same app must still be approvable — so the QR's own expiry is
  // the single teardown bound.
  armExpiry(payload.exp);

  const account = store.getState().accounts.activeUsername ?? "";
  // The handshake itself is a row — the frontend subscribed from the QR's
  // endpoint before showing the QR, so nothing can race this announcement.
  // A RESUME re-sends it too: idempotent for the web (same sid, same
  // account) and it re-announces "the phone is back" after a restart.
  send({
    type: "ready",
    account,
    authority: "posting",
  });
  persistCurrent();
  return null;
}

/**
 * Called by the UI once a session is live and the account is known — records
 * the app in the persistent "connected apps" registry so the user can
 * review/revoke it later.
 */
export function markAppConnected() {
  const session = current;
  if (!session) return;
  const account = store.getState().accounts.activeUsername ?? "unknown";
  store.dispatch(
    upsertConnectedApp({
      app: session.app,
      // Verified origin (`src`) wins over the developer-declared `url`.
      url: appOrigin(session),
      account,
      sid: session.sid,
    }),
  );
}

/**
 * Terminate the live session when its origin has just been blocked — blocking
 * a hostile origin must also cut the session it is currently holding, not only
 * future scans.
 *
 * Sends a `revoke` so the frontend tears down immediately, drops the session
 * state, and marks the durable cloud row revoked (the session really is over).
 * Returns true when a live session was terminated.
 */
export function terminateSessionForOrigin(origin: string): boolean {
  const session = current;
  if (!session) return false;
  if (normalizeOrigin(appOrigin(session)) !== normalizeOrigin(origin)) {
    return false; // the live session belongs to a different origin
  }
  notifySessionDenied(
    session,
    "This app's origin was blocked in SteemAuth.",
  );
  // The session is genuinely over, so the durable row must reflect it —
  // otherwise another device still shows it active after the transport died.
  if (session.sid) {
    void revokeSession(session.sid, "Origin blocked in the authenticator.");
  }
  store.dispatch(clearSession());
  disconnectSession();
  void deletePersistedSession();
  return true;
}

/**
 * Revoke an authorized app. If it currently holds the live session, send a
 * `revoke` message so the frontend tears its session down immediately, then
 * close the transport. Always drops the app from the registry.
 *
 * Returns true when a live session was torn down as part of the revoke.
 */
export function revokeConnectedApp(id: string): boolean {
  const session = current;
  const entry = store
    .getState()
    .connectedApps.apps.find((a) => a.id === id);
  // Identity must match the value markAppConnected STORED (appOrigin = the
  // verified src when present). Comparing the raw declared url instead made
  // every default browser QR (url = '') fail the match, skipping teardown.
  const matchesLive =
    !!session && !!entry && session.app === entry.app && appOrigin(session) === entry.url;

  if (matchesLive && session) {
    // Tell the frontend to tear down BEFORE we drop the transport.
    send({ type: "revoke", reason: "Access was revoked in the authenticator." });
    store.dispatch(clearSession());
    disconnectSession();
    void deletePersistedSession();
  }

  store.dispatch(removeConnectedApp(id));

  // Persist the revocation alongside tearing down the live transport. This is
  // the durable half: the in-band frame above only reaches a frontend that is
  // still in the room, while this row can be read by a site that reconnects
  // later. Best effort — revoking locally still succeeds if offline.
  if (entry?.lastSid) {
    void revokeSession(entry.lastSid, "Revoked in the authenticator.").then(
      (ok) => {
        if (!ok) {
          console.warn(
            "[steemauth] revocation was NOT persisted — the in-band frame still went out, but a reconnecting app would not learn of it",
          );
        }
      },
    );
  }

  return matchesLive;
}

export function disconnectSession() {
  teardown?.();
  teardown = null;
  sendFn = null;
  current = null;
  pendingRequestId = null;
  // A replaced or ended session must not have a stale timer firing into the
  // next one (connectSession re-arms for the new QR after this call).
  if (expiryTimer) {
    clearTimeout(expiryTimer);
    expiryTimer = null;
  }
  // The session is over: forget decided ids so the NEXT session starts clean
  // (the fresh room already scopes every row to this session).
  requestGate.reset();
}

/**
 * Tear the session down when the QR's `exp` is reached — the one bound that
 * replaces every UI-initiated end. Best-effort: a backgrounded app delays JS
 * timers, and the request-level `exp` check backstops any row that slips past
 * a late timer.
 */
function armExpiry(exp: number) {
  if (expiryTimer) clearTimeout(expiryTimer);
  expiryTimer = setTimeout(
    () => {
      expiryTimer = null;
      console.log("[steemauth] session expired (QR exp reached) — tearing down");
      endSession();
    },
    Math.max(0, exp - Date.now()),
  );
}

/**
 * Sign and broadcast the pending operations with the unlocked WIF,
 * then report the result back to the requesting app.
 *
 * Works with **no live session** too: `send()` already no-ops when there is
 * no room to answer — the work (sign/broadcast/activity) is identical.
 */
export async function approvePendingOperations(
  wif: string,
): Promise<void> {  const session = current;
  const pending = store.getState().session.pending;
  if (!pending) throw new Error("No active request.");
  // AT-MOST-ONCE at the approve boundary itself: nothing before this point
  // prevented a second entry (the biometric unlock chain runs while the
  // approve button is still enabled, and the replay gate is only consulted at
  // message dispatch). One in-flight id per process, synchronously claimed.
  if (approvingId === pending.requestId) {
    throw new Error("This request is already being approved.");
  }
  approvingId = pending.requestId;
  // Durable WRITE-AHEAD: the id becomes non-re-dispatchable BEFORE the
  // broadcast, so a process death in the broadcast→persist window can never
  // resurrect an executed request (the module's own persistence comment
  // names exactly this cost of a missed write — after a broadcast it costs a
  // second execution). On failure the id stays decided and the result card
  // reports the outcome instead of silently re-arming a re-approval.
  requestGate.decide(pending.requestId);
  persistCurrent();

  // Off-chain signing has nothing to broadcast: sign the challenge and hand
  // back the compact signature. Nothing is written to the chain.
  const sign = pending.sign;
  const action = sign
    ? `sign (${sign.keyType ?? "Posting"})`
    : describeOps(pending.ops);
  const account = store.getState().accounts.activeUsername ?? "unknown";
  const appName = session?.app ?? "unknown";

  store.dispatch(sessionSending());
  try {
    // Durable revocation outranks the local session: a revoke written from
    // another device must stop signing on this one (the control plane has no
    // other phone-side reader — fetchSessionStatus is the check this pipeline
    // was missing). Unconfigured/failed lookups return "unknown" and fail
    // OPEN so a control-plane outage never blocks a legitimate approval.
    if (session) {
      const status = await fetchSessionStatus(session.sid);
      if (status === "revoked") {
        console.warn("[steemauth] approval refused — session revoked in the control plane");
        disconnectSession();
        void deletePersistedSession();
        throw new Error("This session was revoked in the authenticator.");
      }
    }
    // The confirmation RPC also yields the inclusion block — the receipt
    // shows it ("Included in block N"); the local txid stays the fallback.
    const confirmation = sign
      ? undefined
      : await broadcastOperations(pending.ops as Operation[], wif);
    const txId = confirmation?.id;
    const block = confirmation?.block_num;
    const signature = sign ? signMessage(sign.data, wif) : undefined;

    send({
      type: "result",
      id: pending.requestId,
      ok: true,
      txId,
      account,
      signature,
    });
    // An authenticate op is the app establishing a standing session —
    // remember it so the user can revoke it later from Sessions, and mirror
    // the row to Supabase so that revocation outlives any connection (a `revoke`
    // frame only reaches whoever is listening right now). Best effort: a
    // missing row must never block a signature the user already approved.
    if (session && pending.action === "authenticate") {
      markAppConnected();
      // Best effort — a missing row must never block a signature the user
      // already approved — but a SILENT failure is how a broken grant goes
      // unnoticed: that is exactly what happened when steemauth_sessions lost
      // its table privileges, and nothing reported it.
      void recordSession({
        sid: session.sid,
        account,
        appName: session.app,
        // The GRANT, not the scan code: this row is the standing
        // authorization shown in Sessions (and revocable there), so it lives
        // for the 7-day authentication window - the QR's minutes only bound
        // the approval CHANNEL, not the login it established.
        expiresAtMs: Date.now() + SESSION_GRANT_TTL_MS,
      }).then((ok) => {
        if (!ok) {
          console.warn(
            "[steemauth] session row was NOT recorded — check grants on steemauth_sessions",
          );
        }
      });
    }
    recordActivity({
      id: pending.requestId,
      at: Date.now(),
      account,
      action,
      app: appName,
      ok: true,
      txId,
    });
    // Terminal for this id: a replayed copy of an approved request must never
    // reach the approval screen again — that is what keeps it to ONE
    // broadcast even when a plane replay delivers the row twice.
    requestGate.decide(pending.requestId);
    persistCurrent();
    pendingRequestId = null;
    // The front is decided and reported: take it off the queue and show the
    // NEXT request if the client sent several - only an EMPTY queue lands on
    // the result card.
    store.dispatch(dequeueRequest(pending.requestId));
    if (!store.getState().session.pending) {
      store.dispatch(
        sessionDone({
          ok: true,
          message: sign ? "Signed." : "Approved and broadcast.",
          txId,
          block,
        }),
      );
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : "Broadcast failed.";
    send({ type: "result", id: pending.requestId, ok: false, error: message });
    recordActivity({
      id: pending.requestId,
      at: Date.now(),
      account,
      action,
      app: appName,
      ok: false,
      error: message,
    });
    pendingRequestId = null;
    // Failure is per-request too: dequeue the front, let the next one take
    // over, and only show the result card when nothing else is waiting.
    store.dispatch(dequeueRequest(pending.requestId));
    if (!store.getState().session.pending) {
      store.dispatch(sessionDone({ ok: false, message }));
    }
    throw e;
  } finally {
    approvingId = null;
  }
}

export function rejectPendingOperations(reason = "User rejected the request.") {
  const pending = store.getState().session.pending;
  if (!pending) return; // nothing waiting - nothing to refuse
  send({ type: "result", id: pending.requestId, ok: false, error: reason });
  recordActivity({
    id: pending.requestId,
    at: Date.now(),
    account: store.getState().accounts.activeUsername ?? "unknown",
    action: describeOps(pending.ops),
    app: current?.app ?? "unknown",
    ok: false,
    error: reason,
  });
  // Rejected is a decision too: a replay must not resurrect it.
  requestGate.decide(pending.requestId);
  persistCurrent();
  pendingRequestId = null;
  // Only the FRONT is refused: the rest of the queue stays, oldest first.
  store.dispatch(dequeueRequest(pending.requestId));
  if (!store.getState().session.pending) {
    // A rejection is a decision, not the end of the session: the app keeps
    // its half and may send the next request until the QR's `exp`. Only an
    // empty queue lands on the "not completed" result card.
    store.dispatch(sessionDone({ ok: false, message: reason }));
  }
}

/**
 * Explicit teardown of the live session. UI dismissal (Close, lock, Done)
 * deliberately does NOT call this — the session lives until the QR's `exp`
 * (armed in connectSession) so follow-up operations can still arrive. The
 * callers left are the paths that genuinely end it early: the expiry timer,
 * a blocked origin, an app revoke, and a peer-sent cancel.
 */
export function endSession() {
  // A cancel is only meaningful while a request is waiting — sending one with
  // an empty id just makes the web log a protocol error for an unknown row.
  if (pendingRequestId) {
    send({ type: "cancel", id: pendingRequestId, reason: "Session ended" });
  }
  store.dispatch(clearSession());
  disconnectSession();
  void deletePersistedSession();
}

/**
 * App start: bring back a session whose QR has not expired yet, so a process
 * death (Android freezer, swipe-away, OS kill) does not orphan a session the
 * requesting app still holds — the Approvals watch card and the plane come
 * back without a rescan, and the phone's half dies exactly at `exp` like any
 * other session.
 *
 * Returns true when a live session was restored. Never throws.
 */
export async function resumePersistedSession(): Promise<boolean> {
  if (current) return true;
  const saved = await loadPersistedSession();
  if (!saved) return false;
  // Durable revocation outranks the local copy: a session revoked from
  // another device must not resurrect on this one (fail-open on outage —
  // fetchSessionStatus returns "unknown" when unconfigured or unreachable).
  const status = await fetchSessionStatus(saved.payload.sid);
  if (status === "revoked") {
    console.warn("[steemauth] resume refused — session revoked in the control plane");
    await deletePersistedSession();
    return false;
  }
  const refused = connectSession(saved.payload, { decided: saved.decided });
  if (refused) {
    // Blocked origin or unusable payload: the session cannot live — drop the
    // stale copy so we never retry a refusal on every launch.
    await deletePersistedSession();
    return false;
  }
  console.log(
    "[steemauth] resumed live session from secure storage - expires",
    new Date(saved.payload.exp).toISOString(),
  );
  return true;
}
