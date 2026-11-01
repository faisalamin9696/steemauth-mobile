import { useEffect } from "react";
import { StatusBar } from "expo-status-bar";
import { Stack } from "expo-router";
import { Provider as ReduxProvider } from "react-redux";
import { PersistGate } from "redux-persist/integration/react";
import { PaperProvider } from "react-native-paper";
import * as SplashScreen from "expo-splash-screen";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { useColorScheme, View } from "react-native";
import "react-native-get-random-values";
import { store, persistor } from "@/store";
import { darkTheme, lightTheme } from "@/components/theme";
import { LockGate } from "@/components/LockGate";
import { ensurePinExists } from "@/lib/secure";
import { resumePersistedSession } from "@/lib/sessionManager";

SplashScreen.preventAutoHideAsync().catch(() => {});

function Inner() {
  const scheme = useColorScheme();
  const theme = scheme === "dark" ? darkTheme : lightTheme;

  useEffect(() => {
    ensurePinExists().finally(() => {
      SplashScreen.hideAsync().catch(() => {});
    });
    // A process death must not orphan a session the requesting app still
    // holds: resume the live one (until its QR's `exp`) so Approvals shows
    // its watch card and the plane is listening again — no rescan.
    void resumePersistedSession();
  }, []);

  return (
    <PaperProvider theme={theme}>
      <StatusBar style="auto" />
      {/* Root background follows the theme so screens never show white in dark mode */}
      <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
        <LockGate>
          <Stack screenOptions={{ headerShown: false, animation: "slide_from_right" }}>
            <Stack.Screen name="(drawer)" />
            <Stack.Screen
              name="scan"
              options={{
                animation: "fade_from_bottom",
                // Deep-link handoffs (external scheme path) push this route
                // OVER the browser and pop right back — a white content
                // background flashed on every transit frame. Transparent lets
                // the browser underneath show through; the camera scan view
                // draws its own opaque background, so it is unaffected.
                contentStyle: { backgroundColor: "transparent" },
              }}
            />
            <Stack.Screen
              name="browser"
              options={{ animation: "fade_from_bottom" }}
            />
            <Stack.Screen
              name="session"
              options={{
                presentation: "modal",
                headerShown: false,
                animation: "slide_from_bottom",
              }}
            />
            <Stack.Screen name="settings" />
          </Stack>
        </LockGate>
      </View>
    </PaperProvider>
  );
}

export default function RootLayout() {
  return (
    // Drawer + swipe gestures require a gesture-handler root.
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <ReduxProvider store={store}>
          <PersistGate loading={null} persistor={persistor}>
            <Inner />
          </PersistGate>
        </ReduxProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
