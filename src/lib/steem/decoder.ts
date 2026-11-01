/**
 * Decode + validate operation payloads for the approval screen.
 *
 * Every request coming from a frontend app is untrusted input: this module
 * turns it into something a human can actually audit before signing, and
 * rejects anything malformed or unsupported.
 */
import { Operation, SUPPORTED_OPERATIONS } from './serializer';
import { batchAuthority, getRequiredAuthority, KeyAuthority } from './authority';

export interface DecodedField {
  label: string;
  value: string;
  /** Visual emphasis: amounts and destinations should pop. */
  emphasis?: boolean;
  /** Render as a warning (e.g. active authority, large transfer). */
  warning?: boolean;
}

export interface DecodedOperation {
  type: string;
  /** Short human title, e.g. "Upvote", "Transfer", "Publish post". */
  title: string;
  summary: string;
  fields: DecodedField[];
  authority: KeyAuthority;
  /** Account names referenced by the operation (for account filtering). */
  accounts: string[];
  /** True when the payload moves funds or changes keys — extra scrutiny. */
  sensitive: boolean;
}

const ACCOUNT_NAME_RE = /^[a-z][a-z0-9.-]{2,31}$/;

export function isValidAccountName(name: unknown): name is string {
  return typeof name === 'string' && ACCOUNT_NAME_RE.test(name);
}

const OPERATION_TITLES: Record<string, string> = {
  vote: 'Vote',
  comment: 'Publish content',
  delete_comment: 'Delete content',
  transfer: 'Transfer',
  transfer_to_vesting: 'Power up',
  transfer_to_savings: 'Deposit to savings',
  transfer_from_savings: 'Withdraw from savings',
  cancel_transfer_from_savings: 'Cancel savings withdrawal',
  withdraw_vesting: 'Power down',
  delegate_vesting_shares: 'Delegate SP',
  claim_reward_balance: 'Claim rewards',
  custom_json: 'Custom JSON',
  custom: 'Custom data',
  custom_binary: 'Custom binary',
  account_update: 'Update account',
  account_update2: 'Update profile',
  account_witness_vote: 'Vote for witness',
  account_witness_proxy: 'Set witness proxy',
  set_withdraw_vesting_route: 'Set reward route',
  limit_order_create: 'Create market order',
  limit_order_cancel: 'Cancel market order',
  limit_order_create2: 'Create market order',
  convert: 'Convert SBD',
  collateralized_convert: 'Convert SBD (collateralized)',
  feed_publish: 'Publish price feed',
  witness_update: 'Update witness',
  claim_account: 'Claim free account',
  create_claimed_account: 'Create account',
  account_create: 'Create account',
  change_recovery_account: 'Change recovery account',
  request_account_recovery: 'Request account recovery',
  recover_account: 'Recover account',
  decline_voting_rights: 'Decline voting rights',
  update_proposal_votes: 'Vote on proposal',
  remove_proposal: 'Remove proposal',
  recurrent_transfer: 'Recurring transfer',
  escrow_transfer: 'Escrow transfer',
  escrow_approve: 'Escrow approval',
  escrow_dispute: 'Escrow dispute',
  escrow_release: 'Escrow release',
};

function account(value: any): string {
  return isValidAccountName(value) ? value : String(value ?? '');
}

function amount(value: any): string {
  return String(value ?? '').trim();
}

const SENSITIVE_TYPES = new Set([
  'transfer',
  'transfer_to_savings',
  'transfer_from_savings',
  'recurrent_transfer',
  'withdraw_vesting',
  'delegate_vesting_shares',
  'account_update',
  'account_update2',
  'change_recovery_account',
  'request_account_recovery',
  'recover_account',
  'custom',
  'custom_binary',
  'escrow_transfer',
]);

/**
 * Parse and describe a single operation. Throws for unsupported or
 * malformed operations — never silently accepts what we cannot display.
 */
