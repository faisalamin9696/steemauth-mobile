import { Drawer } from "expo-router/drawer";
import type { DrawerContentComponentProps } from "@react-navigation/drawer";
import { useTheme } from "react-native-paper";
import { DrawerContent } from "@/components/DrawerContent";

/**
 * Root drawer wraps the tab navigator. Only the tabs live here; scan and
 * session remain stack screens above (defined in the root _layout).
 */
export default function DrawerLayout() {
  const theme = useTheme();
  return (
    <Drawer
      drawerContent={(props) => (
        // expo-router ships its own DrawerRouter types (extra fields like
        // preloadedRouteKeys) that are structurally compatible at runtime.
        <DrawerContent {...(props as unknown as DrawerContentComponentProps)} />
      )}
      screenOptions={{
        headerShown: false,
        drawerType: "front",
        drawerStyle: { width: 306, backgroundColor: theme.colors.surface },
        overlayColor: "rgba(0,0,0,0.45)",
        swipeEnabled: true,
      }}
    >
      <Drawer.Screen name="(tabs)" options={{ title: "Home" }} />
    </Drawer>
  );
}
