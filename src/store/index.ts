import { configureStore } from "@reduxjs/toolkit";
import {
  persistStore,
  persistReducer,
  FLUSH,
  REHYDRATE,
  PAUSE,
  PERSIST,
  PURGE,
  REGISTER,
} from "redux-persist";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Platform } from "react-native";
import accountsReducer from "./accountsSlice";
import sessionReducer from "./sessionSlice";
import settingsReducer from "./settingsSlice";
import activityReducer from "./activitySlice";
import connectedAppsReducer from "./connectedAppsSlice";
import blockedOriginsReducer from "./blockedOriginsSlice";

const persistedAccounts = persistReducer(
  { key: "steemauth:accounts", storage: AsyncStorage },
  accountsReducer,
);

const persistedSettings = persistReducer(
  {
    key: "steemauth:settings",
    storage: AsyncStorage,
    // v1 migration (runs once, on the version change):
    //   - biometrics default ON on mobile (lifts installs that never touched
    //     the toggle; anything chosen afterwards is preserved)
    //   - background lock default OFF (same one-time lift)
    version: 1,
    migrate: async (state) => {
      const s = state as { biometricsEnabled?: boolean; lockOnBackground?: boolean } | undefined;
      if (!s || typeof s !== "object") return state;
      if (Platform.OS !== "web") {
        if (s.biometricsEnabled === false) s.biometricsEnabled = true;
      }
      if (s.lockOnBackground === true) s.lockOnBackground = false;
      return state;
    },
  },
  settingsReducer,
);

const persistedActivity = persistReducer(
  { key: "steemauth:activity", storage: AsyncStorage },
  activityReducer,
);

const persistedConnectedApps = persistReducer(
  { key: "steemauth:connectedApps", storage: AsyncStorage },
  connectedAppsReducer,
);

// A blocklist that forgot itself on restart would not be a blocklist.
const persistedBlockedOrigins = persistReducer(
  { key: "steemauth:blockedOrigins", storage: AsyncStorage },
  blockedOriginsReducer,
);

export const store = configureStore({
  reducer: {
    accounts: persistedAccounts,
    // Session state is intentionally NOT persisted.
    session: sessionReducer,
    settings: persistedSettings,
    activity: persistedActivity,
    connectedApps: persistedConnectedApps,
    blockedOrigins: persistedBlockedOrigins,
  },
  middleware: (getDefaultMiddleware) =>
    getDefaultMiddleware({
      serializableCheck: {
        ignoredActions: [FLUSH, REHYDRATE, PAUSE, PERSIST, PURGE, REGISTER],
      },
    }),
});

export const persistor = persistStore(store);

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;

// Dev-only escape hatch: the web console can drive the state machine (e.g.
// dispatch `session/enqueueRequest` to see how the Approvals tab renders a
// waiting request) without a camera or a second device. __DEV__ is false in
// production bundles, so this never ships.
if (__DEV__) {
  (globalThis as { __steemauthStore?: typeof store }).__steemauthStore =
    store;
}
