/**
 * Durable session state (Supabase) — the control plane.
 *
 * A `revoke` must never depend on who happens to be listening, so a frame
 * alone is never the mechanism. This table is what survives: the phone
 * records the session when an `authenticate` request is approved, marks it
 * revoked from the Sessions tab, and the requesting site can watch its own
 * row to learn it has been kicked.
 *
 * Messages themselves travel over the v3 relay (steemauth-relay) — this table
 * carries lifecycle only, never keys, signatures or operation payloads.
 * See docs/steemauth_step-1-sessions-control-plane.sql.
 *
 * Everything degrades silently when no Supabase project is configured, the
 * same way activity sync does: a missing row must never block a signing flow.
 */
import {
  getSupabaseClient,
  getDefaultEndpoint,
  hasDefaultEndpoint,
} from "./realtime";

const TABLE = "steemauth_sessions";

export type SessionRecordStatus =
  /** row exists, not revoked, not yet past expiry */
  | "active"
  /** the user revoked this app */
  | "revoked"
  /** past `expires_at` — inert even if never explicitly revoked */
  | "expired"
  /** no row for this sid: the session was never registered */
  | "unregistered"
  /** could not be determined (offline / not configured) */
  | "unknown";

/**
 * How long an APPROVED LOGIN GRANT stays active — the standing authorization
 * the Sessions tab lists and the user revokes. Deliberately the same window
 * as the frontend's signed-challenge proof (`AUTH_EXPIRES_IN_MS`, 7 days):
 * the row is the authentication, not the scan code that carried the first
 * approval. The sweeper collects a week after this expiry for audit.
 */
export const SESSION_GRANT_TTL_MS = 7 * 24 * 60 * 60_000;

/**
 * Record a session the moment an `authenticate` request is approved.
 *
 * `expiresAtMs` is the GRANT's expiry (ms epoch) — the caller passes
 * `now + SESSION_GRANT_TTL_MS`, never the QR's `exp`: measuring the row by
 * the scan code made every login show as "Expired" 15 minutes after the
 * phone scanned it, long before the 7-day authentication it established.
 *
 * Resolves true when the row reached Supabase — or was already there.
 */
export async function recordSession(opts: {
  sid: string;
  account: string;
  appName: string;
  expiresAtMs: number;
}): Promise<boolean> {
  if (!hasDefaultEndpoint()) return false;
  try {
    const client = getSupabaseClient(getDefaultEndpoint());
    const { error } = await client.from(TABLE).insert({
      sid: opts.sid,
      account: opts.account,
      app_name: opts.appName,
      expires_at: new Date(opts.expiresAtMs).toISOString(),
    });
    // 23505 = already recorded on a previous attempt → treat as synced.
    if (error && error.code !== "23505") return false;
    return true;
  } catch {
    return false; // offline / not configured
  }
}

/**
 * Mark a session revoked.
 *
 * Note this is an UPDATE on (revoked_at, revoked_reason) only — the column
 * grants in steemauth_step-1-sessions-control-plane.sql deliberately refuse `expires_at`, so nothing
 * here can push an expiry out, and RLS refuses to clear a revocation.
 *
 * Resolves true when the write was accepted. PostgREST reports "updated 0
 * rows" without an error when the sid was never recorded, which is not a
 * failure worth surfacing.
 */
export async function revokeSession(
  sid: string,
  reason = "Revoked in the authenticator.",
): Promise<boolean> {
  if (!hasDefaultEndpoint()) return false;
  try {
    const client = getSupabaseClient(getDefaultEndpoint());
    const { error } = await client
      .from(TABLE)
      .update({ revoked_at: new Date().toISOString(), revoked_reason: reason })
      .eq("sid", sid);
    if (error) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Look up one sid's lifecycle state.
 *
 * Returns `unknown` on any transport failure rather than guessing, so the
 * caller can decide its own fail-open / fail-closed policy instead of having
 * availability silently baked in here.
 */
export async function fetchSessionStatus(
  sid: string,
): Promise<SessionRecordStatus> {
  if (!hasDefaultEndpoint()) return "unknown";
  try {
    const client = getSupabaseClient(getDefaultEndpoint());
    const { data, error } = await client
      .from(TABLE)
      .select("sid,expires_at,revoked_at")
      .eq("sid", sid)
      .maybeSingle();
    if (error) return "unknown";
    if (!data) return "unregistered";

    const row = data as { expires_at: string; revoked_at: string | null };
    if (row.revoked_at) return "revoked";
    if (new Date(row.expires_at).getTime() <= Date.now()) return "expired";
    return "active";
  } catch {
    return "unknown";
  }
}

/** True when a Supabase project is configured for session sync. */
export function sessionSyncConfigured(): boolean {
  return hasDefaultEndpoint();
}

interface SessionRow {
  sid: string;
  account: string;
  app_name: string;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
}

/** Lifecycle of a row as of "now", computed client-side. */
export interface CloudSession {
  sid: string;
  account: string;
  appName: string;
  createdAt: number;
  expiresAt: number;
  revokedAt: number | null;
  status: "active" | "revoked" | "expired";
}

/**
 * Pull the most recent session rows (newest first) so the Sessions tab can
 * list what is actually active on the control plane — including sessions
 * approved on another device.
 *
 * Status is computed here (not in SQL) so one query serves every caller.
 * Empty array on any failure: the local registry still stands.
 */
export async function pullSessions(limit = 100): Promise<CloudSession[]> {
  if (!hasDefaultEndpoint()) return [];
  try {
    const client = getSupabaseClient(getDefaultEndpoint());
    const { data, error } = await client
      .from(TABLE)
      .select("sid,account,app_name,created_at,expires_at,revoked_at")
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error || !Array.isArray(data)) return [];
    const now = Date.now();
    return (data as SessionRow[]).map((r) => {
      const revokedAt = r.revoked_at ? new Date(r.revoked_at).getTime() : null;
      const expiresAt = new Date(r.expires_at).getTime();
      return {
        sid: r.sid,
        account: r.account,
        appName: r.app_name,
        createdAt: new Date(r.created_at).getTime(),
        expiresAt,
        revokedAt,
        status: revokedAt ? "revoked" : expiresAt <= now ? "expired" : "active",
      };
    });
  } catch {
    return [];
  }
}
