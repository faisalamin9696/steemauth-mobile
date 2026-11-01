import { useCallback, useEffect, useState } from "react";
import { StyleSheet, useWindowDimensions, View } from "react-native";
import { Button, Text, useTheme } from "react-native-paper";
import { Delete } from "lucide-react-native";
import { verifyPinLocked, pinLockState, type PinCheck } from "@/lib/vault";
import { hapticError, hapticLight } from "@/lib/haptics";

interface Props {
  /** Called once the PIN verifies. */
  onUnlock: (pin: string) => void;
  onCancel?: () => void;
  title?: string;
  subtitle?: string;
  actionLabel?: string;
}

const DOT_COUNT = 6;

export function PinGate({
  onUnlock,
  onCancel,
  title = "Enter PIN",
  subtitle = "Your keys never leave this device.",
  actionLabel = "Unlock",
}: Props) {
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [lockedFor, setLockedFor] = useState(0);
  const [busy, setBusy] = useState(false);
  const theme = useTheme();
  const { width } = useWindowDimensions();
  // The keypad fits every screen: 3 columns inside the parent's gutters,
  // capped at the design width (tablets don't get a giant pad) and floored
  // so tiny screens still get tappable keys.
  const padWidth = Math.min(284, Math.max(216, width - 56));
  const keyWidth = Math.floor(padWidth / 3) - 6;
  const keyHeight = Math.min(60, Math.max(48, Math.round(keyWidth * 0.66)));

  // Pick up an existing lockout (e.g. re-mounted after backgrounding).
  useEffect(() => {
    let active = true;
    pinLockState().then((s) => {
      if (active && s.lockedForMs > 0) setLockedFor(s.lockedForMs);
    });
    return () => {
      active = false;
    };
  }, []);

  // Tick down the lockout countdown every second.
  useEffect(() => {
    if (lockedFor <= 0) return;
    const t = setInterval(() => {
      setLockedFor((prev) => {
        if (prev <= 1000) return 0;
        return prev - 1000;
      });
    }, 1000);
    return () => clearInterval(t);
  }, [lockedFor]);

  const handleResult = useCallback(
    (result: PinCheck, entered: string) => {
      if (result.ok) {
        void hapticLight();
        setError(null);
        setNotice(null);
        onUnlock(entered);
        return;
      }
      void hapticError();
      setPin("");
      if (result.lockedForMs > 0) {
        setLockedFor(result.lockedForMs);
        setError(null);
        setNotice("Too many attempts. PIN entry temporarily disabled.");
      } else if (typeof result.attemptsLeft === "number" && result.attemptsLeft <= 3) {
        setError(
          `Incorrect PIN — ${result.attemptsLeft} attempt${
            result.attemptsLeft === 1 ? "" : "s"
          } before a lockout.`,
        );
      } else {
        setError("Incorrect PIN. Try again.");
      }
    },
    [onUnlock],
  );

  const press = useCallback(
    (d: string) => {
      if (busy || lockedFor > 0 || pin.length >= DOT_COUNT) return;
      setError(null);
      const next = pin + d;
      setPin(next);
      if (next.length === DOT_COUNT) {
        setBusy(true);
        verifyPinLocked(next)
          .then((result) => handleResult(result, next))
          .finally(() => setBusy(false));
      }
    },
    [busy, lockedFor, pin, handleResult],
  );

  const del = useCallback(() => {
    if (busy || lockedFor > 0) return;
    setError(null);
    setPin((p) => p.slice(0, -1));
  }, [busy, lockedFor]);

  const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0", "del"];
  const locked = lockedFor > 0;
  const lockSeconds = Math.ceil(lockedFor / 1000);

  return (
    <View style={styles.container}>
      <Text variant="titleMedium" style={styles.title}>
        {title}
      </Text>
      <Text variant="bodyMedium" style={[styles.subtitle, { color: theme.colors.onSurfaceVariant }]}>
        {subtitle}
      </Text>

      <View style={styles.dots} accessibilityLabel={`${pin.length} of ${DOT_COUNT} digits entered`}>
        {Array.from({ length: DOT_COUNT }).map((_, i) => {
          const filled = i < pin.length;
          return (
            <View
              key={i}
              style={[
                styles.dot,
                {
                  borderColor: locked
                    ? theme.colors.error
                    : filled
                      ? theme.colors.primary
                      : theme.colors.outline,
                  backgroundColor: filled
                    ? locked
                      ? theme.colors.error
                      : theme.colors.primary
                    : "transparent",
                },
              ]}
            />
          );
        })}
      </View>

      {locked ? (
        <Text variant="bodySmall" style={{ color: theme.colors.error, textAlign: "center" }}>
          Locked for {lockSeconds}s — too many failed attempts.
        </Text>
      ) : error ? (
        <Text variant="bodySmall" style={{ color: theme.colors.error, textAlign: "center" }}>
          {error}
        </Text>
      ) : notice ? (
        <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, textAlign: "center" }}>
          {notice}
        </Text>
      ) : null}

      <View style={[styles.pad, { width: padWidth }]}>
        {keys.map((k, i) =>
          k === "" ? (
            <View key={i} style={[styles.key, { width: keyWidth, height: keyHeight }]} />
          ) : k === "del" ? (
            <Button
              key={i}
              mode="contained-tonal"
              disabled={busy || locked}
              style={[styles.key, { width: keyWidth, height: keyHeight }]}
              contentStyle={[styles.keyContent, { height: keyHeight - 4 }]}
              onPress={del}
              accessibilityLabel="Delete"
            >
              <Delete size={22} color={theme.colors.onSurfaceVariant} />
            </Button>
          ) : (
            <Button
              key={i}
              mode="contained-tonal"
              disabled={busy || locked}
              style={[styles.key, { width: keyWidth, height: keyHeight }]}
              contentStyle={[styles.keyContent, { height: keyHeight - 4 }]}
              onPress={() => press(k)}
              labelStyle={styles.keyLabel}
            >
              {k}
            </Button>
          ),
        )}
      </View>

      <View style={styles.row}>
        {onCancel ? (
          <Button mode="text" onPress={onCancel} disabled={busy}>
            Cancel
          </Button>
        ) : null}
        <Button
          mode="text"
          onPress={() => setPin("")}
          disabled={busy || locked || pin.length === 0}
        >
          Clear
        </Button>
      </View>
      {busy ? (
        <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>
          {actionLabel}…
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { alignItems: "center", gap: 8 },
  title: { fontWeight: "700" },
  subtitle: { textAlign: "center", opacity: 0.9 },
  dots: { flexDirection: "row", gap: 12, marginVertical: 16 },
  dot: {
    width: 14,
    height: 14,
    borderRadius: 7,
    borderWidth: 1.5,
  },
  pad: {
    flexDirection: "row",
    flexWrap: "wrap",
    width: 284,
    justifyContent: "center",
  },
  key: { width: 88, height: 60, margin: 2, justifyContent: "center" },
  keyContent: { height: 56 },
  keyLabel: { fontSize: 22, fontWeight: "600" },
  row: { flexDirection: "row", gap: 16, marginTop: 8 },
});
