import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, ScrollView, StyleSheet, View } from "react-native";
import { router } from "expo-router";
import { Appbar, Button, Divider, Switch, Text, TextInput, useTheme } from "react-native-paper";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import {
  Fingerprint,
  Lock,
  Vibrate,
  Trash2,
  ShieldCheck,
  Gauge,
  Images,
  Plus,
  RotateCcw,
  Star,
  X,
  ArrowLeft,
} from "lucide-react-native";
import { paletteFor, systemClearance } from "@/components/theme";
import { store } from "@/store";
import { useAppDispatch, useAppSelector } from "@/store/hooks";
import {
  setBiometricsEnabled,
  setLockOnBackground,
  setHapticsEnabled,
  setAutoFailover,
  setRemoteAvatarsEnabled,
  setPrimaryRpcServer,
  removeRpcServer,
  addRpcServer,
  resetRpcServers,
} from "@/store/settingsSlice";
import { clearAccounts } from "@/store/accountsSlice";
import { DEFAULT_RPC_SERVERS } from "@/constants/rpc";
import { isBiometricAvailable, biometricStatus } from "@/lib/secure";
import { clearPin, deleteStoredKeys, loadAllStoredKeys } from "@/lib/vault";
import { pingRpcServer } from "@/lib/steem/api";
import { hapticLight } from "@/lib/haptics";

/** Health state for one node: latency in ms, or null when unreachable. */
type NodeHealth = Record<string, number | null>;

