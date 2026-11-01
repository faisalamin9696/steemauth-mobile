import { AppState } from "react-native";
import * as LocalAuthentication from "expo-local-authentication";
import { hasPin, setPin as vaultSetPin } from "@/lib/vault";
import { store } from "@/store";

let pinCreated = false;

/** Create the app PIN if it does not exist yet (first-run flow). */
export async function ensurePinExists(existingPin?: string): Promise<void> {
  if (pinCreated || (await hasPin())) {
    pinCreated = true;
    return;
  }
  if (existingPin) {
    await vaultSetPin(existingPin);
    pinCreated = true;
  }
}

export async function isBiometricAvailable(): Promise<boolean> {
  const status = await biometricStatus();
  return status.available;
}

/** Detailed biometric capability check (with a human-readable reason). */
export async function biometricStatus(): Promise<{
  available: boolean;
  reason?: string;
}> {
  try {
    const hasHardware = await LocalAuthentication.hasHardwareAsync();
    if (!hasHardware) return { available: false, reason: "No biometric hardware on this device." };
    const enrolled = await LocalAuthentication.isEnrolledAsync();
    if (!enrolled)
      return {
        available: false,
        reason: "No fingerprint or Face ID enrolled in device settings.",
      };
    return { available: true };
  } catch {
    return { available: false, reason: "Biometric check failed." };
  }
}

/** Run a biometric prompt. Returns true when the user authenticated. */
export async function biometricGate(promptMessage: string): Promise<boolean> {
  try {
    const result = await LocalAuthentication.authenticateAsync({
      promptMessage,
      disableDeviceFallback: false,
    });
    return result.success;
  } catch {
    return false;
  }
}

/** Attempt a silent (prompted) biometric unlock. */
export async function unlockWithBiometrics(username: string): Promise<boolean> {
  return biometricGate(`Unlock @${username}`);
}

/** Watchdog hook for app-state locking (wired from the root layout). */
export function registerAppLock(onLock: () => void): () => void {
  const sub = AppState.addEventListener("change", (state) => {
    if (state === "background" && store.getState().settings.lockOnBackground) {
      onLock();
    }
  });
  return () => sub.remove();
}
