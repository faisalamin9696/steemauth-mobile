import * as Haptics from "expo-haptics";
import { store } from "@/store";

function enabled(): boolean {
  try {
    return store.getState().settings.hapticsEnabled;
  } catch {
    return true;
  }
}

/** Light tick — PIN key presses, tab changes. */
export async function hapticLight(): Promise<void> {
  if (!enabled()) return;
  try {
    await Haptics.selectionAsync();
  } catch {
    // haptics are best-effort
  }
}

/** Medium impact — scan detected, buttons. */
export async function hapticMedium(): Promise<void> {
  if (!enabled()) return;
  try {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
  } catch {
    // ignore
  }
}

/** Success — approved & broadcast. */
export async function hapticSuccess(): Promise<void> {
  if (!enabled()) return;
  try {
    await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  } catch {
    // ignore
  }
}

/** Error — rejected / failed / wrong PIN. */
export async function hapticError(): Promise<void> {
  if (!enabled()) return;
  try {
    await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
  } catch {
    // ignore
  }
}
