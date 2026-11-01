import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, Image, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import { Button, Text, useTheme } from "react-native-paper";
import { Fingerprint, LockKeyhole } from "lucide-react-native";
import { useAppSelector } from "@/store/hooks";
import { PinGate } from "./PinGate";
import { paletteFor, systemClearance } from "./theme";
import {
  biometricStatus,
  biometricGate,
  isBiometricAvailable,
} from "@/lib/secure";
import { hasPin } from "@/lib/vault";
import { secureScreenOn, secureScreenOff } from "@/lib/screenPrivacy";
import { hapticError, hapticLight, hapticSuccess } from "@/lib/haptics";

/**
 * App lock overlay:
 *  - locks on cold start whenever any account is stored (secure by default)
 *  - re-locks when returning from background (if enabled in Settings)
 *  - blocks screenshots / screen recording while visible
 *  - supports biometric quick-unlock when enabled
 */
export function LockGate({ children }: { children: React.ReactNode }) {
  const theme = useTheme();
  const palette = paletteFor(theme);
  const accounts = useAppSelector((s) => s.accounts.accounts);
  const lockOnBackground = useAppSelector((s) => s.settings.lockOnBackground);
  const lockNonce = useAppSelector((s) => s.settings.lockNonce);
  const insets = useSafeAreaInsets();

  // Fail CLOSED: the overlay starts locked and only unlocks after the vault
  // itself answers. The old init keyed the lock to the REDUX MIRROR
  // (accounts.length > 0), so any mirror/vault desync — an interrupted wipe
  // (mirror cleared, key deletion unawaited), a lost/corrupt `keys.<user>`
  // index, or a failed/timed-out rehydrate (redux-persist boots the empty
  // slice and durably writes it back) — launched UNLOCKED over real
  // key records with no PIN prompt (confirmed finding).
  const [locked, setLocked] = useState(true);
  const [bioAvailable, setBioAvailable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wasBackgrounded = useRef(false);
  /** When the app last left the foreground — drives the re-lock grace window. */
  const backgroundedAt = useRef<number | null>(null);
  /**
   * Grace window for a round trip through the notification shade: pull it
   * down, tap, app returns — 2-5 seconds. Re-locking on that trip asks an
   * already-unlocked app to unlock twice for one action.
   */
  const RELOCK_GRACE_MS = 10_000;
  const [prevLockNonce, setPrevLockNonce] = useState(lockNonce);

  // Vault probe (mount-only): unlock only when NO protected material exists.
  // hasPin() reads the PIN verifier — the resource the lock protects — so a
  // desynced/empty mirror with keys still in the vault keeps the overlay UP
  // (fail closed), while a genuine first run unlocks. Background re-lock
  // below intentionally keeps its own accounts.length>0 condition unchanged:
  // once the initial gate is passed, the mirror and vault are known in sync.
  useEffect(() => {
    let active = true;
    void (async () => {
      const material = accounts.length > 0 || (await hasPin());
      if (active) setLocked(material);
    })();
    return () => {
      active = false;
    };
    // Mount-only baseline by design (the probe must not re-lock mid-use).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The lock gates the UI only. The live session and its room SURVIVE the
  // lock (auto or manual): the requesting app keeps its half until the QR's
  // `exp`, so a request arriving while locked is still waiting when the user
  // returns - killing the room here is exactly how approvals went missing
  // while frames piled up in the relay room. The QR's expiry is the
  // single teardown bound (see sessionManager.armExpiry).

  // "Lock now" from the drawer — render-phase adjustment (React's sanctioned
  // pattern for responding to prop/state changes without an effect).
  if (lockNonce !== prevLockNonce) {
    setPrevLockNonce(lockNonce);
    if (lockNonce > 0) setLocked(true);
  }

  // Global screen privacy, active for the whole app lifetime:
  //  - Android: FLAG_SECURE → screenshots blocked, blank app-switcher card
  //  - iOS: blur overlay in the app switcher / background snapshots
  //  - web: no-op (guarded inside the helper)
  useEffect(() => {
    void secureScreenOn("global");
    return () => {
      void secureScreenOff("global");
    };
  }, []);

  // Extra hardening while the lock overlay is visible.
  useEffect(() => {
    if (locked) {
      void secureScreenOn("lock");
    } else {
      void secureScreenOff("lock");
    }
  }, [locked]);

  useEffect(() => {
    isBiometricAvailable().then(setBioAvailable);
  }, []);

  // "Lock now" handled during render above.

  // Background → foreground re-lock.
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "background" || state === "inactive") {
        wasBackgrounded.current = true;
        backgroundedAt.current = Date.now();
        // Lock NOW, while this tree is still the one on screen: waiting for
        // the 'active' event on return paints the home page first (a frame -
        // or the whole resume, if JS was suspended) and only then swaps to
        // the lock screen. That flash was the bug. True background only:
        // 'inactive' alone is a notification-shade / switcher peek, which
        // keeps the grace window below.
        if (state === "background" && lockOnBackground && accounts.length > 0) {
          setLocked(true);
        }
      } else if (state === "active") {
        if (wasBackgrounded.current && lockOnBackground && accounts.length > 0) {
          const awayMs = backgroundedAt.current
            ? Date.now() - backgroundedAt.current
            : Number.POSITIVE_INFINITY;
          if (awayMs > RELOCK_GRACE_MS) {
            setLocked(true);
          } else {
            console.log(
              "[steemauth] re-lock skipped — away",
              awayMs,
              "ms (notification-tap grace)",
            );
          }
        }
        wasBackgrounded.current = false;
        backgroundedAt.current = null;
      }
    });
    return () => sub.remove();
  }, [lockOnBackground, accounts.length]);

  const tryBiometric = useCallback(async () => {
    setError(null);
    const status = await biometricStatus();
    if (!status.available) {
      setError(status.reason ?? "Biometrics unavailable.");
      return;
    }
    const ok = await biometricGate("Unlock SteemAuth");
    if (ok) {
      await hapticSuccess();
      setError(null);
      setLocked(false);
    } else {
      await hapticError();
    }
  }, []);

  const onUnlock = useCallback(() => {
    void hapticLight();
    setError(null);
    setLocked(false);
  }, []);

  // Not locked — run the app normally.
  if (!locked) return <>{children}</>;

  return (
    <View style={styles.fill}>
      {/* opaque backdrop so nothing underneath is readable */}
      <View
        style={[StyleSheet.absoluteFill, { backgroundColor: theme.colors.background }]}
      />
      <LinearGradient
        colors={[...palette.gradientDrawer]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={styles.hero}
      >
        <Image
          source={require("@/assets/images/icon.png")}
          style={styles.heroMark}
          resizeMode="contain"
          accessibilityRole="image"
          accessibilityLabel="SteemAuth"
        />
        <Text variant="headlineSmall" style={styles.heroTitle}>
          SteemAuth
        </Text>
        <Text variant="bodyMedium" style={styles.heroSubtitle}>
          {accounts.length > 0
            ? `${accounts.length} account${accounts.length > 1 ? "s" : ""} secured on this device`
            : "Your keys, on your device"}
        </Text>
      </LinearGradient>

      {/* Bottom clearance: this gate had none at all, so on a notification
          tap that lands here the "Unlock with biometrics" button sat behind
          the system navigation bar. Floor of 48dp covers 3-button nav even
          when the OS reports no inset. */}
      <View
        style={[
          styles.gateBody,
          { paddingBottom: systemClearance(insets.bottom) },
        ]}
      >
        <View style={[styles.lockChip, { backgroundColor: theme.colors.surfaceVariant }]}>
          <LockKeyhole size={16} color={theme.colors.onSurfaceVariant} />
          <Text variant="labelMedium" style={{ color: theme.colors.onSurfaceVariant }}>
            Locked
          </Text>
        </View>

        <PinGate
          title="Enter PIN to unlock"
          subtitle="Nothing can be signed or read while locked."
          actionLabel="Unlock"
          onUnlock={onUnlock}
        />

        {error ? (
          <Text variant="bodySmall" style={{ color: theme.colors.error }}>
            {error}
          </Text>
        ) : null}

        {bioAvailable ? (
          <Button
            mode="contained-tonal"
            icon={({ size, color }) => (
              <Fingerprint size={size} color={color} />
            )}
            onPress={tryBiometric}
            style={styles.bioBtn}
          >
            Unlock with biometrics
          </Button>
        ) : null}

        {accounts.length === 0 ? (
          <Button mode="text" onPress={onUnlock}>
            Skip — no keys stored yet
          </Button>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  hero: {
    paddingTop: 96,
    paddingBottom: 44,
    paddingHorizontal: 24,
    alignItems: "center",
    gap: 10,
    borderBottomLeftRadius: 36,
    borderBottomRightRadius: 36,
  },
  /** Brand tile: the logo artwork on navy — the same artwork as the icon. */
  heroMark: {
    width: 76,
    height: 76,
    borderRadius: 18,
    overflow: "hidden",
    marginBottom: 2,
  },
  heroTitle: { color: "#fff", fontWeight: "800" },
  heroSubtitle: { color: "rgba(255,255,255,0.85)", textAlign: "center" },
  gateBody: {
    flex: 1,
    justifyContent: "center",
    paddingHorizontal: 24,
    gap: 16,
  },
  lockChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    alignSelf: "center",
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
  },
  bioBtn: { alignSelf: "center", marginTop: 4 },
});
