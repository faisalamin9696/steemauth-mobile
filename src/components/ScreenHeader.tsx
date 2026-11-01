import { StyleSheet, View } from "react-native";
import { router, useNavigation } from "expo-router";
import { Appbar, Text, useTheme } from "react-native-paper";
import { Menu, Bell, ScanLine } from "lucide-react-native";

/** Navigation object shape we rely on (drawer layout exposes openDrawer). */
type HeaderNavigation = {
  openDrawer?: () => void;
  navigate: (name: never) => void;
};

interface Props {
  title: string;
  subtitle?: string;
  /** small colored dot status shown next to the title (optional) */
  status?: { color: string; label: string };
  showActivityShortcut?: boolean;
}

/**
 * Paper bar for the top of a screen.
 *
 * INSET RULE (one owner, never two): every screen that uses this header is
 * already wrapped in a `SafeAreaView edges={["top"]}`, which pads by the
 * status-bar inset — while `Appbar.Header` adds `paddingTop: insets.top` on
 * its own. Stacking both pushed the bar ~2× inset below the status bar, which
 * is exactly the "header sits too low" look. `statusBarHeight={0}` tells the
 * bar to trust the container: the container owns the inset, the bar owns the
 * 64dp row. (The approval modal opts out — it uses `edges={[]}` because it
 * computes its own clearance, so its bar keeps the default inset.)
 */
export function ScreenHeader({ title, subtitle, status, showActivityShortcut }: Props) {
  const theme = useTheme();
  const navigation = useNavigation() as HeaderNavigation;

  const openDrawer = () => {
    // Works because screens live inside the (drawer) layout.
    navigation.openDrawer?.();
  };

  return (
    <Appbar.Header
      mode="small"
      elevated={false}
      statusBarHeight={0}
      style={[{ backgroundColor: theme.colors.background }, { paddingHorizontal: 4 }]}
    >
      <Appbar.Action
        icon={({ size, color }) => <Menu size={size - 2} color={color} />}
        onPress={openDrawer}
        accessibilityLabel="Open menu"
      />
      <View style={styles.titles}>
        <View style={styles.titleRow}>
          <Text variant="titleLarge" style={{ fontWeight: "800", color: theme.colors.onBackground }}>
            {title}
          </Text>
          {status ? (
            <View style={styles.statusChip}>
              <View style={[styles.dot, { backgroundColor: status.color }]} />
              <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>
                {status.label}
              </Text>
            </View>
          ) : null}
        </View>
        {subtitle ? (
          <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {showActivityShortcut ? (
        <Appbar.Action
          icon={({ size, color }) => <Bell size={size - 4} color={color} />}
          onPress={() => navigation.navigate("activity" as never)}
          accessibilityLabel="Activity"
        />
      ) : null}
      {/* Scan lives on the top bar right, reachable from every screen - it
          left the bottom bar to make room for the in-app browser. */}
      <Appbar.Action
        icon={({ size, color }) => <ScanLine size={size - 4} color={color} />}
        onPress={() => router.push("/scan")}
        accessibilityLabel="Scan QR"
      />
    </Appbar.Header>
  );
}

const styles = StyleSheet.create({
  inner: { paddingHorizontal: 8 },
  titles: { flex: 1, justifyContent: "center" },
  titleRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  statusChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    backgroundColor: "rgba(127,127,127,0.14)",
  },
  dot: { width: 7, height: 7, borderRadius: 4 },
});