export function decodeOperation(op: any): DecodedOperation {
  if (!Array.isArray(op) || op.length !== 2 || typeof op[0] !== 'string') {
    throw new Error('Invalid operation: expected [name, params]');
  }
  const [type, raw] = op;
  if (!SUPPORTED_OPERATIONS.includes(type)) {
    throw new Error(`Unsupported operation: ${type}`);
  }
  const params = raw && typeof raw === 'object' ? raw : {};
  const authority = getRequiredAuthority([type, params] as Operation);
  const title = OPERATION_TITLES[type] ?? type;
  const fields: DecodedField[] = [];
  const accounts = new Set<string>();
  let summary = title;

  const add = (label: string, value: string, opts: Partial<DecodedField> = {}) => {
    fields.push({ label, value, ...opts });
  };

  switch (type) {
    case 'vote': {
      accounts.add(account(params.voter));
      summary = `${Math.round((Number(params.weight) || 0) / 100)}% vote on @${params.author}/${params.permlink}`;
      add('Voter', `@${account(params.voter)}`, { emphasis: true });
      add('Post', `@${params.author}/${params.permlink}`);
      add('Weight', `${Math.round((Number(params.weight) || 0) / 100)}%`);
      break;
    }
    case 'comment': {
      accounts.add(account(params.author));
      const isPost = !params.parent_author;
      summary = isPost
        ? `Publish "${String(params.title || params.permlink || '').slice(0, 60)}"`
        : `Reply to @${params.parent_author}/${params.parent_permlink}`;
      add('Author', `@${account(params.author)}`, { emphasis: true });
      if (isPost) add('Title', String(params.title || '(untitled)'));
      else
        add(
          'In reply to',
          `@${params.parent_author}/${params.parent_permlink}`,
        );
      add('Permlink', String(params.permlink ?? ''));
      add('Body length', `${String(params.body ?? '').length} chars`);
      if (authority === 'active') add('Authority', 'Active', { warning: true });
      break;
    }
    case 'delete_comment': {
      accounts.add(account(params.author));
      summary = `Delete @${params.author}/${params.permlink}`;
      add('Author', `@${account(params.author)}`, { emphasis: true });
      add('Permlink', String(params.permlink ?? ''));
      break;
    }
    case 'transfer':
    case 'transfer_to_savings': {
      accounts.add(account(params.from));
      accounts.add(account(params.to));
      summary = `${amount(params.amount)} to @${params.to}`;
      add('From', `@${account(params.from)}`, { emphasis: true });
      add('To', `@${account(params.to)}`, { emphasis: true });
      add('Amount', amount(params.amount), { emphasis: true });
      if (params.memo) add('Memo', String(params.memo));
      if (authority === 'active') add('Key', 'Active key required', { warning: true });
      break;
    }
    case 'recurrent_transfer': {
      accounts.add(account(params.from));
      accounts.add(account(params.to));
      summary = `${amount(params.amount)} to @${params.to} every ${params.recurrence} days`;
      add('From', `@${account(params.from)}`, { emphasis: true });
      add('To', `@${account(params.to)}`, { emphasis: true });
      add('Amount', amount(params.amount), { emphasis: true });
      add('Repeats', `every ${params.recurrence} days × ${params.executions}`);
      add('Key', 'Active key required', { warning: true });
      break;
    }
    case 'transfer_from_savings': {
      accounts.add(account(params.from));
      accounts.add(account(params.to));
      summary = `${amount(params.amount)} from savings to @${params.to}`;
      add('From', `@${account(params.from)}`, { emphasis: true });
      add('To', `@${account(params.to)}`, { emphasis: true });
      add('Amount', amount(params.amount), { emphasis: true });
      add('Request id', String(params.request_id));
      add('Key', 'Active key required', { warning: true });
      break;
    }
    case 'cancel_transfer_from_savings': {
      accounts.add(account(params.from));
      summary = `Cancel savings withdrawal #${params.request_id}`;
      add('Account', `@${account(params.from)}`);
      add('Request id', String(params.request_id));
      break;
    }
    case 'transfer_to_vesting': {
      accounts.add(account(params.from));
      accounts.add(account(params.to));
      summary = `${amount(params.amount)} → @${params.to}`;
      add('From', `@${account(params.from)}`, { emphasis: true });
      add('To', `@${account(params.to)}`, { emphasis: true });
      add('Amount', amount(params.amount), { emphasis: true });
      add('Key', 'Active key required', { warning: true });
      break;
    }
    case 'withdraw_vesting': {
      accounts.add(account(params.account));
      summary = `Power down ${amount(params.vesting_shares)}`;
      add('Account', `@${account(params.account)}`, { emphasis: true });
      add('Amount', `${amount(params.vesting_shares)} (VESTS)`, { emphasis: true });
      add('Key', 'Active key required', { warning: true });
      break;
    }
    case 'delegate_vesting_shares': {
      accounts.add(account(params.delegator));
      accounts.add(account(params.delegatee));
      summary = `${amount(params.vesting_shares)} VESTS → @${params.delegatee}`;
      add('Delegator', `@${account(params.delegator)}`, { emphasis: true });
      add('Delegatee', `@${account(params.delegatee)}`, { emphasis: true });
      add('Amount', `${amount(params.vesting_shares)} (VESTS)`, { emphasis: true });
      add('Key', 'Active key required', { warning: true });
      break;
    }
    case 'claim_reward_balance': {
      accounts.add(account(params.account));
      const parts = [
        amount(params.reward_steem),
        amount(params.reward_sbd),
        amount(params.reward_vests),
      ].filter((p) => p && !/^0(\.0+)?\s/.test(p));
      summary = parts.length ? parts.join(', ') : 'unclaimed rewards';
      add('Account', `@${account(params.account)}`, { emphasis: true });
      add('Rewards', summary, { emphasis: true });
      break;
    }
    case 'custom_json': {
      const activeAuths: string[] = Array.isArray(params.required_auths)
        ? params.required_auths
        : [];
      const postingAuths: string[] = Array.isArray(params.required_posting_auths)
        ? params.required_posting_auths
        : [];
      activeAuths.forEach((a) => accounts.add(account(a)));
      postingAuths.forEach((a) => accounts.add(account(a)));
      const id = String(params.id ?? '');
      const json = String(params.json ?? '');
      summary = `id: "${id}"`;
      add('JSON id', id, { emphasis: true });
      add(
        'Signed by',
        [
          ...activeAuths.map((a) => `@${a} (active)`),
          ...postingAuths.map((a) => `@${a} (posting)`),
        ].join(', ') || '(none)',
        { warning: authority === 'active' },
      );
      add('Payload', json.length > 300 ? `${json.slice(0, 300)}…` : json);
      break;
    }
    case 'custom': {
      const auths: string[] = Array.isArray(params.required_auths)
        ? params.required_auths
        : [];
      auths.forEach((a) => accounts.add(account(a)));
      summary = `binary data (id ${params.id})`;
      add('Required auths', auths.map((a) => `@${a}`).join(', ') || '(none)', {
        warning: true,
      });
      add('Data', `${String(params.data ?? '').length} bytes`);
      break;
    }
    case 'account_update':
    case 'account_update2': {
      accounts.add(account(params.account));
      const changed: string[] = [];
      for (const k of ['owner', 'active', 'posting'] as const) {
        if (params[k]) changed.push(k);
      }
      summary = changed.length
        ? `Change ${changed.join(' + ')} authority`
        : 'Update profile metadata';
      add('Account', `@${account(params.account)}`, { emphasis: true });
      add('Changes', changed.length ? changed.join(', ') : 'json metadata only');
      if (changed.includes('owner') || changed.includes('active')) {
        add('WARNING', 'This can change key authorities — verify carefully', {
          warning: true,
        });
      }
      add('Key', 'Active key required', { warning: true });
      break;
    }
    case 'account_witness_vote': {
      accounts.add(account(params.account));
      accounts.add(account(params.witness));
      summary = `${params.approve ? 'Vote for' : 'Remove vote for'} @${params.witness}`;
      add('Account', `@${account(params.account)}`);
      add('Witness', `@${account(params.witness)}`, { emphasis: true });
      add('Key', 'Active key required', { warning: true });
      break;
    }
    case 'account_witness_proxy': {
      accounts.add(account(params.account));
      accounts.add(account(params.proxy));
      summary = params.proxy ? `Proxy to @${params.proxy}` : 'Remove proxy';
      add('Account', `@${account(params.account)}`);
      add('Proxy', params.proxy ? `@${account(params.proxy)}` : '(none)', {
        emphasis: true,
      });
      add('Key', 'Active key required', { warning: true });
      break;
    }
    case 'set_withdraw_vesting_route': {
      accounts.add(account(params.from_account));
      accounts.add(account(params.to_account));
      summary = `${params.percent}% → @${params.to_account}`;
      add('From', `@${account(params.from_account)}`);
      add('To', `@${account(params.to_account)}`, { emphasis: true });
      add('Percent', `${params.percent}%`);
      add('Auto vest', params.auto_vest ? 'yes' : 'no');
      add('Key', 'Active key required', { warning: true });
      break;
    }
    case 'limit_order_create':
    case 'limit_order_create2': {
      accounts.add(account(params.owner));
      summary = `Sell ${amount(params.amount_to_sell)} for ${amount(
        params.min_to_receive ?? params.exchange_rate?.base,
      )}`;
      add('Owner', `@${account(params.owner)}`);
      add('Sell', amount(params.amount_to_sell), { emphasis: true });
      add(
        'Receive',
        amount(params.min_to_receive ?? params.exchange_rate?.base),
        { emphasis: true },
      );
      add('Order id', String(params.orderid));
      add('Key', 'Active key required', { warning: true });
      break;
    }
    case 'limit_order_cancel': {
      accounts.add(account(params.owner));
      summary = `Cancel order #${params.orderid}`;
      add('Owner', `@${account(params.owner)}`);
      add('Order id', String(params.orderid));
      break;
    }
    case 'convert':
    case 'collateralized_convert': {
      accounts.add(account(params.owner));
      summary = `Convert ${amount(params.amount)}`;
      add('Account', `@${account(params.owner)}`);
      add('Amount', amount(params.amount), { emphasis: true });
      add('Key', 'Active key required', { warning: true });
      break;
    }
    case 'change_recovery_account': {
      accounts.add(account(params.account_to_recover));
      accounts.add(account(params.new_recovery_account));
      summary = `Recovery → @${params.new_recovery_account}`;
      add('Account', `@${account(params.account_to_recover)}`);
      add('New recovery', `@${account(params.new_recovery_account)}`, {
        emphasis: true,
      });
      add('Key', 'Active key required', { warning: true });
      break;
    }
    case 'decline_voting_rights': {
      accounts.add(account(params.account));
      summary = params.decline ? 'Decline voting rights' : 'Restore voting rights';
      add('Account', `@${account(params.account)}`, { emphasis: true });
      add('Key', 'Active key required', { warning: true });
      break;
    }
    case 'witness_update': {
      accounts.add(account(params.owner));
      summary = `Update witness @${params.owner}`;
      add('Witness', `@${account(params.owner)}`);
      add('URL', String(params.url ?? ''));
      add('Fee', amount(params.fee));
      add('Key', 'Active key required', { warning: true });
      break;
    }
    default: {
      // Generic fallback: still show every param so nothing is hidden.
      for (const [k, v] of Object.entries(params)) {
        const vStr = typeof v === 'object' ? JSON.stringify(v) : String(v);
        if (ACCOUNT_NAME_RE.test(vStr)) accounts.add(vStr);
        add(k.replace(/_/g, ' '), vStr.length > 200 ? `${vStr.slice(0, 200)}…` : vStr);
      }
      // Account names inside array params (e.g. custom_binary's
      // required_owner/active/posting_auths lists).
      for (const v of Object.values(params)) {
        if (Array.isArray(v)) {
          for (const item of v) {
            if (isValidAccountName(item)) accounts.add(item);
          }
        }
      }
      if (authority === 'active') add('Key', 'Active key required', { warning: true });
      break;
    }
  }

  return {
    type,
    title,
    summary,
    fields,
    authority,
    accounts: [...accounts],
    sensitive: SENSITIVE_TYPES.has(type),
  };
}

