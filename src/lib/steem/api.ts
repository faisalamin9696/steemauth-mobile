/**
 * Steem JSON-RPC client (condenser_api) with node failover.
 * Uses fetch — no WebSocket/Buffer needed.
 *
 * The node list + failover behavior come from user settings
 * (Settings → Blockchain RPC): the ordered list is tried in order, and
 * with Auto-failover enabled each node gets 2 attempts before moving on.
 * Transport failures (timeout / network / 5xx / 429) fail over; consensus
 * errors from the chain never do.
 */
import { store } from '@/store';
import { DEFAULT_RPC_SERVERS } from '@/constants/rpc';

export const RPC_SERVERS = DEFAULT_RPC_SERVERS;

export const CHAIN_TIMEOUT = 8000;

export interface DynamicGlobalProperties {
  head_block_number: number;
  head_block_id: string;
  time: string;
  total_vesting_shares: string;
  total_vesting_fund_steem: string;
  total_reward_fund_steem?: string;
  current_supply: string;
  [key: string]: any;
}

export interface SteemAccount {
  id: number;
  name: string;
  balance: string;
  savings_balance: string;
  sbd_balance: string;
  savings_sbd_balance: string;
  vesting_shares: string;
  received_vesting_shares: string;
  delegated_vesting_shares: string;
  reward_steem_balance: string;
  reward_sbd_balance: string;
  reward_vesting_balance: string;
  reward_vesting_steem?: string;
  posting: Authority;
  active: Authority;
  owner: Authority;
  memo_key: string;
  voting_power: number;
  last_vote_time: string;
  reputation: number | string;
  json_metadata?: string;
  posting_json_metadata?: string;
  [key: string]: any;
}

export interface Authority {
  weight_threshold: number;
  account_auths: [string, number][];
  key_auths: [string, number][];
}

export interface TransactionConfirmation {
  id: string;
  block_num?: number;
  trx_num?: number;
  expired?: boolean;
  [key: string]: any;
}

let overrideServers: string[] | null = null;

/** Override the RPC server list programmatically (tests / advanced use). */
export function setRpcServers(servers: string[]) {
  overrideServers = servers.length ? servers : null;
}

/**
 * Effective node list: user settings (ordered — first is primary), falling
 * back to the defaults. With Auto-failover disabled only the primary node
 * is used.
 */
export function getRpcServers(): string[] {
  if (overrideServers) return overrideServers;
  const { rpcServers, autoFailover } = store.getState().settings;
  const list = rpcServers.length ? rpcServers : [...DEFAULT_RPC_SERVERS];
  return autoFailover ? list : list.slice(0, 1);
}

/** How many attempts each node gets before moving to the next one. */
export function attemptsPerServer(): number {
  return store.getState().settings.autoFailover ? 2 : 1;
}

async function rpcCall<T>(
  api: string,
  method: string,
  params: any[],
  timeoutMs = CHAIN_TIMEOUT,
): Promise<T> {
  const servers = getRpcServers();
  const attempts = attemptsPerServer();
  let lastError: unknown = null;

  for (const server of servers) {
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        const res = await fetch(server, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
          signal: controller.signal,
        });
        clearTimeout(timer);
        if (!res.ok) {
          lastError = new Error(`HTTP ${res.status} from ${server}`);
          if (res.status >= 500 || res.status === 429) continue;
          throw lastError;
        }
        const json = await res.json();
        if (json.error) {
          const message = json.error.message ?? JSON.stringify(json.error);
          const err: any = new Error(message);
          err.data = json.error.data;
          err.code = json.error.code;
          // Application-level errors come from consensus: do not fail over.
          throw err;
        }
        return json.result as T;
      } catch (error) {
        lastError = error;
        const msg = String((error as Error)?.message ?? error);
        // Fail over only on transport issues; consensus errors bubble up.
        if (!/HTTP|abort|Network|fetch|Failed/i.test(msg)) throw error;
      }
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error('Steem RPC request failed on all nodes');
}

export const steemRpc = {
  getDynamicGlobalProperties: () =>
    rpcCall<DynamicGlobalProperties>(
      'condenser_api',
      'condenser_api.get_dynamic_global_properties',
      [],
    ),

  getAccounts: (names: string[]) =>
    rpcCall<SteemAccount[]>('condenser_api', 'condenser_api.get_accounts', [
      names,
    ]),

  getAccount: async (name: string): Promise<SteemAccount | null> => {
    const accounts = await rpcCall<SteemAccount[]>(
      'condenser_api',
      'condenser_api.get_accounts',
      [[name]],
    );
    return accounts[0] ?? null;
  },

  broadcastTransaction: (tx: Record<string, any>) =>
    rpcCall<TransactionConfirmation>(
      'condenser_api',
      'condenser_api.broadcast_transaction',
      [tx],
    ),

  /**
   * Broadcast AND wait for block inclusion: returns the real
   * `{ id, block_num }` (what the receipt shows — "Included in block N").
   * Takes ~one block (~3 s) by design, hence the doubled timeout. Nodes that
   * do not expose the method throw a -32601-style error, which
   * broadcastOperations falls back on.
   */
  broadcastTransactionConfirmation: (tx: Record<string, any>) =>
    rpcCall<TransactionConfirmation>(
      'condenser_api',
      'condenser_api.broadcast_transaction_confirmation',
      [tx],
      CHAIN_TIMEOUT * 2,
    ),

  /** Get raw operations for recent history of an account. */
  getAccountHistory: (account: string, start = -1, limit = 50) =>
    rpcCall<[number, { trx_id: string; block: number; op: [string, any] }][]>(
      'condenser_api',
      'condenser_api.get_account_history',
      [account, start, limit],
    ),

  getRewardFund: (name = 'post') =>
    rpcCall<{ reward_balance: string; recent_claims: string; content_constant: string }>(
      'condenser_api',
      'condenser_api.get_reward_fund',
      [name],
    ),

  getCurrentMedianHistoryPrice: () =>
    rpcCall<{ base: string; quote: string }>(
      'condenser_api',
      'condenser_api.get_current_median_history_price',
      [],
    ),
};

/**
 * Build ref_block fields from the dynamic global properties.
 * ref_block_prefix = bytes 4..8 of head_block_id read as little-endian uint32.
 */
export function buildRefBlock(props: DynamicGlobalProperties): {
  ref_block_num: number;
  ref_block_prefix: number;
} {
  const ref_block_num = props.head_block_number & 0xffff;
  const id = props.head_block_id;
  const prefixHex = id.slice(8, 16); // bytes 4..8
  let ref_block_prefix = 0;
  for (let i = 0; i < 4; i++) {
    ref_block_prefix += parseInt(prefixHex.slice(i * 2, i * 2 + 2), 16) * Math.pow(256, i);
  }
  return { ref_block_num, ref_block_prefix };
}

/** Expiration timestamp: chain head time + offset, formatted like dsteem. */
export function buildExpiration(props: DynamicGlobalProperties, expireMs = 60_000): string {
  const t = new Date(new Date(`${props.time}Z`).getTime() + expireMs)
    .toISOString()
    .slice(0, -5);
  return t;
}

/**
 * Ping one node with get_dynamic_global_properties. Returns latency in ms,
 * or null when the node is unreachable / errored. Used by the Settings
 * screen's node health list.
 */
export async function pingRpcServer(
  server: string,
  timeoutMs = 8000,
): Promise<number | null> {
  const started = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(server, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'condenser_api.get_dynamic_global_properties',
        params: [],
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const json = await res.json();
    if (json.error) return null;
    return Date.now() - started;
  } catch {
    return null;
  }
}
