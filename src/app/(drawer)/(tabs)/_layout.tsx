import { Tabs } from "expo-router";
import { FloatingTabBar } from "@/components/FloatingTabBar";

/**
 * Tabs: Home, Approvals, Activity, Sessions + the raised center QR button
 * rendered by FloatingTabBar. Settings lives in the drawer as a root stack
 * screen, so it is intentionally not a tab here.
 *
 * `accounts` stays a route (reachable from Home's "Manage accounts" button)
 * but no longer has a bar slot — approving is what users come back for.
 */
export default function TabsLayout() {
  return (
    <Tabs
      tabBar={(props) => <FloatingTabBar {...props} />}
      screenOptions={{
        headerShown: false,
        sceneStyle: { backgroundColor: "transparent" },
      }}
    >
      <Tabs.Screen name="index" options={{ title: "Home" }} />
      <Tabs.Screen name="approvals" options={{ title: "Approvals" }} />
      <Tabs.Screen name="accounts" options={{ title: "Accounts" }} />
      <Tabs.Screen name="activity" options={{ title: "Activity" }} />
      <Tabs.Screen name="sessions" options={{ title: "Sessions" }} />
    </Tabs>
  );
}
