import { createSlice, type PayloadAction } from "@reduxjs/toolkit";

export interface ActivityEntry {
  id: string;
  at: number;
  account: string;
  /** what was requested, e.g. "requestVote" or a human summary */
  action: string;
  app: string;
  ok: boolean;
  txId?: string;
  error?: string;
  /** true once the entry has been persisted to Supabase */
  synced?: boolean;
}

interface ActivityState {
  entries: ActivityEntry[];
}

const initialState: ActivityState = { entries: [] };
const MAX_ENTRIES = 100;

function merge(state: ActivityState, incoming: ActivityEntry[]) {
  const existing = new Set(state.entries.map((e) => e.id));
  const fresh = incoming.filter((e) => !existing.has(e.id));
  state.entries = [...fresh, ...state.entries]
    .sort((a, b) => b.at - a.at)
    .slice(0, MAX_ENTRIES);
}

const activitySlice = createSlice({
  name: "activity",
  initialState,
  reducers: {
    logActivity(state, action: PayloadAction<ActivityEntry>) {
      merge(state, [action.payload]);
    },
    /** Merge entries fetched from Supabase (dedupe by id, newest first). */
    mergeActivity(state, action: PayloadAction<ActivityEntry[]>) {
      merge(state, action.payload);
    },
    /** Mark one entry as persisted to Supabase. */
    markSynced(state, action: PayloadAction<string>) {
      const entry = state.entries.find((e) => e.id === action.payload);
      if (entry) entry.synced = true;
    },
    /**
     * Drop entries for one account - the common case: the active user clears
     * exactly what the Activity screen showed them. No payload clears all.
     */
    clearActivity(state, action: PayloadAction<string | undefined>) {
      const account = action.payload;
      state.entries = account
        ? state.entries.filter((e) => e.account !== account)
        : [];
    },
  },
});

export const { logActivity, mergeActivity, markSynced, clearActivity } =
  activitySlice.actions;
export default activitySlice.reducer;
