import { createSlice, type PayloadAction } from "@reduxjs/toolkit";
import { isKeyRole, ROLE_DISPLAY_ORDER, type KeyRole } from "@/lib/keyRouting";

export type { KeyRole };

/**
 * One account as it appears in the app: metadata for the card + the public
 * key of every authority imported for it. The private keys themselves live
 * in the secure vault (`lib/vault.ts`), never here.
 *
 * `publicKey` / `role` / `encryptedWif` are the legacy single-key fields.
 * Older builds (and their persisted state) only ever held one key, so reads
 * must go through `accountKeys()` — it normalizes a record that has no
 * `keys` map into `{ [role]: publicKey }` instead of requiring a migration
 * pass over the persisted store.
 */
export interface StoredAccount {
  username: string;
  /** Public key of the primary key (first one imported) — legacy field. */
  publicKey: string;
  /** AES-encrypted WIF of the primary key — legacy field, kept for parity. */
  encryptedWif: string;
  /** Primary role (first key imported) — legacy field. */
  role: KeyRole;
  /** authority → public key, for every key imported on this device. */
  keys?: Partial<Record<KeyRole, string>>;
  createdAt: number;
  updatedAt: number;
}

/** Public keys held for this account (legacy records normalized). */
export function accountKeys(account: StoredAccount): Partial<Record<KeyRole, string>> {
  const keys = account.keys;
  if (keys && Object.keys(keys).length > 0) return keys;
  const role: KeyRole = isKeyRole(account.role) ? account.role : "posting";
  return { [role]: account.publicKey };
}

/** Roles this account holds, strongest first — the order chips render in. */
export function importedRoles(account: StoredAccount): KeyRole[] {
  const keys = accountKeys(account);
  return ROLE_DISPLAY_ORDER.filter((role) => Boolean(keys[role]));
}

interface AccountsState {
  accounts: StoredAccount[];
  activeUsername: string | null;
}

const initialState: AccountsState = {
  accounts: [],
  activeUsername: null,
};

const accountsSlice = createSlice({
  name: "accounts",
  initialState,
  reducers: {
    upsertAccount(state, action: PayloadAction<StoredAccount>) {
      const next = action.payload;
      const idx = state.accounts.findIndex(
        (a) => a.username.toLowerCase() === next.username.toLowerCase(),
      );
      if (idx >= 0) {
        // Re-importing one key must not forget the others the user already
        // added for this account.
        const existing = state.accounts[idx]!;
        const keys = { ...accountKeys(existing), ...accountKeys(next) };
        // Keep the legacy primary pointing at the LOGIN key (posting) when the
        // account holds it — a master-password import writes four keys in a
        // row, and without this rule the headline pubkey would end up being
        // whichever one finished last (memo).
        const primary: KeyRole = keys.posting
          ? "posting"
          : keys[existing.role]
            ? existing.role
            : ((Object.keys(keys)[0] as KeyRole | undefined) ?? next.role);
        state.accounts[idx] = {
          ...next,
          keys,
          role: primary,
          publicKey: keys[primary] ?? next.publicKey,
          encryptedWif:
            next.role === primary ? next.encryptedWif : existing.encryptedWif,
          createdAt: existing.createdAt,
        };
      } else {
        const keys = accountKeys(next);
        const primary: KeyRole = keys.posting ? "posting" : next.role;
        state.accounts.push({
          ...next,
          keys,
          role: primary,
          publicKey: keys[primary] ?? next.publicKey,
        });
      }
      if (!state.activeUsername) state.activeUsername = next.username;
    },
    /**
     * Record an additional (or replaced) key for an existing account — the
     * "add the active key" path opened from the account card.
     */
    upsertAccountKey(
      state,
      action: PayloadAction<{
        username: string;
        authority: KeyRole;
        publicKey: string;
        /** encrypted WIF, only supplied when this is the account's first key */
        encryptedWif?: string;
      }>,
    ) {
      const { username, authority, publicKey, encryptedWif } = action.payload;
      const idx = state.accounts.findIndex(
        (a) => a.username.toLowerCase() === username.toLowerCase(),
      );
      if (idx < 0) return; // account was removed while the dialog was open
      const account = state.accounts[idx]!;
      const keys = { ...accountKeys(account) };
      const wasEmpty = Object.keys(keys).length === 0;
      keys[authority] = publicKey;
      state.accounts[idx] = {
        ...account,
        keys,
        // First key ever → it becomes the primary (legacy) reference.
        publicKey: wasEmpty ? publicKey : account.publicKey,
        role: wasEmpty ? authority : account.role,
        encryptedWif: wasEmpty && encryptedWif ? encryptedWif : account.encryptedWif,
        updatedAt: Date.now(),
      };
    },
    removeAccount(state, action: PayloadAction<string>) {
      const username = action.payload;
      state.accounts = state.accounts.filter(
        (a) => a.username.toLowerCase() !== username.toLowerCase(),
      );
      if (state.activeUsername?.toLowerCase() === username.toLowerCase()) {
        state.activeUsername = state.accounts[0]?.username ?? null;
      }
    },
    setActiveAccount(state, action: PayloadAction<string>) {
      state.activeUsername = action.payload;
    },
    clearAccounts(state) {
      state.accounts = [];
      state.activeUsername = null;
    },
  },
});

export const {
  upsertAccount,
  upsertAccountKey,
  removeAccount,
  setActiveAccount,
  clearAccounts,
} = accountsSlice.actions;
export default accountsSlice.reducer;
