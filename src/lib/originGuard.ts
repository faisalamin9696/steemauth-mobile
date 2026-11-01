/**
 * Origin enforcement — decides whether a scanned QR may open a transport.
 *
   * The frontend package writes the page origin into the QR as src,
   * captured from window.location.origin on the honest mint side. The phone
   * itself CANNOT verify provenance (any producer can hand-craft the field),
   * so this is a CLAIMED origin: the WebView handoff path re-stamps it from
   * its live page URL where the app can attest it. The user can block a
   * declared origin; once blocked, every future QR declaring it is refused
   * BEFORE any plane is opened - not after a connection is established.
 *
 * The decision is a pure function (`blockedReason`) taking the payload and
 * the blocklist, so the policy can be verified without a store, a network or
 * a device. The impure wrappers just read the store and notify a frontend
 * that is already waiting on the plane (so it fails fast instead of hanging
 * on "waiting" until the QR expires).
 */
import {
  sealMessage,
  type SessionMessage,
  type SessionQrPayload,
} from "@/lib/protocol";
import { connectMessagePlane } from "@/lib/messagePlane";
import { store } from "@/store";
import { blockedReason } from "@/store/blockedOriginsSlice";

// The pure decision lives with the blocklist (store-free, unit-testable);
// re-exported here so callers have a single import point.
export { blockedReason };

/** Convenience wrapper over `blockedReason` using the live store. */
export function isOriginBlocked(origin: unknown): boolean {
  return blockedReason(origin, store.getState().blockedOrigins.origins) !== null;
}

/**
 * Tell a frontend that is already waiting on the plane that we refused the
 * scan — otherwise it sits on "waiting" until the QR expires.
 *
 * Best effort by design: the frontend still has its own QR expiry, so a lost
 * notification degrades to a timeout, never to a stuck-forever session. Sends
 * the session-level `revoke` row (the same teardown the phone's own revoke
 * uses), then closes its short-lived plane handle.
 */
export function notifySessionDenied(payload: SessionQrPayload, reason: string): void {
  if (!payload.rt || !payload.rm || !payload.tk) return; // v3 QRs always carry them
  try {
    // Join the room with the PHONE token (the QR granted it), deliver the
    // denial as a sealed revoke row, then leave — best effort by design.
    const plane = connectMessagePlane({
      rt: payload.rt,
      rm: payload.rm,
      tk: payload.tk,
      sid: payload.sid,
      onMessage: () => {
        /* denial is one-way; we do not process replies */
      },
    });
    void plane
      .send(
        sealMessage(
          { type: "revoke", sid: payload.sid, reason } as SessionMessage,
          payload.k,
        ),
      )
      .catch(() => {
        /* denied-notification is best effort */
      })
      .finally(() => plane.close());
  } catch {
    /* construction failed — frontend degrades to its QR expiry */
  }
}

