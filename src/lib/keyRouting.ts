/**
 * Which stored key may sign a given request — PURE module (no store, no RPC,
 * no React Native imports) so the rules that decide "can this phone sign this
 * at all?" are unit-testable under plain Node, exactly like `steem/authority`.
 *
 * Why this exists: an account on this device can now hold SEVERAL keys
 * (posting + active + owner + memo). A request demands a specific authority,
 * and the approval screen must answer two questions before it ever shows a
 * PIN prompt:
 *
 *   1. which of the stored keys should be used? (`pickKeyAuthority`)
 *   2. if none can satisfy it, say WHICH key to add instead of letting the
 *      broadcast fail on-chain with an opaque `missing authority` error.
 *
 * Substitution rule — a key only ever substitutes *upward*:
 *
 *   posting → active → owner        (stronger signs for weaker)
 *   memo    → memo                  (exact only: memo keys are not part of
 *                                    the broadcast authority ladder, they
 *                                    encrypt; a posting signature for a memo
 *                                    proof would simply be rejected)
 *
 * Never downward — signing a transfer with a posting key can only produce a
 * chain rejection, so it is refused here with a human message instead.
 */
import { batchAuthority } from "./steem/authority";

/** The four Steem key authorities this app can hold. */
export type KeyRole = "posting" | "active" | "owner" | "memo";

/** Every role, in weakest-first order (the ladder a key may climb). */
export const KEY_ROLES = ["posting", "active", "owner", "memo"] as const;

/** Display order for chips: strongest first, memo last. */
export const ROLE_DISPLAY_ORDER = ["owner", "active", "posting", "memo"] as const;

export function isKeyRole(v: unknown): v is KeyRole {
  return typeof v === "string" && (KEY_ROLES as readonly string[]).includes(v);
}

/** Strength ladder used for substitution (memo is deliberately not here). */
const AUTHORITY_RANK: Record<KeyRole, number> = {
  memo: 0,
  posting: 1,
  active: 2,
  owner: 3,
};

/** Short, human label for a role — used by chips, banners and errors. */
export function roleLabel(role: KeyRole): string {
  return role.charAt(0).toUpperCase() + role.slice(1);
}

/**
 * Risk accent per role — drives the BORDER color of the required-key-type
 * chips on the approval surfaces, so the eye reads the stakes before the
 * words:
 *
 *   posting → success (green)   routine: votes, comments, rewards
 *   active  → warning (amber)   moves funds: transfers, power-downs
 *   owner   → error   (red)     highest authority: key changes, recovery
 *   memo    → primary (blue)    specialized encryption key (exact-only)
 *
 * Pure token names — components resolve them against the theme with
 * `roleAccentColors(theme, …)` from @/components/theme (both light and dark).
 */
export type RoleAccent = "success" | "warning" | "error" | "primary";

export function roleAccent(role: KeyRole): RoleAccent {
  switch (role) {
    case "owner":
      return "error";
    case "active":
      return "warning";
    case "memo":
      return "primary";
    case "posting":
      return "success";
  }
}

/**
 * The authority a request needs.
 *
 *  - an off-chain signing request carries its own `keyType` (default posting);
 *  - a broadcast batch uses the highest authority of any operation in it
 *    (`batchAuthority`, the same rule the approval screen already displays);
 *  - anything unrecognised falls back to posting — the weakest key, which can
 *    never sign more than the request actually asked for.
 */
export function requiredKeyAuthority(
  ops?: readonly unknown[] | null,
  sign?: { keyType?: string | null } | null,
): KeyRole {
  if (sign) {
    const k = typeof sign.keyType === "string" ? sign.keyType.toLowerCase() : "";
    return isKeyRole(k) ? k : "posting";
  }
  const list = Array.isArray(ops) ? ops : [];
  const valid = list.filter(
    (o): o is [string, Record<string, unknown>] =>
      Array.isArray(o) && typeof o[0] === "string",
  );
  if (valid.length === 0) return "posting";
  try {
    return batchAuthority(valid) === "active" ? "active" : "posting";
  } catch {
    return "posting";
  }
}

/**
 * Which stored key to sign with, or null when this device cannot satisfy the
 * request.
 *
 * Exact match wins (least privilege: a posting request is signed with the
 * posting key even when the active key is present); otherwise the *weakest*
 * stored key that is still strong enough — never a weaker one.
 */
export function pickKeyAuthority(
  available: readonly KeyRole[],
  required: KeyRole,
): KeyRole | null {
  const have = new Set(available);
  if (required === "memo") return have.has("memo") ? "memo" : null;
  const ladder = (["posting", "active", "owner"] as const).filter(
    (r) => AUTHORITY_RANK[r] >= AUTHORITY_RANK[required],
  );
  return ladder.find((r) => have.has(r)) ?? null;
}

/**
 * Why the phone cannot sign this request, or null when it can. Wording is
 * shown directly on the approval screen, so it names the key to add.
 */
export function missingKeyReason(
  available: readonly KeyRole[],
  required: KeyRole,
): string | null {
  if (pickKeyAuthority(available, required) !== null) return null;
  return `This action needs your ${roleLabel(required)} key, which is not on this device yet. Add it in Accounts to continue.`;
}