export default function SettingsScreen() {
  const dispatch = useAppDispatch();
  const theme = useTheme();
  const palette = paletteFor(theme);
  const insets = useSafeAreaInsets();
  const settings = useAppSelector((s) => s.settings);
  const accounts = useAppSelector((s) => s.accounts.accounts);
  const [biometricCapable, setBiometricCapable] = useState(false);
  const [nodeHealth, setNodeHealth] = useState<NodeHealth>({});
  const [testing, setTesting] = useState(false);
  const [newNode, setNewNode] = useState("");
  const [showAddNode, setShowAddNode] = useState(false);
  const alive = useRef(true);

  useEffect(() => {
    isBiometricAvailable().then(setBiometricCapable);
    return () => {
      alive.current = false;
    };
  }, []);

  /** Ping every configured node in parallel; results drive the badges. */
  const testNodes = useCallback(async () => {
    setTesting(true);
    const list = store.getState().settings.rpcServers;
    const results = await Promise.all(
      list.map(async (url) => [url, await pingRpcServer(url)] as const),
    );
    if (!alive.current) return;
    setNodeHealth(Object.fromEntries(results));
    setTesting(false);
  }, []);

  // Health-check on mount so the badges are populated immediately.
  // (yield a tick so setTesting runs in an async continuation —
  //  React Compiler forbids sync setState inside an effect body)
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await Promise.resolve();
      if (!cancelled) await testNodes();
    })();
    return () => {
      cancelled = true;
    };
  }, [testNodes]);

  const toggleBiometrics = useCallback(
    async (value: boolean) => {
      if (value) {
        const ok = await biometricStatus();
        if (!ok.available) {
          Alert.alert(
            "Biometrics unavailable",
            ok.reason ??
              "Make sure your device has fingerprint or Face ID configured.",
          );
          return;
        }
        // Warn (once) if no stored account has a biometric copy yet — an
        // account may hold several keys, any of which counts.
        const hasCopy = await Promise.all(
          accounts.map(
            async (a) => (await loadAllStoredKeys(a.username)).some((k) => k.bioKey),
          ),
        );
        if (!hasCopy.some(Boolean)) {
          Alert.alert(
            "No protected accounts yet",
            "Re-import your accounts with biometrics enabled so they can be unlocked with fingerprint/Face ID.",
          );
        }
      }
      dispatch(setBiometricsEnabled(value));
    },
    [dispatch, accounts],
  );

  const confirmWipe = () => {
    Alert.alert(
      "Erase all accounts?",
      "This removes every stored key from this device. You will need your WIF or master password to re-import them.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Erase",
          style: "destructive",
          onPress: async () => {
            const names = accounts.map((a) => a.username);
            // Key material FIRST, then the mirror: the old order (mirror
            // cleared synchronously, deletion unawaited) could leave an empty
            // accounts mirror with keys still in the vault — and the
            // cold-start lock keys off that state, so the app would launch
            // UNLOCKED over real key records (confirmed finding). New worst
            // case: mirror intact + keys gone → the lock stays UP and the
            // user simply retries (fail closed, not fail open).
            try {
              await Promise.all(names.map(deleteStoredKeys));
              // The PIN guards nothing once no keys remain; clear it so the
              // next import starts the device-PIN flow cleanly.
              await clearPin();
              dispatch(clearAccounts());
            } catch {
              Alert.alert(
                "Erase incomplete",
                "Some keys could not be removed. Please try again.",
              );
            }
          },
        },
      ],
    );
  };

  const settingRow = (
    icon: React.ComponentType<{ size?: number; color?: string; strokeWidth?: number }>,
    title: string,
    desc: string,
    value: boolean,
    onChange: (v: boolean) => void,
    disabled = false,
  ) => {
    const Icon = icon;
    return (
      <View key={title} style={styles.row}>
        <View style={[styles.rowIcon, { backgroundColor: theme.colors.primaryContainer }]}>
          <Icon size={18} color={theme.colors.onPrimaryContainer} />
        </View>
        <View style={styles.label}>
          <Text variant="titleMedium" style={{ color: theme.colors.onSurface }}>
            {title}
          </Text>
          <Text variant="bodySmall" style={[styles.dim, { color: theme.colors.onSurfaceVariant, opacity: 1 }]}>
            {desc}
          </Text>
        </View>
        <Switch
          value={value}
          disabled={disabled}
          onValueChange={(v) => {
            onChange(v);
          }}
        />
      </View>
    );
  };

  return (
    <SafeAreaView
      style={[
        styles.container,
        {
          backgroundColor: theme.colors.background,
          // Stack screen (no tab bar): the gesture bar / 3-button nav is the
          // only thing to clear at the bottom, so the container owns it with
          // the shared floor — a reported inset of 0 must not drop it.
          paddingBottom: systemClearance(insets.bottom),
        },
      ]}
      edges={["top"]}
    >
      <Appbar.Header
        mode="small"
        style={{ backgroundColor: theme.colors.background }}
        elevated={false}
        statusBarHeight={0}
      >
        <Appbar.Action
          icon={({ size, color }) => <ArrowLeft size={size - 4} color={color} />}
          onPress={() => (router.canGoBack() ? router.back() : router.replace("/"))}
          accessibilityLabel="Back"
        />
        <Appbar.Content
          title="Settings"
          subtitle="Security, feedback and data"
        />
      </Appbar.Header>
      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        <Text variant="labelLarge" style={[styles.sectionTitle, { color: theme.colors.onSurfaceVariant }]}>
          Security
        </Text>
        <View style={[styles.card, { backgroundColor: theme.colors.surface, borderColor: theme.colors.outlineVariant }]}>
          {settingRow(
            Fingerprint,
            "Biometric unlock",
            `Use fingerprint or Face ID instead of the PIN.${!biometricCapable ? " (Not available on this device.)" : ""}`,
            settings.biometricsEnabled,
            (v) => {
              void toggleBiometrics(v);
            },
            !biometricCapable,
          )}
          <Divider />
          {settingRow(
            Lock,
            "Lock when backgrounded",
            "Require PIN again after switching apps.",
            settings.lockOnBackground,
            (v) => dispatch(setLockOnBackground(v)),
          )}
          <Divider />
          {settingRow(
            Images,
            "Load profile pictures",
            "Fetch account portraits from steemitimages.com. Every fetch tells " +
              "that third party which accounts this device shows, plus its IP " +
              "and when the app is used. Off keeps everything on-device (letter tiles).",
            settings.remoteAvatarsEnabled,
            (v) => dispatch(setRemoteAvatarsEnabled(v)),
          )}
        </View>

        <Text variant="labelLarge" style={[styles.sectionTitle, { color: theme.colors.onSurfaceVariant }]}>
          Feedback
        </Text>
        <View style={[styles.card, { backgroundColor: theme.colors.surface, borderColor: theme.colors.outlineVariant }]}>
          {settingRow(
            Vibrate,
            "Haptic feedback",
            "Vibrate on scan, approval and errors.",
            settings.hapticsEnabled,
            (v) => dispatch(setHapticsEnabled(v)),
          )}
        </View>

        {/* ---- Blockchain RPC ---- */}
        <View style={styles.rpcHeaderRow}>
          <Text variant="labelLarge" style={[styles.sectionTitle, { color: theme.colors.onSurfaceVariant, flex: 1 }]}>
            Blockchain RPC
          </Text>
          <Button
            mode="text"
            compact
            loading={testing}
            onPress={() => {
              void hapticLight();
              void testNodes();
            }}
            icon={({ size, color }) => <Gauge size={size - 4} color={color} />}
          >
            Test
          </Button>
        </View>

        <View style={[styles.card, { backgroundColor: theme.colors.surface, borderColor: theme.colors.outlineVariant }]}>
          {settingRow(
            Gauge,
            "Auto-failover",
            settings.autoFailover
              ? `Try the next of ${settings.rpcServers.length} nodes automatically on timeouts.`
              : "Only the primary node is used.",
            settings.autoFailover,
            (v) => dispatch(setAutoFailover(v)),
          )}

          <Divider />

          {settings.rpcServers.map((url, i) => {
            const latency = nodeHealth[url];
            const host = url.replace(/^https?:\/\//, "");
            const isUp = typeof latency === "number";
            return (
              <View key={url} style={styles.nodeRow}>
                <View
                  style={[
                    styles.nodeDot,
                    {
                      backgroundColor: latency === undefined
                        ? theme.colors.outlineVariant
                        : isUp
                          ? palette.success
                          : theme.colors.error,
                    },
                  ]}
                />
                <View style={{ flex: 1 }}>
                  <Text
                    variant="bodyMedium"
                    numberOfLines={1}
                    style={{
                      color: theme.colors.onSurface,
                      fontWeight: i === 0 ? "700" : "400",
                    }}
                  >
                    {host}
                  </Text>
                  <Text
                    variant="labelSmall"
                    style={{
                      color: theme.colors.onSurfaceVariant,
                      // Latency re-renders while nodes are pinged; tabular
                      // figures stop the row jittering as digits change.
                      fontVariant: ["tabular-nums"],
                    }}
                  >
                    {i === 0 ? "primary · " : ""}
                    {latency === undefined
                      ? "checking…"
                      : isUp
                        ? `${latency} ms`
                        : "unreachable"}
                  </Text>
                </View>
                {i !== 0 ? (
                  <Button
                    mode="text"
                    compact
                    onPress={() => {
                      void hapticLight();
                      dispatch(setPrimaryRpcServer(url));
                    }}
                    icon={({ size, color }) => <Star size={size - 6} color={color} />}
                  >
                    Primary
                  </Button>
                ) : null}
                {/* Only custom-added nodes are removable; the shipped
                    defaults stay (they can still be demoted to fallback). */}
                {!DEFAULT_RPC_SERVERS.includes(url) ? (
                  <Button
                    mode="text"
                    compact
                    textColor={theme.colors.error}
                    onPress={() => dispatch(removeRpcServer(url))}
                    icon={({ size, color }) => <X size={size - 6} color={color} />}
                  >
                    Remove
                  </Button>
                ) : null}
              </View>
            );
          })}

          <Divider />

          {showAddNode ? (
            <View style={styles.addNodeRow}>
              <TextInput
                label="https://api.example.com"
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                value={newNode}
                onChangeText={setNewNode}
                style={{ flex: 1 }}
              />
              <Button
                mode="contained"
                compact
                onPress={() => {
                  dispatch(addRpcServer(newNode));
                  setNewNode("");
                  setShowAddNode(false);
                }}
                disabled={!/^https?:\/\//.test(newNode.trim())}
              >
                Add
              </Button>
              <Button mode="text" compact onPress={() => setShowAddNode(false)}>
                Cancel
              </Button>
            </View>
          ) : (
            <View style={styles.addNodeRow}>
              <Button
                mode="text"
                compact
                icon={({ size, color }) => <Plus size={size - 4} color={color} />}
                onPress={() => setShowAddNode(true)}
              >
                Add node
              </Button>
              <View style={{ flex: 1 }} />
              <Button
                mode="text"
                compact
                icon={({ size, color }) => <RotateCcw size={size - 4} color={color} />}
                onPress={() => {
                  dispatch(resetRpcServers());
                  void testNodes();
                }}
              >
                Restore defaults
              </Button>
            </View>
          )}
        </View>
        <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant, marginLeft: 6 }}>
          Nodes are tried top-to-bottom. Transport failures (timeouts, 5xx)
          fall through to the next node; on-chain errors never do.
        </Text>

        <Text variant="labelLarge" style={[styles.sectionTitle, { color: theme.colors.onSurfaceVariant }]}>
          Danger zone
        </Text>
        <View
          style={[
            styles.card,
            {
              backgroundColor: theme.colors.surface,
              borderColor: theme.colors.error,
              // Danger zone gets its own breathing room: the shared card
              // style's 4dp reads as cramped around a destructive action.
              paddingVertical: 14,
            },
          ]}
        >
          <Button
            mode="contained"
            textColor={theme.colors.onError}
            buttonColor={theme.colors.error}
            onPress={confirmWipe}
            icon={({ size, color }) => <Trash2 size={size} color={color} />}
          >
            Erase all accounts from this device
          </Button>
          <Text variant="bodySmall" style={[styles.dim, { color: theme.colors.onSurfaceVariant, opacity: 1 }]}>
            Removes every stored key. You will need your WIF or master password
            to re-import them.
          </Text>
        </View>

        <View style={styles.about}>
          <ShieldCheck size={16} color={palette.success} />
          <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, flex: 1 }}>
            SteemAuth v1.0.0 — keys are encrypted with your PIN
            (PBKDF2 + AES) inside the device secure enclave. Private keys are
            never transmitted, backed up or logged.
          </Text>
        </View>
        <View style={{ height: 120 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  scroll: { paddingHorizontal: 16, gap: 6, paddingTop: 4 },
  sectionTitle: { fontWeight: "700", marginTop: 14, marginBottom: 4, marginLeft: 4 },
  card: {
    borderRadius: 22,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
    paddingVertical: 4,
    gap: 10,
    marginBottom: 4,
  },
  row: { flexDirection: "row", alignItems: "center", paddingVertical: 10, gap: 10 },
  rowIcon: { width: 36, height: 36, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  label: { flex: 1, paddingRight: 6, gap: 1 },
  rpcHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: 14,
    marginLeft: 4,
  },
  nodeRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 8,
    paddingHorizontal: 4,
  },
  nodeDot: { width: 10, height: 10, borderRadius: 5 },
  addNodeRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 6,
    paddingHorizontal: 4,
  },
  dim: { opacity: 0.7 },
  divider: { marginVertical: 2, marginHorizontal: 2 },
  about: {
    flexDirection: "row",
    gap: 10,
    alignItems: "flex-start",
    marginTop: 14,
    paddingHorizontal: 6,
  },
});
