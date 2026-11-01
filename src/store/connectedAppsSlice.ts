import { createSlice, type PayloadAction } from "@reduxjs/toolkit";

/**
 * A record of an app that has connected to this authenticator via a QR
 * session. Persisted so the user can review and revoke access. Revoking the
 * app that currently holds the live session tears that session down on the
 * frontend (see revokeConnectedApp in sessionManager).
 */
export interface ConnectedApp {
  /** Composite key `${app}|${url}` — the app name + its origin. */
  id: string;
  /** App display name from the QR (`payload.app`). */
  app: string;
  /** Requesting origin from the QR (`payload.url`), display only. */
  url: string;
  /** Account the app most recently transacted as. */
  account: string;
  /** Session id of the most recent connection (used to revoke the live one). */
  lastSid: string;
  /** ms epoch of the most recent connection. */
  lastConnectedAt: number;
  /** ms epoch when the user first granted access. */
  firstSeenAt: number;
}

interface ConnectedAppsState {
  apps: ConnectedApp[];
}

const initialState: ConnectedAppsState = { apps: [] };
const MAX_APPS = 50;

const connectedAppsSlice = createSlice({
  name: "connectedApps",
  initialState,
  reducers: {
    /**
     * Record (or refresh) an app connection. Called when a session reaches
     * `ready`. Keeps the list newest-first and capped.
     */
    upsertConnectedApp(
      state,
      action: PayloadAction<{
        app: string;
        url: string;
        account: string;
        sid: string;
      }>,
    ) {
      const { app, url, account, sid } = action.payload;
      const id = `${app}|${url}`;
      const now = Date.now();
      const existing = state.apps.find((a) => a.id === id);
      if (existing) {
        existing.account = account;
        existing.lastSid = sid;
        existing.lastConnectedAt = now;
      } else {
        state.apps.unshift({
          id,
          app,
          url,
          account,
          lastSid: sid,
          lastConnectedAt: now,
          firstSeenAt: now,
        });
        if (state.apps.length > MAX_APPS) state.apps.length = MAX_APPS;
      }
      // Newest-first for display.
      state.apps.sort((a, b) => b.lastConnectedAt - a.lastConnectedAt);
    },
    removeConnectedApp(state, action: PayloadAction<string>) {
      state.apps = state.apps.filter((a) => a.id !== action.payload);
    },
    clearConnectedApps(state) {
      state.apps = [];
    },
  },
});

export const { upsertConnectedApp, removeConnectedApp, clearConnectedApps } =
  connectedAppsSlice.actions;
export default connectedAppsSlice.reducer;
