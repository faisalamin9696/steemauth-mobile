/**
 * Screen-capture privacy, guarded for web.
 *
 * expo-screen-capture is native-only: on web every method rejects with
 * UnavailabilityError. All calls funnel through these helpers so web stays
 * quiet while Android (FLAG_SECURE) and iOS (app-switcher blur) stay locked
 * down.
 */
import { Platform } from "react-native";
import * as ScreenCapture from "expo-screen-capture";

const NATIVE = Platform.OS !== "web";
const APP_SWITCHER_INTENSITY = 0.8;

/** Block screenshots/recording under `key` (+ iOS app-switcher blur for the global key). */
export async function secureScreenOn(key = "global"): Promise<void> {
  if (!NATIVE) return;
  try {
    await ScreenCapture.preventScreenCaptureAsync(key);
    if (key === "global") {
      await ScreenCapture.enableAppSwitcherProtectionAsync(APP_SWITCHER_INTENSITY);
    }
  } catch {
    // Device doesn't support it (e.g. some tablets) — nothing to do.
  }
}

/** Lift the protection for `key` (and the global blur for the global key). */
export async function secureScreenOff(key = "global"): Promise<void> {
  if (!NATIVE) return;
  try {
    await ScreenCapture.allowScreenCaptureAsync(key);
    if (key === "global") {
      await ScreenCapture.disableAppSwitcherProtectionAsync();
    }
  } catch {
    // already torn down
  }
}
