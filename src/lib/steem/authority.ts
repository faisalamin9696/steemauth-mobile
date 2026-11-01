/**
 * Required key authority per operation — PURE module (no RPC, no store, no
 * React Native imports) so tooling can import the validation stack directly:
 * the steemauth-qr test harness cross-checks these rules against the
 * frontend package on every run.
 */

export type KeyAuthority = 'posting' | 'active';

const POSTING_OPERATIONS = new Set([
  'vote',
  'comment',
  'custom_json',
  'delete_comment',
  'claim_reward_balance',
  'account_update2',
]);

/**
 * `custom_json` may require either posting (community/follow ops stored in
 * required_posting_auths) or active (required_auths) — decide from payload.
 */
export function getRequiredAuthority(
  operation: [string, Record<string, unknown>],
): KeyAuthority {
  const [type, params] = operation;
  if (type === 'custom_json') {
    const activeAuths: unknown[] = (params as { required_auths?: unknown[] })
      ?.required_auths ?? [];
    return activeAuths.length > 0 ? 'active' : 'posting';
  }
  if (type === 'account_update') return 'active';
  return POSTING_OPERATIONS.has(type) ? 'posting' : 'active';
}

/** Highest authority required across a batch of operations. */
export function batchAuthority(
  operations: readonly [string, Record<string, unknown>][],
): KeyAuthority {
  return operations.some((op) => getRequiredAuthority(op) === 'active')
    ? 'active'
    : 'posting';
}

const AUTHORITY_RANK: Record<string, number> = {
  unknown: 0,
  memo: 0,
  posting: 1,
  active: 2,
  owner: 3,
};

/** True when `held` can satisfy a `required` authority. */
export function authoritySatisfies(
  held: string,
  required: KeyAuthority,
): boolean {
  return (AUTHORITY_RANK[held] ?? 0) >= AUTHORITY_RANK[required];
}
