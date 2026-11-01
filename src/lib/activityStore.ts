/**
 * Cloud activity storage (Supabase).
 *
 * The local redux copy remains the source of truth for the UI; entries are
 * opportunistically mirrored to a Supabase table so history survives device
 * loss and can be audited server-side. Everything degrades silently when no
 * Supabase project is configured or the table doesn't exist yet — see
 * docs/steemauth_step-2-activity-log.sql for the DDL.
 *
 * NOTE: this stores metadata only (account, action name, txId) — never keys,
 * WIFs or full operation payloads.
 */
import { getSupabaseClient, getDefaultEndpoint, hasDefaultEndpoint } from "./realtime";
import type { ActivityEntry } from "@/store/activitySlice";

const TABLE = "steemauth_activity";

interface ActivityRow {
  id: string;
  account: string;
  action: string;
  app_name: string;
  ok: boolean;
  tx_id: string | null;
  error: string | null;
  at: string;
}

/** Push one entry. Resolves true when it reached Supabase (or was already there). */
export async function pushActivity(entry: ActivityEntry): Promise<boolean> {
  if (!hasDefaultEndpoint()) return false;
  try {
    const client = getSupabaseClient(getDefaultEndpoint());
    const { error } = await client.from(TABLE).insert({
      id: entry.id,
      account: entry.account,
      action: entry.action,
      app_name: entry.app,
      ok: entry.ok,
      tx_id: entry.txId ?? null,
      error: entry.error ?? null,
      at: new Date(entry.at).toISOString(),
    });
    // 23505 = unique violation → the row already reached the cloud on a
    // previous attempt; treat as synced (retries stay idempotent).
    if (error && error.code !== "23505") return false;
    return true;
  } catch {
    return false; // offline / not configured — local copy still stands
  }
}

/**
 * Fetch ONE account's most recent entries (newest first) - never the whole
 * table: it holds every user's rows, and this device should only ever see the
 * active account's history. Empty when there is no account to scope to, or on
 * any failure.
 */
export async function pullActivity(
  account: string,
  limit = 100,
): Promise<ActivityEntry[]> {
  if (!account || !hasDefaultEndpoint()) return [];
  try {
    const client = getSupabaseClient(getDefaultEndpoint());
    const { data, error } = await client
      .from(TABLE)
      .select("id,account,action,app_name,ok,tx_id,error,at")
      .eq("account", account)
      .order("at", { ascending: false })
      .limit(limit);
    if (error || !Array.isArray(data)) return [];
    return (data as ActivityRow[]).map((r) => ({
      id: r.id,
      at: new Date(r.at).getTime(),
      account: r.account,
      action: r.action,
      app: r.app_name,
      ok: r.ok,
      txId: r.tx_id ?? undefined,
      error: r.error ?? undefined,
      synced: true,
    }));
  } catch {
    return [];
  }
}

/** True when a Supabase project is configured for activity sync. */
export function activitySyncConfigured(): boolean {
  return hasDefaultEndpoint();
}
