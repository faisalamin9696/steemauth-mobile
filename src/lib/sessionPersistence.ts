/**
 * Durable copy of the LIVE session, so a process death (Android freezer,
 * swipe-away, OS kill) does not silently orphan a session the requesting app
 * still holds: on next launch the phone resumes it — Approvals shows its
 * watch card again and the next request still lands — until the QR's own
 * `exp`, the single bound in both directions.
 *
 * Security: the blob contains the session key `k`, so it lives in the
 * platform secure storage (Keychain/Keystore via secureStorage), never plain
 * AsyncStorage, and is deleted on every teardown path. Possession of `k`
 * only lets you READ the approval channel — deciding still requires the
 * unlocked vault (PIN/biometric), exactly as before.
 *
 * The decided request ids ride along: the in-memory replay gate dies with
 * the process, and without these ids a plane replay could re-dispatch a
 * request that was already approved and broadcast.
 */
import type { SessionQrPayload } from "@/lib/protocol";
import { getItem, setItem, deleteItem } from "@/lib/secureStorage";

const KEY = "live-session";

export interface PersistedSession {
  payload: SessionQrPayload;
  /** Request ids decided (approved/rejected) in this session — gate seeds. */
  decided: string[];
}

/** Write-through on connect and on every decision. Best effort. */
export async function savePersistedSession(data: PersistedSession): Promise<void> {
  try {
    await setItem(KEY, JSON.stringify(data));
  } catch {
    // A persist miss costs a rescan after a restart — never a decision.
  }
}

export async function loadPersistedSession(): Promise<PersistedSession | null> {
  try {
    const raw = await getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PersistedSession>;
    const payload = parsed.payload as SessionQrPayload | undefined;
    // Structural + lifetime check: expired, half-written or older-schema
    // garbage must not be resumed into — discard it instead.
    if (
      !payload ||
      typeof payload.sid !== "string" ||
      typeof payload.k !== "string" ||
      typeof payload.exp !== "number" ||
      payload.exp <= Date.now() ||
      !payload.rt ||
      !payload.rm ||
      !payload.tk
    ) {
      await deleteItem(KEY).catch(() => {});
      return null;
    }
    return {
      payload,
      decided: Array.isArray(parsed.decided)
        ? parsed.decided.filter((id): id is string => typeof id === "string")
        : [],
    };
  } catch {
    return null;
  }
}

export async function deletePersistedSession(): Promise<void> {
  try {
    await deleteItem(KEY);
  } catch {
    // Best effort: worst case is a stale blob that fails its own checks.
  }
}
