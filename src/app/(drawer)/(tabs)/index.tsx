import { useCallback } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { router } from "expo-router";
import { LinearGradient } from "expo-linear-gradient";
import { Button, Text, useTheme } from "react-native-paper";
import { ScanLine, ShieldCheck, KeyRound, Lock, ChevronRight } from "lucide-react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { ScreenHeader } from "@/components/ScreenHeader";
import { paletteFor, radii, shadows, tabClearance } from "@/components/theme";
import { useAppSelector } from "@/store/hooks";
import { hapticMedium } from "@/lib/haptics";

export default function HomeScreen() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const palette = paletteFor(theme);
  const accounts = useAppSelector((s) => s.accounts.accounts);
  const activeUsername = useAppSelector((s) => s.accounts.activeUsername);
  const biometricsEnabled = useAppSelector((s) => s.settings.biometricsEnabled);
  const lockOnBackground = useAppSelector((s) => s.settings.lockOnBackground);
  const connection = useAppSelector((s) => s.session.connection);
  const hasAccounts = accounts.length > 0;

  const scan = useCallback(async () => {
    await hapticMedium();
    router.push("/scan");
  }, []);

  const manageAccounts = useCallback(async () => {
    await hapticMedium();
    router.push("/accounts");
  }, []);

  const connectionLabel =
    connection === "waiting" || connection === "request"
      ? "Session active"
      : hasAccounts
        ? "Ready"
        : "No keys";
  const connectionColor =
    connection === "waiting" || connection === "request"
      ? palette.success
      : hasAccounts
        ? theme.colors.primary
        : theme.colors.outline;

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: theme.colors.background }]} edges={["top"]}>
      <ScreenHeader
        title="SteemAuth"
        subtitle={
          activeUsername ? `Acting as @${activeUsername}` : "Add an account to begin"
        }
        status={{ color: connectionColor, label: connectionLabel }}
      />

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
      >
        {/* Hero: primary action */}
        <LinearGradient
          colors={[...palette.gradientHero]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={[styles.hero, shadows.card]}
        >
          {/* Cinematic anchor: the shield hangs off the bottom-right corner —
              oversized, faint and slightly rotated, clipped by the card so it
              reads as depth in a film still rather than an icon slot.
              pointerEvents="none" keeps it purely decorative. */}
          <View style={styles.heroShield} pointerEvents="none">
            <ShieldCheck size={152} color="#fff" strokeWidth={1.3} />
          </View>
          <Text variant="titleLarge" style={styles.heroTitle}>
            Approve safely, on your phone
          </Text>
          <Text variant="bodyMedium" style={styles.heroSub}>
            Scan the QR shown in a Steem app, review every action in plain
            language, then sign with keys that never leave this device.
          </Text>

          {/* Scan QR (primary) + Add / Manage accounts (secondary) */}
          <View style={styles.heroBtnRow}>
            <Button
              mode="contained"
              onPress={scan}
              buttonColor="rgba(255,255,255,0.95)"
              /* Fixed dark blue — theme.colors.primary is light in dark mode
                 and would wash out against the near-white button. */
              textColor="#1D4ED8"
              contentStyle={styles.heroBtnContent}
              style={styles.heroBtn}
              icon={({ size, color }) => <ScanLine size={size} color={color} />}
            >
              Scan QR code
            </Button>
            <Button
              mode="contained"
              onPress={manageAccounts}
              buttonColor="rgba(255,255,255,0.28)"
              textColor="#fff"
              contentStyle={styles.heroBtnContent}
              style={styles.heroBtn}
              icon={({ size, color }) => <KeyRound size={size} color={color} />}
            >
              {hasAccounts ? "Manage accounts" : "Add account"}
            </Button>
          </View>
        </LinearGradient>

        {/* Security status — single compact row */}
        <View
          style={[
            styles.securityCard,
            { backgroundColor: theme.colors.surface, borderColor: theme.colors.outlineVariant },
          ]}
        >
          <Lock size={14} color={theme.colors.primary} />
          <Text variant="labelLarge" style={{ color: theme.colors.onSurface, fontWeight: "700" }}>
            Security
          </Text>
          <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }} numberOfLines={1}>
            Enclave · {biometricsEnabled ? "Biometrics" : "PIN"} · Auto-lock {lockOnBackground ? "on" : "off"}
          </Text>
        </View>

        {/* How it works */}
        <View style={[styles.steps, { backgroundColor: theme.colors.surfaceVariant }]}>
          <Text variant="labelLarge" style={{ color: theme.colors.onSurfaceVariant }}>
            How it works
          </Text>
          {[
            "A Steem app shows a QR request",
            "You scan and review each action",
            "Unlock with PIN or biometrics",
            "Signed & broadcast from your device",
          ].map((step, i) => (
            <View key={i} style={styles.stepRow}>
              <View style={[styles.stepNum, { backgroundColor: theme.colors.primary }]}>
                <Text variant="labelSmall" style={{ color: theme.colors.onPrimary, fontWeight: "800" }}>
                  {i + 1}
                </Text>
              </View>
              <Text variant="bodyMedium" style={{ color: theme.colors.onSurface }}>
                {step}
              </Text>
              {i < 3 ? <ChevronRight size={14} color={theme.colors.outline} style={styles.stepChevron} /> : null}
            </View>
          ))}
        </View>

        <View style={{ height: tabClearance(insets.bottom) }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  scroll: { paddingHorizontal: 16, gap: 14, paddingBottom: 8 },
  hero: {
    // overflow hidden is load-bearing: the shield watermark bleeds past the
    // bottom-right corner and must be clipped by the card's radius.
    borderRadius: radii.xxl,
    overflow: "hidden",
    padding: 22,
    gap: 8,
  },
  heroShield: {
    position: "absolute",
    right: -30,
    bottom: -36,
    opacity: 0.16,
    transform: [{ rotate: "-8deg" }],
  },
  heroTitle: { color: "#fff", fontWeight: "800" },
  heroSub: { color: "rgba(255,255,255,0.88)", lineHeight: 20 },
  heroBtnRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
    marginTop: 10,
  },
  heroBtn: { borderRadius: radii.pill },
  heroBtnContent: { height: 42, paddingHorizontal: 6 },
  securityCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  steps: { borderRadius: radii.lg, padding: 16, gap: 10 },
  stepRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  stepNum: {
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: "center",
    justifyContent: "center",
  },
  stepChevron: { marginLeft: "auto" },
});
