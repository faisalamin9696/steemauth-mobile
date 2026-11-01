import { createSlice, type PayloadAction } from "@reduxjs/toolkit";
import { Platform } from "react-native";
import { DEFAULT_RPC_SERVERS } from "@/constants/rpc";

interface SettingsState {
  biometricsEnabled: boolean;
  lockOnBackground: boolean;
  hapticsEnabled: boolean;
  /** incremented by "Lock now"; LockGate watches it and locks immediately */
  lockNonce: number;
  /** Ordered RPC node list — first entry is the primary node */
  rpcServers: string[];
  /** Try the next node automatically on transport failures (default on) */
  autoFailover: boolean;
  /**
   * Load account portraits from steemitimages.com (DEFAULT OFF — consent).
   * Each fetch discloses which accounts this device renders, the device IP
   * and the timing to a third party; OFF renders the local letter tile and
   * performs no image network request (confirmed disclosure finding).
   */
  remoteAvatarsEnabled: boolean;
}

const initialState: SettingsState = {
  // Biometric unlock is ON by default on mobile devices (web has no biometric
  // hardware — the flag is inert there). Stored values from older installs
  // are flipped once by the settings migrate in store/index.ts.
  biometricsEnabled: Platform.OS !== "web",
  // OFF by default: auto-lock on backgrounding is available in Settings but
  // is not the out-of-the-box behaviour (stored values from older installs
  // are flipped once by the settings migrate in store/index.ts).
  lockOnBackground: false,
  hapticsEnabled: true,
  lockNonce: 0,
  rpcServers: [...DEFAULT_RPC_SERVERS],
  autoFailover: true,
  // OFF by default: remote image fetches are a third-party disclosure
  // (account set + IP + timing to steemitimages.com) and need consent.
  remoteAvatarsEnabled: false,
};

const settingsSlice = createSlice({
  name: "settings",
  initialState,
  reducers: {
    setBiometricsEnabled(state, action: PayloadAction<boolean>) {
      state.biometricsEnabled = action.payload;
    },
    setLockOnBackground(state, action: PayloadAction<boolean>) {
      state.lockOnBackground = action.payload;
    },
    setHapticsEnabled(state, action: PayloadAction<boolean>) {
      state.hapticsEnabled = action.payload;
    },
    /** Ask the LockGate to lock the app right now. */
    requestLock(state) {
      state.lockNonce += 1;
    },
    setAutoFailover(state, action: PayloadAction<boolean>) {
      state.autoFailover = action.payload;
    },
    setRemoteAvatarsEnabled(state, action: PayloadAction<boolean>) {
      state.remoteAvatarsEnabled = action.payload;
    },
    /** Replace the whole ordered node list. */
    setRpcServers(state, action: PayloadAction<string[]>) {
      state.rpcServers = action.payload.length
        ? action.payload
        : [...DEFAULT_RPC_SERVERS];
    },
    /** Move a node to the top (make it the primary). */
    setPrimaryRpcServer(state, action: PayloadAction<string>) {
      const rest = state.rpcServers.filter((s) => s !== action.payload);
      state.rpcServers = [action.payload, ...rest];
    },
    /** Remove a node from the rotation (never removes the last one). */
    removeRpcServer(state, action: PayloadAction<string>) {
      if (state.rpcServers.length <= 1) return;
      state.rpcServers = state.rpcServers.filter((s) => s !== action.payload);
    },
    /** Add a node to the end of the rotation. */
    addRpcServer(state, action: PayloadAction<string>) {
      const url = action.payload.trim().replace(/\/$/, "");
      if (!/^https?:\/\//.test(url) || state.rpcServers.includes(url)) return;
      state.rpcServers.push(url);
    },
    /** Restore the shipped defaults. */
    resetRpcServers(state) {
      state.rpcServers = [...DEFAULT_RPC_SERVERS];
      state.autoFailover = true;
    },
  },
});

export const {
  setBiometricsEnabled,
  setLockOnBackground,
  setHapticsEnabled,
  requestLock,
  setAutoFailover,
  setRemoteAvatarsEnabled,
  setRpcServers,
  setPrimaryRpcServer,
  removeRpcServer,
  addRpcServer,
  resetRpcServers,
} = settingsSlice.actions;
export default settingsSlice.reducer;
