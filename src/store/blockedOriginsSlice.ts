import { createSlice, type PayloadAction } from "@reduxjs/toolkit";

/**
 * A persistent blocklist of application origins.
 *
 * IMPORTANT — what the key actually is: the QR's `src` field is captured from
 * `window.location.origin` by the honest builder and is unforgeable THERE,
 * but the phone cannot verify provenance of a scanned/handed-off payload, and
 * `url` is plain display text. The enforcement key below is therefore a
 * CLAIMED origin: the blocklist refuses future QRs that *declare* the blocked
 * origin — it is a signal, not a proof. (The approval surfaces label the same
 * value as claimed for the same reason.)
 *
 * Keyed on the origin string, NOT on app name — app names are attacker-chosen
 * and freely spoofable, so a blocklist keyed on them would be trivial to walk
 * around by renaming.
 *
 * Persisted: a blocklist that forgot itself on restart would not be a
 * blocklist.
 */
export interface BlockedOriginsState {
  /** Canonical origins, e.g. `https://evil.example` — sorted, unique. */
  origins: string[];
}

const initialState: BlockedOriginsState = { origins: [] };

/**
 * Canonicalize an origin for blocklist membership so a blocked operator
 * cannot reconnect by presenting a different spelling of the same identity:
 *
 * - trim + lowercase;
 * - scheme must be http/https, otherwise `''` (nothing usable to match);
 * - DROP userinfo (`https://trusted.example@evil.example` is EVIL, and as a
 *   single key it would otherwise both miss the evil entry and block the
 *   trusted one);
 * - DROP path/query/hash (`https://evil.example/anything` == `https://evil.example`);
 * - DROP the trailing dot of a FQDN (`evil.example.` == `evil.example`);
 * - elide DEFAULT ports only (`:443` on https, `:80` on http); a non-default
 *   port is a different origin and stays (per verify-origin-block expectations);
 * - reject anything still containing `%`/whitespace in the host (encoded
 *   tricks have no single canonical spelling a strict policy should guess at —
 *   they become unusable, and unusable origins are refused at connect).
 *
 * Returns `''` for anything unusable.
 */
export function normalizeOrigin(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return "";
  const m = /^([a-z]+):\/\/([^/?#]*)(?:[/?#].*)?$/.exec(trimmed);
  if (!m) return "";
  const scheme = m[1];
  if (scheme !== "https" && scheme !== "http") return "";
  let authority = m[2];
  const at = authority.lastIndexOf("@");
  if (at >= 0) authority = authority.slice(at + 1); // drop userinfo
  let host = authority;
  let port = "";
  const colon = authority.lastIndexOf(":");
  if (colon >= 0) {
    host = authority.slice(0, colon);
    port = authority.slice(colon + 1);
  }
  host = host.replace(/\.+$/, ""); // trailing-dot FQDN == bare host
  if (!host || /[\s%]/.test(host) || /[^a-z0-9.\-]/.test(host)) return "";
  if ((scheme === "https" && port === "443") || (scheme === "http" && port === "80")) {
    port = "";
  }
  if (port && !/^\d+$/.test(port)) return "";
  return `${scheme}://${host}${port ? ":" + port : ""}`;
}

/**
 * Why a scan must be refused, or null when it may proceed.
 *
 * Pure and store-free: takes the payload's origin and the blocklist
 * explicitly, so the policy is unit-testable with no network, store or
 * device.
 *
 * - An empty/unusable origin is REFUSED (fail closed): a QR that declares no
 *   origin carries nothing the user could ever have blocked or judge at the
 *   approval surface, so it gets no benefit of the doubt.
 * - An empty blocklist blocks nothing (there is no policy to violate).
 * - Stored entries are re-canonicalized at compare time so entries persisted
 *   under the older, looser normalization still match their modern spellings.
 *
 * Lives with the blocklist rather than in `originGuard` deliberately — the
 * guard wires the store and the transport, which would drag this policy into
 * react-native imports and make it untestable under plain Node.
 */
export function blockedReason(
  origin: unknown,
  blocked: readonly string[],
): string | null {
  const normalized = normalizeOrigin(origin);
  if (!normalized) {
    return "This request does not declare an origin, so it cannot be matched " +
      "against your blocked origins — refused.";
  }
  if (blocked.length === 0) return null;
  if (!blocked.some((entry) => normalizeOrigin(entry) === normalized)) return null;
  return `This app's origin (${normalized}) is blocked in SteemAuth. Unblock it in Sessions → Blocked origins to allow it again.`;
}

const blockedOriginsSlice = createSlice({
  name: "blockedOrigins",
  initialState,
  reducers: {
    /**
     * Block an origin. Idempotent — blocking twice keeps one entry.
     * Empty/unusable origins are ignored rather than stored.
     */
    blockOrigin(state, action: PayloadAction<string>) {
      const origin = normalizeOrigin(action.payload);
      if (!origin) return;
      if (!state.origins.includes(origin)) {
        state.origins.push(origin);
        state.origins.sort();
        if (state.origins.length > 200) state.origins.shift();
      }
    },
    unblockOrigin(state, action: PayloadAction<string>) {
      const origin = normalizeOrigin(action.payload);
      if (!origin) return;
      state.origins = state.origins.filter((o) => o !== origin);
    },
    clearBlockedOrigins(state) {
      state.origins = [];
    },
  },
});

export const { blockOrigin, unblockOrigin, clearBlockedOrigins } =
  blockedOriginsSlice.actions;
export default blockedOriginsSlice.reducer;
