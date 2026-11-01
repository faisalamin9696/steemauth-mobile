/**
 * Cross-platform secure storage.
 *
 * On native (iOS/Android) this is expo-secure-store (Keychain / Keystore).
 * On web the native module is an empty stub (`export default {}`), so we
 * fall back to localStorage. The web fallback is for development/preview
 * only — real deployments should run the mobile app.
 */
import { Platform } from "react-native";
import * as SecureStore from "expo-secure-store";

const WEB_PREFIX = "steemauth:";

type SetOptions = SecureStore.SecureStoreOptions;

function webGet(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(WEB_PREFIX + key) ?? null;
  } catch {
    return null;
  }
}

function webSet(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(WEB_PREFIX + key, value);
  } catch {
    // quota / private mode — ignore
  }
}

function webDelete(key: string): void {
  try {
    globalThis.localStorage?.removeItem(WEB_PREFIX + key);
  } catch {
    // ignore
  }
}

export async function getItem(key: string): Promise<string | null> {
  if (Platform.OS === "web") return webGet(key);
  return SecureStore.getItemAsync(key);
}

export async function setItem(
  key: string,
  value: string,
  options?: SetOptions,
): Promise<void> {
  if (Platform.OS === "web") {
    webSet(key, value);
    return;
  }
  await SecureStore.setItemAsync(key, value, options);
}

export async function deleteItem(key: string): Promise<void> {
  if (Platform.OS === "web") {
    webDelete(key);
    return;
  }
  await SecureStore.deleteItemAsync(key);
}
