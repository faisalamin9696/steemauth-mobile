import { useCallback, useEffect, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { CameraView, useCameraPermissions } from "expo-camera";
import { Appbar, Button, Text, useTheme } from "react-native-paper";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { ScanLine, CameraOff, Link2, UserPlus, X } from "lucide-react-native";
import { useAppSelector } from "@/store/hooks";
import { appOrigin, parseSessionQr, type SessionQrPayload } from "@/lib/protocol";
import { connectSession } from "@/lib/sessionManager";
import { hapticError, hapticMedium } from "@/lib/haptics";
import { systemClearance } from "@/components/theme";

export default function ScanScreen() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const [permission, requestPermission] = useCameraPermissions();
  const [scanned, setScanned] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cameraRef = useRef<CameraView>(null);
  const accounts = useAppSelector((s) => s.accounts.accounts);
  const hasAccounts = accounts.length > 0;

  // Re-arm the scanner whenever we come back to this screen (e.g. after
  // returning from the background) so the same QR can be scanned again.
  useFocusEffect(
    useCallback(() => {
      setScanned(false);
      setError(null);
    }, []),
  );

  const openSession = useCallback(async (payload: SessionQrPayload, backToCaller = false) => {
    await hapticMedium();
    // Refuses before any transport opens when the origin is blocked —
    // show why instead of navigating to a screen that can never connect.
    const denial = connectSession(payload);
    if (denial) {
      void hapticError();
      setError(denial);
      setScanned(true);
      setTimeout(() => setScanned(false), 3000);
      return;
    }
    setScanned(true);
    // Deep-link handoff: go BACK to whatever was underneath (the in-app
    // browser) - the request arrives there as a modal, and the user never
    // loses their page. Cold start (no caller on the stack) keeps the full
    // approval screen. A camera scan REPLACES this screen: once the QR is
    // valid the scanner must close, so leaving the session lands where the
    // scan started (home) instead of a dead camera view.
    if (backToCaller && router.canGoBack()) {
      router.back();
    } else {
      router.replace("/session");
    }
  }, []);

  // Deep link: the in-app browser (or any OS link) handed us a session
  // payload - no camera involved, the SAME parse + validation path as a
  // camera read (expiry, clock skew, relay URL/room/token, blocklist all still apply).
  //
  // NO-CONSENT CONNECT (confirmed finding): an exported-activity intent can
  // be fired by ANY co-resident app or webpage at any time. Auto-connecting
  // replaced a live session, wiped its queue and announced the active
  // account before any user-visible step. The payload is now parsed into a
  // CONFIRMATION CARD (who asks, declared origin, target account) that the
  // user must Accept; only then does openSession run. Decline discards it.
  const params = useLocalSearchParams<{ payload?: string }>();
  const payloadParam =
    typeof params.payload === "string" && params.payload.length > 0
      ? params.payload
      : null;
  const payloadHandled = useRef(false);
  const [pendingLink, setPendingLink] = useState<SessionQrPayload | null>(null);

  useEffect(() => {
    if (!payloadParam || payloadHandled.current) return;
    payloadHandled.current = true;
    // One tick out of the effect body: the hook rule wants state writes
    // deferred (connectSession also dispatches redux synchronously later,
    // inside openSession — only after the user accepts).
    const id = setTimeout(() => {
      try {
        setPendingLink(parseSessionQr(payloadParam));
      } catch (e) {
        void hapticError();
        setError(e instanceof Error ? e.message : "Invalid session payload.");
      }
    }, 0);
    return () => clearTimeout(id);
  }, [payloadParam]);

  const acceptLink = () => {
    if (!pendingLink) return;
    const payload = pendingLink;
    setPendingLink(null);
    void openSession(payload, true);
  };

  const onScanned = useCallback(
    ({ data }: { data: string }) => {
      if (scanned) return;
      setError(null);
      try {
        const payload = parseSessionQr(data);
        void openSession(payload);
      } catch (e) {
        void hapticError();
        setError(e instanceof Error ? e.message : "Invalid QR code.");
        // Pause briefly so a bad code doesn't spam errors.
        setScanned(true);
        setTimeout(() => setScanned(false), 2000);
      }
    },
    [scanned, openSession],
  );

  useEffect(() => {
    if (permission && !permission.granted && permission.canAskAgain) {
      requestPermission().catch(() => {});
    }
  }, [permission, requestPermission]);

  const close = () => {
    if (router.canGoBack()) router.back();
    else router.replace("/");
  };

  // ---- No accounts yet ---------------------------------------------------
  if (!hasAccounts) {
    return (
      <SafeAreaView edges={["top"]} style={[styles.safe, { backgroundColor: theme.colors.background, paddingBottom: systemClearance(insets.bottom) }]}>
        <Appbar.Header mode="small" statusBarHeight={0} style={{ backgroundColor: theme.colors.background }}>
          <Appbar.Action icon={({ size, color }) => <X size={size - 4} color={color} />} onPress={close} />
          <Appbar.Content title="Scan" />
        </Appbar.Header>
        <View style={styles.center}>
          <View style={[styles.bigIcon, { backgroundColor: theme.colors.primaryContainer }]}>
            <UserPlus size={40} color={theme.colors.onPrimaryContainer} />
          </View>
          <Text variant="titleMedium" style={{ color: theme.colors.onSurface }}>
            No account added yet
          </Text>
          <Text variant="bodyMedium" style={[styles.hint, { color: theme.colors.onSurfaceVariant }]}>
            Add a Steem account before scanning approval requests — the QR
            carries actions that need your key.
          </Text>
          <Button
            mode="contained"
            onPress={() => router.replace("/accounts")}
            icon={({ size, color }) => <UserPlus size={size} color={color} />}
          >
            Add account
          </Button>
        </View>
      </SafeAreaView>
    );
  }

  // ---- Deep-link payload (no camera involved) ----------------------------
  if (payloadParam) {
    // Consent card first: this screen now STAYS until the user decides (the
    // old auto-connect flashed a transient screen or nothing at all). Only a
    // FAILURE gets its own screen after a decline is impossible.
    if (!error && pendingLink) {
      return (
        <SafeAreaView edges={["top"]} style={[styles.safe, { backgroundColor: theme.colors.background, paddingBottom: systemClearance(insets.bottom) }]}>
          <Appbar.Header mode="small" statusBarHeight={0} style={{ backgroundColor: theme.colors.background }}>
            <Appbar.Action icon={({ size, color }) => <X size={size - 4} color={color} />} onPress={close} />
            <Appbar.Content title="Connect request" />
          </Appbar.Header>
          <View style={styles.center}>
            <View style={[styles.bigIcon, { backgroundColor: theme.colors.primaryContainer }]}>
              <Link2 size={40} color={theme.colors.onPrimaryContainer} />
            </View>
            <Text variant="titleMedium" style={{ color: theme.colors.onSurface, textAlign: "center" }}>
              {pendingLink.app} wants to connect
            </Text>
            <Text variant="bodyMedium" style={{ color: theme.colors.onSurface, fontWeight: "600", textAlign: "center" }}>
              {appOrigin(pendingLink) || "This request declares no origin"}
            </Text>
            <Text variant="bodyMedium" style={[styles.hint, { color: theme.colors.onSurfaceVariant }]}>
              Target: {pendingLink.account ? `@${pendingLink.account}` : "any account on this device"}{"\n"}
              This arrived as a link — declared in the QR, not verified.
              Connecting announces your active account to this app; nothing
              is signed until you approve a request.
            </Text>
            <Button mode="contained" onPress={acceptLink}>Connect</Button>
            <Button mode="text" onPress={close}>Decline</Button>
          </View>
        </SafeAreaView>
      );
    }
    if (!error) return null; // one-frame transit while the card mounts
    return (
      <SafeAreaView edges={["top"]} style={[styles.safe, { backgroundColor: theme.colors.background, paddingBottom: systemClearance(insets.bottom) }]}>
        <Appbar.Header mode="small" statusBarHeight={0} style={{ backgroundColor: theme.colors.background }}>
          <Appbar.Action icon={({ size, color }) => <X size={size - 4} color={color} />} onPress={close} />
          <Appbar.Content title={error ? "Could not connect" : "Connecting"} />
        </Appbar.Header>
        <View style={styles.center}>
          <Text variant="titleMedium" style={{ color: theme.colors.error }} numberOfLines={3}>
            {error}
          </Text>
          <Button mode="contained" onPress={close}>Close</Button>
        </View>
      </SafeAreaView>
    );
  }

  // ---- No camera permission ----------------------------------------------
  if (!permission?.granted) {
    return (
      <SafeAreaView edges={["top"]} style={[styles.safe, { backgroundColor: theme.colors.background, paddingBottom: systemClearance(insets.bottom) }]}>
        <Appbar.Header mode="small" statusBarHeight={0} style={{ backgroundColor: theme.colors.background }}>
          <Appbar.Action icon={({ size, color }) => <X size={size - 4} color={color} />} onPress={close} />
          <Appbar.Content title="Scan" />
        </Appbar.Header>
        <View style={styles.center}>
          <View style={[styles.bigIcon, { backgroundColor: theme.colors.errorContainer }]}>
            <CameraOff size={40} color={theme.colors.onErrorContainer} />
          </View>
          <Text variant="titleMedium" style={{ color: theme.colors.onSurface }}>
            Camera access needed
          </Text>
          <Text variant="bodyMedium" style={[styles.hint, { color: theme.colors.onSurfaceVariant }]}>
            SteemAuth uses the camera only to read approval request QR
            codes. Nothing is recorded or uploaded.
          </Text>
          <Button mode="contained" onPress={requestPermission}>
            Grant camera access
          </Button>
        </View>
      </SafeAreaView>
    );
  }

  // ---- Camera -------------------------------------------------------------
  return (
    <SafeAreaView edges={["top"]} style={[styles.safeDark, { paddingBottom: systemClearance(insets.bottom) }]}>
      <Appbar.Header mode="small" dark statusBarHeight={0} style={styles.cameraBar}>
        <Appbar.Action icon={({ size, color }) => <X size={size - 4} color={color} />} onPress={close} />
        <Appbar.Content title="Scan QR" subtitle="Point at the code shown in the Steem app" />
        <ScanLine size={20} color="#fff" style={{ marginRight: 16 }} />
      </Appbar.Header>

      <View style={styles.cameraWrap}>
        <CameraView
          ref={cameraRef}
          style={StyleSheet.absoluteFill}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
          onBarcodeScanned={scanned ? undefined : onScanned}
        />

        {/* corner frame */}
        <View style={styles.frameOuter} pointerEvents="none">
          {[
            styles.cornerTL,
            styles.cornerTR,
            styles.cornerBL,
            styles.cornerBR,
          ].map((c, i) => (
            <View key={i} style={[c, styles.corner, { borderColor: "#fff" }]} />
          ))}
        </View>

        <View style={[styles.footer, { bottom: systemClearance(insets.bottom) + 28 }]} pointerEvents="none">
          <Text variant="bodyMedium" style={styles.footerText}>
            {scanned && !error
              ? "Connecting…"
              : "Only approve actions you recognise"}
          </Text>
        </View>
      </View>

      {error ? (
        <View style={[styles.errorBar, { backgroundColor: theme.colors.errorContainer }]}>
          <Text variant="bodyMedium" style={{ color: theme.colors.onErrorContainer }} numberOfLines={2}>
            {error}
          </Text>
        </View>
      ) : null}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  safeDark: { flex: 1, backgroundColor: "#0B0E14" },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 28,
    gap: 14,
  },
  bigIcon: { width: 88, height: 88, borderRadius: 28, alignItems: "center", justifyContent: "center" },
  hint: { textAlign: "center", lineHeight: 20 },
  cameraBar: { backgroundColor: "rgba(11,14,20,0.6)" },
  cameraWrap: { flex: 1, alignItems: "center", justifyContent: "center" },
  frameOuter: {
    width: 250,
    height: 250,
    borderRadius: 36,
    borderWidth: 0,
  },
  corner: {
    position: "absolute",
    width: 44,
    height: 44,
    borderColor: "#fff",
  },
  cornerTL: { top: 0, left: 0, borderTopWidth: 4, borderLeftWidth: 4, borderTopLeftRadius: 36 },
  cornerTR: { top: 0, right: 0, borderTopWidth: 4, borderRightWidth: 4, borderTopRightRadius: 36 },
  cornerBL: { bottom: 0, left: 0, borderBottomWidth: 4, borderLeftWidth: 4, borderBottomLeftRadius: 36 },
  cornerBR: { bottom: 0, right: 0, borderBottomWidth: 4, borderRightWidth: 4, borderBottomRightRadius: 36 },
  footer: { position: "absolute", bottom: 28 },
  footerText: {
    color: "rgba(255,255,255,0.85)",
    backgroundColor: "rgba(0,0,0,0.45)",
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 999,
    overflow: "hidden",
  },
  errorBar: {
    margin: 14,
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 16,
    alignItems: "center",
  },
});
