/**
 * Default Steem RPC nodes, tried in order. The first entry is the primary;
 * the rest are automatic failover targets when "Auto-failover" is enabled
 * (Settings → Blockchain RPC). Users can change the order / disable
 * failover there; the list persists in redux.
 */
export const DEFAULT_RPC_SERVERS: string[] = [
  'https://api.steemit.com',
  'https://api.steemyy.com',
  'https://api.moecki.online',
];
