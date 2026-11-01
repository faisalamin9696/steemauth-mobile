import { useCallback, useState } from "react";
import { Image, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { router } from "expo-router";
import { LinearGradient } from "expo-linear-gradient";
import type { DrawerContentComponentProps } from "@react-navigation/drawer";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Divider, Menu, Text, useTheme } from "react-native-paper";
import {
  Home,
  KeyRound,
  ChevronDown,
  Check,
  History,
  Settings,
  ScanLine,
  ShieldCheck,
  Lock,
} from "lucide-react-native";
import { useAppDispatch, useAppSelector } from "@/store/hooks";
import { requestLock } from "@/store/settingsSlice";
import { setActiveAccount } from "@/store/accountsSlice";
import { AccountAvatar } from "./AccountAvatar";
import { paletteFor, radii, shadows, systemClearance } from "./theme";
import { hapticLight, hapticMedium } from "@/lib/haptics";

type IconType = React.ComponentType<{
  size?: number;
  color?: string;
  strokeWidth?: number;
}>;

/**
 * Drawer rows are plain Pressables on purpose: expo-router SDK 58 vendors
 * its own @react-navigation copy, so the published DrawerItem would read a
 * different theme context and crash.
 */
function Row({
  icon: Icon,
  label,
  color,
  onPress,
  bold = false,
}: {
  icon: IconType;
  label: string;
  color: string;
  onPress: () => void;
  bold?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={() => {
        void hapticLight();
        onPress();
      }}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
    >
      <Icon size={20} color={color} strokeWidth={bold ? 2.3 : 2} />
      <Text
        variant="bodyLarge"
        style={[styles.rowLabel, { color, fontWeight: bold ? "700" : "600" }]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

export function DrawerContent(props: DrawerContentComponentProps) {
  const theme = useTheme();
  const palette = paletteFor(theme);
  const insets = useSafeAreaInsets();
  const dispatch = useAppDispatch();
  const activeUsername = useAppSelector((s) => s.accounts.activeUsername);
  const biometricsEnabled = useAppSelector((s) => s.settings.biometricsEnabled);
  const accounts = useAppSelector((s) => s.accounts.accounts);
  const [switchOpen, setSwitchOpen] = useState(false);

  const go = useCallback(
    (path: "/" | "/accounts" | "/activity" | "/settings") => {
      props.navigation.closeDrawer();
      router.push(path);
    },
    [props.navigation],
  );

  const scan = async () => {
    props.navigation.closeDrawer();
    await hapticMedium();
    router.push("/scan");
  };

  const lockNow = () => {
    props.navigation.closeDrawer();
    // Lock immediately. Like LockGate's auto-lock, this gates the UI only —
    // a live session survives until the QR's `exp` so follow-up operations
    // from the same app can still be approved after unlocking.
    dispatch(requestLock());
    void hapticMedium();
  };

  return (
    <ScrollView
      style={[styles.scroll, { backgroundColor: theme.colors.surface }]}
      contentContainerStyle={{ paddingBottom: systemClearance(insets.bottom) + 8 }}
      showsVerticalScrollIndicator={false}
    >
      <LinearGradient
        colors={[...palette.gradientDrawer]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={[styles.header, { paddingTop: Math.max(insets.top, 44) + 20 }]}
      >
        {/* No account yet: logo stacked ABOVE the text — the original
            vertical rhythm, with the app logo instead of the shield badge. */}
        {accounts.length === 0 ? (
          <>
            <Image
              source={require("@/assets/images/icon.png")}
              style={styles.headerLogo}
              resizeMode="cover"
              accessibilityRole="image"
              accessibilityLabel="SteemAuth"
            />
            <Text variant="titleLarge" style={styles.headerTitle}>
              SteemAuth
            </Text>
            <Text variant="bodySmall" style={styles.headerSub}>
              No account selected
            </Text>
          </>
        ) : (
          <>
            {activeUsername ? (
              <AccountAvatar
                account={activeUsername}
                size={48}
                style={styles.headerBadgeRing}
              />
            ) : (
              <View style={styles.headerBadge}>
                <ShieldCheck size={26} color="#fff" strokeWidth={2.2} />
              </View>
            )}
            <Text variant="titleLarge" style={styles.headerTitle}>
              SteemAuth
            </Text>

            {/* Account switcher: the header line doubles as the dropdown anchor
                so the active account can be changed from anywhere, instantly —
                setActiveAccount is one dispatch and every screen re-scopes off
                activeUsername (Approvals, Activity, the approval gate). */}
            <Menu
              visible={switchOpen}
              onDismiss={() => setSwitchOpen(false)}
              anchor={
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Switch account (currently @${activeUsername ?? "none"})`}
                  onPress={() => setSwitchOpen(true)}
                  style={styles.switchAnchor}
                >
                  <Text variant="bodySmall" style={styles.headerSub}>
                    {activeUsername ? `@${activeUsername}` : "No account selected"}
                  </Text>
                  <ChevronDown size={14} color="rgba(255,255,255,0.85)" />
                </Pressable>
              }
              contentStyle={{
                backgroundColor: theme.colors.surface,
                borderRadius: radii.md,
                marginTop: 6,
                // Fixed width: sized to its tiny "@user ⌄" anchor the menu used
                // to squeeze rows until usernames and the check were cut off.
                width: 264,
              }}
            >
              {accounts.map((a) => (
                <Pressable
                  key={a.username}
                  accessibilityRole="button"
                  accessibilityLabel={`Switch to @${a.username}`}
                  onPress={() => {
                    setSwitchOpen(false);
                    if (a.username !== activeUsername) {
                      dispatch(setActiveAccount(a.username));
                      void hapticLight();
                    }
                  }}
                  style={({ pressed }) => [
                    styles.switchRow,
                    {
                      backgroundColor: pressed
                        ? theme.colors.surfaceVariant
                        : "transparent",
                    },
                  ]}
                >
                  <AccountAvatar account={a.username} size={26} />
                  <Text
                    variant="bodyMedium"
                    numberOfLines={1}
                    style={{
                      flex: 1,
                      color: theme.colors.onSurface,
                      fontWeight: a.username === activeUsername ? "700" : "500",
                    }}
                  >
                    @{a.username}
                  </Text>
                  {a.username === activeUsername ? (
                    <Check size={16} color={palette.success} strokeWidth={2.6} />
                  ) : null}
                </Pressable>
              ))}
            </Menu>

            <View style={styles.secureChip}>
              <Lock size={12} color="#fff" />
              <Text variant="labelSmall" style={styles.secureChipText}>
                Keys stored in secure enclave
              </Text>
            </View>
          </>
        )}
      </LinearGradient>

      <View style={styles.section}>
        <Text
          variant="labelLarge"
          style={[styles.sectionTitle, { color: theme.colors.onSurfaceVariant }]}
        >
          Navigate
        </Text>
        <Row icon={Home} label="Home" color={theme.colors.onSurface} onPress={() => go("/")} />
        <Row
          icon={KeyRound}
          label="Accounts"
          color={theme.colors.onSurface}
          onPress={() => go("/accounts")}
        />
        <Row
          icon={History}
          label="Activity"
          color={theme.colors.onSurface}
          onPress={() => go("/activity")}
        />
        <Row
          icon={Settings}
          label="Settings"
          color={theme.colors.onSurface}
          onPress={() => go("/settings")}
        />

        <Divider style={styles.divider} />

        <Row icon={ScanLine} label="Scan QR" color={theme.colors.primary} onPress={scan} bold />
        <Row
          icon={Lock}
          label={biometricsEnabled ? "Lock (biometrics)" : "Lock app"}
          color={theme.colors.onSurface}
          onPress={lockNow}
        />
      </View>

      <View style={[styles.footer, { borderTopColor: theme.colors.outlineVariant }]}>
        <View style={styles.footerRow}>
          <ShieldCheck size={14} color={palette.success} />
          <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>
            1.0.0 (MIT)
          </Text>
        </View>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1 },
  header: {
    // Taller card: more air top and bottom + a floor so the EMPTY state
    // (one-line logo row + chip) doesn't collapse the gradient to a stub —
    // the account state simply grows past the floor.
    paddingBottom: 34,
    paddingHorizontal: 20,
    minHeight: 190,
    alignItems: "flex-start",
    gap: 10,
    borderBottomLeftRadius: 28,
    borderBottomRightRadius: 28,
    ...shadows.card,
  },
  headerBadge: {
    width: 48,
    height: 48,
    borderRadius: 16,
    backgroundColor: "rgba(255,255,255,0.2)",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 6,
  },
  headerBadgeRing: {
    borderWidth: 2,
    borderColor: "rgba(255,255,255,0.6)",
    marginBottom: 6,
  },
  headerLogo: {
    width: 48,
    height: 48,
    borderRadius: 16,
    marginBottom: 4,
  },
  headerTitle: { color: "#fff", fontWeight: "800" },
  headerSub: { color: "rgba(255,255,255,0.85)" },
  switchAnchor: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingVertical: 2,
    paddingRight: 6,
  },
  switchRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  secureChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    marginTop: 8,
    backgroundColor: "rgba(255,255,255,0.18)",
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
  },
  secureChipText: { color: "#fff" },
  section: { paddingTop: 14, paddingHorizontal: 8 },
  sectionTitle: { paddingHorizontal: 14, paddingVertical: 6, fontWeight: "700" },
  divider: { marginVertical: 8, marginHorizontal: 14 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    paddingVertical: 13,
    paddingHorizontal: 18,
    borderRadius: radii.md,
    marginHorizontal: 6,
    marginVertical: 1,
  },
  rowPressed: { backgroundColor: "rgba(127,127,127,0.14)" },
  rowLabel: { fontSize: 15 },
  footer: {
    marginTop: 16,
    gap: 2,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: 12,
    paddingHorizontal: 8,
  },
  footerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 18,
    paddingBottom: 4,
  },
});
