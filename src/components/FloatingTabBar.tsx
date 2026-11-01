import { type ComponentType } from "react";
import { router } from "expo-router";
import { StyleSheet } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { BottomNavigation, useTheme } from "react-native-paper";
import type { BottomNavigationRoute } from "react-native-paper";
import { Home, ClipboardCheck, History, Globe, Compass } from "lucide-react-native";
import { useAppSelector } from "@/store/hooks";
import { systemClearance } from "./theme";

/**
 * Structural subset of expo-router's vendored BottomTabBarProps.
 * expo-router ships its own bottom-tabs copy (navigateToTab instead of
 * navigation.navigate), so we type only what this bar actually uses.
 */
export interface FloatingTabBarProps {
  state: {
    index: number;
    routes: readonly { key: string; name: string }[];
  };
  navigateToTab: (routeKey: string) => void;
}

/** Paper's route shape + the expo route name this item drives. */
type TabRoute = BottomNavigationRoute & { name: string };

const iconByRoute: Record<
  string,
  ComponentType<{ size?: number; color?: string; strokeWidth?: number }>
> = {
  index: Home,
  approvals: ClipboardCheck,
  browser: Compass,
  activity: History,
  sessions: Globe,
};

/**
 * Bottom bar built on React Native Paper's `BottomNavigation.Bar` — the
 * library's controlled, bar-only component: native M3 active indicator
 * (the pill behind the focused icon), native ripple, native badge dot, and
 * its own label/size metrics, all driven from this app's theme.
 *
 * The bar stays a FLAT overlay (absolute, hairline top border, shared
 * `systemClearance` floor) exactly as the screens expect — scene padding
 * does not change with this component.
 *
 * Browser (centre) and Scan both open stack screens rather than tabs, so
 * Browser is a route in the bar that NEVER becomes focused: its press
 * pushes the browser and leaves the bar index untouched. `accounts` is a
 * hidden tab (reachable from Home's "Manage accounts" button) and gets no
 * slot — while it is on screen the bar falls back to index 0 (Home, where
 * the user came from).
 */
export function FloatingTabBar({ state, navigateToTab }: FloatingTabBarProps) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();

  // Push is gone, so the ONLY way a user learns a request is waiting is this
  // bar: a live request lights the Approvals dot until it is decided.
  const waiting = useAppSelector(
    (s) => s.session.connection === "request" && !!s.session.pending,
  );

  const names = ["index", "approvals", "browser", "activity", "sessions"];
  const routes: TabRoute[] = names.map((name) => {
    const title =
      name === "index" ? "Home" : name.charAt(0).toUpperCase() + name.slice(1);
    return {
      key: name,
      name,
      title,
      accessibilityLabel:
        name === "approvals" && waiting ? `${title}, waiting for you` : title,
      badge: name === "approvals" && waiting ? true : undefined,
    };
  });

  const activeName = state.routes[state.index]?.name;
  const activeIndex = Math.max(
    0,
    routes.findIndex((r) => r.name === activeName),
  );

  return (
    <BottomNavigation.Bar
      // Controlled: the index is derived from expo-router's state, never
      // from the bar itself (this is the documented integration pattern).
      navigationState={{ index: activeIndex, routes }}
      onTabPress={({ route }) => {
        if (route.name === "browser") {
          router.push("/browser");
          return;
        }
        const target = state.routes.find((r) => r.name === route.name);
        if (target) navigateToTab(target.key);
      }}
      renderIcon={({ route, focused, color }) => {
        const Icon = iconByRoute[route.name] ?? Home;
        return <Icon size={22} color={color} strokeWidth={focused ? 2.4 : 1.9} />;
      }}
      shifting={false}
      keyboardHidesNavigationBar={false}
      // The app owns the bottom floor (systemClearance) — Paper's own inset
      // would double it.
      safeAreaInsets={{ bottom: 0 }}
      activeColor={theme.colors.primary}
      inactiveColor={theme.colors.onSurfaceVariant}
      // M3 pill: our blue tint, not the default emerald secondaryContainer
      // (the active icon is blue — the two must read as one gesture).
      activeIndicatorStyle={{ backgroundColor: theme.colors.primaryContainer }}
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: theme.colors.surface,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.colors.outlineVariant,
        paddingTop: 8,
        // Clear the system bar with the shared floor: a reported inset of 0
        // must not drop the bar behind a 3-button navigation bar.
        paddingBottom: systemClearance(insets.bottom),
      }}
    />
  );
}