export interface BatchValidation {
  ok: boolean;
  error?: string;
  decoded: DecodedOperation[];
  authority: KeyAuthority;
}

/**
 * Validate + decode an operation batch received from a frontend app.
 *
 * Rules:
 *  - must be a non-empty array of [name, params]
 *  - every operation must be serializable by this build
 *  - required authority computed for the whole batch
 *  - if `expectedAccount` is given, at least one operation must reference it
 *    (so an app can't ask your key to act for someone else)
 */
export function validateOperationBatch(
  ops: unknown,
  options: { expectedAccount?: string } = {},
): BatchValidation {
  const decoded: DecodedOperation[] = [];
  if (!Array.isArray(ops) || ops.length === 0) {
    return { ok: false, error: 'Request contains no operations', decoded, authority: 'posting' };
  }
  if (ops.length > 20) {
    return { ok: false, error: 'Too many operations in one request (max 20)', decoded, authority: 'posting' };
  }
  for (const op of ops) {
    try {
      decoded.push(decodeOperation(op));
    } catch (error: any) {
      return { ok: false, error: error.message ?? 'Invalid operation', decoded, authority: 'posting' };
    }
  }
  const authority = batchAuthority(ops as Operation[]);

  if (options.expectedAccount) {
    const referenced = decoded.some((d) =>
      d.accounts.includes(options.expectedAccount as string),
    );
    if (!referenced) {
      return {
        ok: false,
        error: `Operations do not involve @${options.expectedAccount}`,
        decoded,
        authority,
      };
    }
  }

  return { ok: true, decoded, authority };
}
