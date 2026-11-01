import { useCallback, useEffect, useRef, useState, type ComponentType, type Ref } from "react";
import {
  BackHandler,
  Image,
  Keyboard,
  Linking,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { router } from "expo-router";
import WebView from "react-native-webview";
import { ActivityIndicator, Appbar, Button, Modal, ProgressBar, Text, useTheme } from "react-native-paper";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import Animated, { FadeIn, SlideInDown } from "react-native-reanimated";
import { CheckCircle2, ChevronRight, Globe, History, Link2, RotateCw, ScanLine, X } from "lucide-react-native";
import { radii, systemClearance } from "@/components/theme";
import { useAppSelector } from "@/store/hooks";
import { HANDOFF_TYPE, appOrigin, parseSessionQr, type SessionQrPayload } from "@/lib/protocol";
import { normalizeOrigin } from "@/store/blockedOriginsSlice";
import { connectSession } from "@/lib/sessionManager";
import { ApprovalSheet } from "@/components/ApprovalSheet";

type WebViewRaw = import("react-native-webview").default;
/**
 * The published .d.ts declares `class WebView<P = undefined>` whose default
 * generic collapses JSX attributes to `never` under React 19 + TS 5.x (known
 * react-native-webview typing bug). Re-type ONCE here so every prop on the
 * element below stays fully checked instead of suppressed.
 */
type WebViewComponent = ComponentType<
  import("react-native-webview").WebViewProps & { ref?: Ref<WebViewRaw> }
>;
const WebViewComponentTyped = WebView as unknown as WebViewComponent;

/** Dev can point this at a local frontend; production gets the real site. */
const STEEMPRO = process.env.EXPO_PUBLIC_WEB_URL ?? "https://www.steempro.com";
const LAST_URL_KEY = "browser:lastUrl";

/** The frontends this browser ships with. */
const SITES = [
  { name: "SteemPro", url: STEEMPRO, host: hostOf(STEEMPRO) },
  { name: "NFT", url: "https://nft.steempro.com", host: "nft.steempro.com" },
  { name: "SCE", url: "https://sce.steempro.com", host: "sce.steempro.com" },
  { name: "Archers", url: "https://archers.steempro.com", host: "archers.steempro.com" },
];

/** Host for the bar centre without pulling in a URL parser. */
function hostOf(u: string): string {
  return u.replace(/^[a-z]+:\/\//i, "").split(/[/?#]/)[0] ?? u;
}

/**
 * What the address bar accepts: a full URL as typed, or a bare domain
 * (example.com/path -> https://example.com/path). Anything else is refused
 * with a hint rather than silently searching the web.
 */
function normalizeUrl(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return s;
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?([/?#].*)?$/i.test(s)) return `https://${s}`;
  return null;
}

/** Deeplink connect lifecycle shown full-screen over the page. */
type ConnectState =
  | { phase: "confirm"; parsed: SessionQrPayload }
  | { phase: "connecting" }
  | { phase: "connected"; app: string }
  | { phase: "error"; text: string };

/** Site favicon with a letter-tile fallback when the icon cannot load. */
function Favicon({ host }: { host: string }) {
  const theme = useTheme();
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <View style={[styles.favicon, { backgroundColor: theme.colors.primaryContainer }]}>
        <Text variant="labelLarge" style={{ color: theme.colors.onPrimaryContainer, fontWeight: "800" }}>
          {host.replace(/^www\./, "").charAt(0).toUpperCase()}
        </Text>
      </View>
    );
  }
  return (
    <Image
      source={{ uri: `https://icons.duckduckgo.com/ip3/${host}.ico` }}
      style={styles.favicon}
      onError={() => setFailed(true)}
      accessibilityLabel={`${host} icon`}
    />
  );
}

/**
 * In-app browser.
 *
 *  - Start screen: "Continue browsing" (persisted last URL) + the frontend
 *    list with favicons; the address bar takes any URL.
 *  - Browser <-> app: a page fires `steemauth://scan?payload=…` → a
 *    FULL-SCREEN connect modal takes over (connecting → connected → the
 *    request arrives as the approval sheet, full-screen over the page); the
 *    session connects in place and the user never loses their tab.
 *  - Requests that arrive later pop the approval sheet automatically; hidden
 *    once, they collapse to a badge (this screen has no tab bar).
 *  - System back walks the page history first; with no history a DOUBLE
 *    press exits the browser (single press hints).
 *
 * Left bar button is CLOSE (✕), per mobile convention.
 */
export default function BrowserScreen() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const webRef = useRef<WebViewRaw>(null);
  /** null = start screen; set once a site/url is chosen. */
  const [target, setTarget] = useState<string | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [address, setAddress] = useState("");
  const [lastUrl, setLastUrl] = useState<string | null>(null);
  const [canGoBack, setCanGoBack] = useState(false);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  /** Full-screen deeplink connect modal (connecting/connected/error). */
  const [connect, setConnect] = useState<ConnectState | null>(null);
  /** Small neutral pill for hints (back-press, bad URL) — auto-hides. */
  const [hint, setHint] = useState<string | null>(null);
  /** Request id the user chose to hide (collapses to the badge). */
  const [hiddenRequest, setHiddenRequest] = useState<string | null>(null);
  /** The approval sheet (the modal flow — never leaves the page). */
  const [sheetVisible, setSheetVisible] = useState(false);
  /** One auto-open per request id: dismissing it must not re-pop it. */
  const autoOpenedFor = useRef<string | null>(null);
  /** Double-press-back tracking. */
  const lastBackAt = useRef(0);

  // Live approval state — the sheet/badge read straight off the shared session.
  const pending = useAppSelector((s) => s.session.pending);
  const queue = useAppSelector((s) => s.session.queue);
  const sessionApp = useAppSelector((s) => s.session.session?.app ?? null);
  const sessionAlive = useAppSelector((s) => s.session.session !== null);
  const hasRequest =
    useAppSelector((s) => s.session.connection) === "request" && !!pending;
  /** Session-alive baseline for the connect-dialog transition detector. */
  const firstRunRef = useRef(true);
  const hadSessionRef = useRef(false);
  /**
   * The "Connected to <app>" dialog must stay READABLE: a request can land
   * the instant the session connects, and swapping to the sheet in the same
   * breath made the confirmation unreadable ("it hid too fast"). The dialog
   * holds the surface for at least this long before the sheet takes over.
   */
  const CONNECT_MIN_HOLD_MS = 2500;
  const connectedAtRef = useRef(0);
  /** Bumped by the deferred hold timer so the auto-open effect re-runs. */
  const [connectHoldTick, setConnectHoldTick] = useState(0);

  /**
   * Enter the "connected" phase — stamped so the auto-open effect can hold
   * the dialog for CONNECT_MIN_HOLD_MS before a request sheet takes over.
   * Stable (no deps): safe to reference from every effect below.
   */
  const showConnected = useCallback((app: string) => {
    connectedAtRef.current = Date.now();
    setConnect({ phase: "connected", app });
  }, []);

  // Where the user left off - read once on mount for the Continue card.
  useEffect(() => {
    AsyncStorage.getItem(LAST_URL_KEY)
      .then((v) => setLastUrl(v))
      .catch(() => {});
  }, []);

  // Keep the address field in step with real navigation (url only changes
  // on navigation, so typing is never clobbered mid-keystroke).
  useEffect(() => {
    // Deferred a tick: the rule forbids synchronous setState in an effect
    // body; url only changes on navigation, so this never races typing.
    const id = setTimeout(() => setAddress(url ?? ""), 0);
    return () => clearTimeout(id);
  }, [url]);

  // Hint pill auto-hides.
  useEffect(() => {
    if (!hint) return;
    const t = setTimeout(() => setHint(null), 2600);
    return () => clearTimeout(t);
  }, [hint]);

  const persistUrl = useCallback((u: string) => {
    if (/^https?:\/\//i.test(u)) {
      void AsyncStorage.setItem(LAST_URL_KEY, u).catch(() => {});
    }
  }, []);

  const open = (u: string) => {
    Keyboard.dismiss();
    setTarget(u);
    setUrl(u);
    setLoading(true);
    persistUrl(u);
  };

  /**
   * Close the BROWSING view back to this screen's own start page (address
   * bar + shortcuts). The route itself only leaves from the start screen, so
   * closing a page never dumps the user on Home.
   */
  const closePage = useCallback(() => {
    setTarget(null);
    setUrl(null);
    setAddress("");
    setLoading(false);
    setRefreshing(false);
    setCanGoBack(false);
  }, []);

  const submitAddress = () => {
    // An empty field blur is not a navigation attempt - stay silent.
    if (!address.trim()) return;
    const normalized = normalizeUrl(address);
    if (!normalized) {
      setHint("That doesn't look like a URL — try example.com");
      return;
    }
    open(normalized);
  };

  // A request that lands while browsing presents ITSELF as the full-screen
  // sheet — the user never gets shipped off the page. Dismissing keeps the
  // popover/badge as the way back (per request id, so it never re-pops).
  useEffect(() => {
    if (hasRequest && pending && autoOpenedFor.current !== pending.requestId) {
      // A request can arrive WHILE the "Connected to <app>" dialog is up —
      // it holds the surface for at least CONNECT_MIN_HOLD_MS first, then a
      // tick bump re-runs this effect and the sheet takes over.
      if (connect?.phase === "connected") {
        const remain = CONNECT_MIN_HOLD_MS - (Date.now() - connectedAtRef.current);
        if (remain > 0) {
          const t = setTimeout(() => setConnectHoldTick((n) => n + 1), remain);
          return () => clearTimeout(t);
        }
      }
      autoOpenedFor.current = pending.requestId;
      setHiddenRequest(null);
      setConnect(null);
      setSheetVisible(true);
    }
  }, [hasRequest, pending, connect, connectHoldTick]);

  /**
   * OS-routed deeplinks (Android never delivers custom schemes to the
   * webview): /scan connects and pops straight back here — so a session that
   * APPEARS while this screen is open gets the same persistent full-screen
   * connect dialog: no flash, and it stays until the request arrives (the
   * auto-open effect above takes the surface) or the user closes it.
   * Entering the browser with an already-live session is NOT a transition
   * (no dialog) — only idle → live while on-screen shows it.
   */
  useEffect(() => {
    if (firstRunRef.current) {
      firstRunRef.current = false;
      hadSessionRef.current = sessionAlive; // mount baseline, never pops
      return;
    }
    if (sessionAlive && !hadSessionRef.current && !connect) {
      showConnected(sessionApp ?? "the app");
    }
    hadSessionRef.current = sessionAlive;
  }, [sessionAlive, sessionApp, connect, showConnected]);

  // Android hardware back: page history first; then a DOUBLE press closes
  // the BROWSING view back to this screen's own start page. Only FROM the
  // start screen does the second press let the route close (exit the
  // browser) - closing a page must never land the user on Home. The first
  // press only hints; accidental backs are the classic way to lose a
  // browsing session.
  useEffect(() => {
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      if (canGoBack && webRef.current) {
        webRef.current.goBack();
        return true;
      }
      const now = Date.now();
      if (now - lastBackAt.current < 2000) {
        if (target) {
          closePage(); // second press with a page open -> start screen
          return true;
        }
        return false; // second press on the start screen -> route closes
      }
      lastBackAt.current = now;
      setHint(
        target
          ? "Press back again to close the page"
          : "Press back again to close the browser",
      );
      return true; // consume the first press
    });
    return () => sub.remove();
  }, [canGoBack, target, closePage]);

  /**
   * Connect from a serialized QR payload — the ONE connect path shared by
   * both handoff transports: the WebView bridge message (in-app pages) and
   * the steemauth:// scheme intercept (external browsers). Identical
   * validation to a camera scan (expiry, clock skew, relay endpoint,
   * blocklist, target account).
   */
  const connectFromPayload = (qrString: string, fromPageUrl?: string): void => {
    try {
      const parsed = parseSessionQr(qrString);
      // NO-CONSENT CONNECT (confirmed finding): a bridge message can come from
      // ANY page — or iframe/ad — the user happens to have open, and the
      // scheme intercept from any page that fires the URL. Connecting
      // immediately let either replace a live session, wipe its pending
      // queue, and announce the account BEFORE any user-visible step.
      // Validate, then STOP at an explicit consent dialog showing who is
      // asking (claimed origin) and which account it targets.
      //
      // UNAUTHENTICATED SRC (confirmed finding): for the bridge leg the
      // WebView itself attests the poster — stamp the payload's src with the
      // REAL origin of the page currently loaded (the only principal this
      // WebView can know), so the dialog, blocklist and registry key on our
      // observation instead of the payload's claim. The scheme path cannot
      // be stamped (external browser) and stays "claimed".
      let stamped: SessionQrPayload = parsed;
      if (fromPageUrl) {
        const origin = normalizeOrigin(fromPageUrl);
        if (origin) stamped = { ...parsed, src: origin };
      }
      setConnect({ phase: "confirm", parsed: stamped });
    } catch (e) {
      console.warn(
        "[steemauth] handoff rejected:",
        e instanceof Error ? e.message : e,
      );
      setConnect({
        phase: "error",
        text: e instanceof Error ? e.message : "Invalid session link.",
      });
    }
  };

  /** The user pressed Connect on the confirm dialog — now open the transport. */
  const proceedConnect = (parsed: SessionQrPayload): void => {
    setConnect({ phase: "connecting" });
    try {
      // "Connected" only after the relay room has ACTUALLY joined -
      // with a 6s fallback so a relay blip never strands the dialog on
      // "Connecting...". Then it stays until the request arrives (the sheet
      // takes the screen over) or the user closes it. No timed flashing.
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        console.info("[steemauth] browser connected in place to", parsed.app);
        showConnected(parsed.app);
      };
      const fallback = setTimeout(settle, 6000);
      const denial = connectSession(parsed, {
        onSubscribed: () => {
          clearTimeout(fallback);
          settle();
        },
      });
      if (denial) {
        clearTimeout(fallback);
        console.warn("[steemauth] browser connect refused:", denial);
        setConnect({ phase: "error", text: denial });
      }
    } catch (e) {
      setConnect({
        phase: "error",
        text: e instanceof Error ? e.message : "Invalid session link.",
      });
    }
  };

  /**
   * In-app bridge handoff (the PRIMARY transport — @steempro/steemauth-qr's
   * handoffToSteemAuthenticator): pages running in this app's WebView detect
   * `window.ReactNativeWebView` and post
   *   { t: HANDOFF_TYPE, c: "<serializedQrPayload>" }
   * instead of firing the steemauth:// OS intent. One process, one surface,
   * zero route transit — the intent path bounced through /scan and flashed.
   * Strictly validated; anything else a page posts is ignored.
   */
  const handleBridgeMessage = (raw: string): void => {
    let msg: { t?: unknown; c?: unknown } | null = null;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === "object" && parsed !== null) {
        msg = parsed as { t?: unknown; c?: unknown };
      }
    } catch {
      return; // not JSON — some site posting its own messages, not ours
    }
    if (msg?.t !== HANDOFF_TYPE) return;
    if (typeof msg.c !== "string" || !msg.c) return;
    // Pass the WebView's CURRENT page URL: it becomes the payload's verified
    // src (the bridge leg's origin stamp) and lands in the consent dialog.
    connectFromPayload(msg.c, url ?? undefined);
  };

  const handleRequest = (nextUrl: string): boolean => {
    if (nextUrl.startsWith("steemauth://")) {
      // Scheme fallback (external mobile browsers, or any page not using the
      // bridge): FULL-SCREEN connect flow, session connects in place — the
      // user never leaves their tab.
      const query = nextUrl.split("?")[1] ?? "";
      const match = /(?:^|&)payload=([^&]*)/.exec(query);
      if (!match) {
        setConnect({ phase: "error", text: "No session payload in the link." });
        return false;
      }
      connectFromPayload(decodeURIComponent(match[1]));
      return false; // never let the scheme load inside the webview
    }
    if (!/^https?:\/\//i.test(nextUrl)) {
      void Linking.openURL(nextUrl).catch(() => {});
      return false;
    }
    return true; // normal navigation stays in-app
  };

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    webRef.current?.reload();
  }, []);

  const close = () => {
    // With a page open, X closes the BROWSING view back to the browser's own
    // start page; the route only leaves (to wherever pushed us) from there.
    if (target) {
      closePage();
      return;
    }
    if (router.canGoBack()) router.back();
    else router.replace("/");
  };

  const barTitle = target ? hostOf(url ?? target) : "Browser";
  const barSubtitle = target && url && url !== target ? url : null;

  const requestSummary = !pending
    ? ""
    : pending.sign
      ? pending.action === "authenticate"
        ? "Wants to sign you in — nothing is broadcast"
        : "Signature request — nothing is broadcast"
      : pending.decoded.map((d) => d.title).join(", ") || "Action request";

  const popoverVisible =
    !sheetVisible && !connect && hasRequest && !!pending && hiddenRequest !== pending.requestId;
  const badgeVisible =
    !sheetVisible && hasRequest && !!pending && hiddenRequest === pending.requestId;
  /** Below the status bar + the 56dp app bar (absolute ignores our padding). */
  const popoverTop = insets.top + 62;

  const webview = target ? (
    <WebViewComponentTyped
      ref={webRef}
      source={{ uri: target }}
      onShouldStartLoadWithRequest={(req: { url: string }) => handleRequest(req.url)}
      // In-app handoff bridge: the page posts { t: HANDOFF_TYPE, c: payload }
      // (see handleBridgeMessage) — connects in place, no intent, no transit.
      onMessage={(e: { nativeEvent: { data: string } }) => handleBridgeMessage(e.nativeEvent.data)}
      onNavigationStateChange={(nav: { url: string; canGoBack: boolean; loading: boolean }) => {
        setUrl(nav.url);
        setCanGoBack(nav.canGoBack);
        // Authoritative flag: onLoadStart/onLoadEnd miss some navigations
        // (redirects, same-document loads), which is what left the bar stuck
        // on "loading" after the page was already up.
        if (!nav.loading) setLoading(false);
        persistUrl(nav.url);
      }}
      onLoadStart={() => setLoading(true)}
      onLoad={() => setLoading(false)}
      onLoadEnd={() => {
        setLoading(false);
        setRefreshing(false);
      }}
      // Android gets the native swipe-to-refresh; iOS is wrapped below.
      pullToRefreshEnabled={Platform.OS === "android"}
      thirdPartyCookiesEnabled
      domStorageEnabled
      startInLoadingState={false}
      style={{ backgroundColor: theme.colors.background }}
    />
  ) : null;

  return (
    <SafeAreaView
      edges={["top"]}
      style={[
        styles.safe,
        {
          backgroundColor: theme.colors.background,
          paddingBottom: systemClearance(insets.bottom),
        },
      ]}
    >
      <Appbar.Header
        mode="small"
        statusBarHeight={0}
        style={{ backgroundColor: theme.colors.background }}
      >
        {/* Close: a page closes to the start screen; from the start screen the
            route pops. System back walks page history first. */}
        <Appbar.Action
          icon={({ size, color }) => <X size={size - 4} color={color} />}
          onPress={close}
          accessibilityLabel="Close browser"
        />
        <Appbar.Content
          title={barTitle}
          subtitle={barSubtitle && barSubtitle.length > 46 ? barSubtitle.slice(0, 45) + "…" : barSubtitle ?? undefined}
          titleStyle={{ fontWeight: "800" }}
        />
        {target ? (
          <Appbar.Action
            icon={({ size, color }) => <RotateCw size={size - 4} color={color} />}
            onPress={() => webRef.current?.reload()}
            accessibilityLabel="Reload"
          />
        ) : null}
        <Appbar.Action
          icon={({ size, color }) => <ScanLine size={size - 4} color={color} />}
          onPress={() => router.push("/scan")}
          accessibilityLabel="Scan QR"
        />
      </Appbar.Header>

      {loading ? <ProgressBar indeterminate color={theme.colors.primary} /> : <View style={styles.progressSpacer} />}

      {/* Address bar lives ONLY on the start screen: manual entry is a
          home-screen affordance; picking a shortcut (or typing) starts
          browsing with just the top bar visible. */}
      {!target ? (
        <View style={[styles.addrRow, { borderBottomColor: theme.colors.outlineVariant }]}>
          <Globe size={16} color={theme.colors.onSurfaceVariant} />
          <TextInput
            value={address}
            onChangeText={setAddress}
            onSubmitEditing={submitAddress}
            onBlur={submitAddress}
            placeholder="Enter a URL — example.com"
            placeholderTextColor={theme.colors.onSurfaceVariant}
            keyboardType="url"
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="go"
            selectionColor={theme.colors.primary}
            accessibilityLabel="Address bar"
            style={[styles.addrInput, { color: theme.colors.onSurface, backgroundColor: theme.colors.surfaceVariant }]}
          />
          <Pressable onPress={submitAddress} hitSlop={8} accessibilityRole="button" accessibilityLabel="Go">
            <ChevronRight size={18} color={theme.colors.primary} />
          </Pressable>
        </View>
      ) : null}

      {/* ---------------- start screen ---------------- */}
      {!target ? (
        <ScrollView
          style={styles.fill}
          contentContainerStyle={styles.home}
          showsVerticalScrollIndicator={false}
        >
          {lastUrl ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Continue browsing ${lastUrl}`}
              onPress={() => open(lastUrl)}
              style={({ pressed }) => [
                styles.row,
                {
                  borderColor: theme.colors.primary,
                  backgroundColor: pressed
                    ? theme.colors.surfaceVariant
                    : theme.colors.surface,
                },
              ]}
            >
              <View style={[styles.rowIcon, { backgroundColor: theme.colors.primaryContainer }]}>
                <History size={18} color={theme.colors.onPrimaryContainer} />
              </View>
              <View style={styles.rowBody}>
                <Text variant="titleSmall" style={{ color: theme.colors.onSurface, fontWeight: "700" }}>
                  Continue browsing
                </Text>
                <Text variant="bodySmall" numberOfLines={1} style={{ color: theme.colors.onSurfaceVariant }}>
                  {lastUrl}
                </Text>
              </View>
              <ChevronRight size={18} color={theme.colors.onSurfaceVariant} />
            </Pressable>
          ) : null}

          <Text
            variant="labelLarge"
            style={{
              color: theme.colors.onSurfaceVariant,
              fontWeight: "700",
              marginTop: lastUrl ? 14 : 4,
            }}
          >
            Sites
          </Text>

          {SITES.map((site) => (
            <Pressable
              key={site.url}
              accessibilityRole="button"
              accessibilityLabel={`Open ${site.name}`}
              onPress={() => open(site.url)}
              style={({ pressed }) => [
                styles.row,
                {
                  borderColor: theme.colors.outlineVariant,
                  backgroundColor: pressed
                    ? theme.colors.surfaceVariant
                    : theme.colors.surface,
                },
              ]}
            >
              <Favicon host={site.host} />
              <View style={styles.rowBody}>
                <Text variant="titleSmall" style={{ color: theme.colors.onSurface, fontWeight: "700" }}>
                  {site.name}
                </Text>
                <Text variant="bodySmall" numberOfLines={1} style={{ color: theme.colors.onSurfaceVariant }}>
                  {site.host}
                </Text>
              </View>
              <ChevronRight size={18} color={theme.colors.onSurfaceVariant} />
            </Pressable>
          ))}
        </ScrollView>
      ) : Platform.OS === "ios" ? (
        // iOS has no native swipe-refresh for webview content: the classic
        // outer-ScrollView + RefreshControl wrapper (content is exactly one
        // screen tall, so only the pull gesture can ever trigger it).
        <ScrollView
          style={styles.fill}
          contentContainerStyle={styles.fill}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              colors={[theme.colors.primary]}
              tintColor={theme.colors.primary}
            />
          }
        >
          {webview}
        </ScrollView>
      ) : (
        webview
      )}

      {/* ---------------- full-screen connect modal ---------------- */}
      <Modal
        visible={connect !== null}
        onDismiss={() => setConnect(null)}
        contentContainerStyle={[
          styles.connectFull,
          { backgroundColor: theme.colors.background },
        ]}
      >
        <View style={styles.connectInner}>
          {connect?.phase === "confirm" ? (
            <>
              <View style={[styles.connectIcon, { backgroundColor: theme.colors.primaryContainer }]}>
                <Link2 size={36} color={theme.colors.primary} />
              </View>
              <Text variant="titleLarge" style={{ fontWeight: "800", textAlign: "center" }}>
                {connect.parsed.app} wants to connect
              </Text>
              <Text variant="bodyMedium" style={{ color: theme.colors.onSurface, textAlign: "center", fontWeight: "600" }}>
                {appOrigin(connect.parsed) || "This request declares no origin"}
                {" "}
                (declared in the QR)
              </Text>
              <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant, textAlign: "center" }}>
                Target: {connect.parsed.account ? `@${connect.parsed.account}` : "any account on this device"}
                {"\n"}
                Connecting opens a session channel and announces your active
                account to this app. Nothing is signed until you approve a
                request.
              </Text>
              <View style={{ flexDirection: "row", gap: 10, marginTop: 14 }}>
                <Button mode="contained" onPress={() => proceedConnect(connect.parsed)}>
                  Connect
                </Button>
                <Button mode="outlined" onPress={() => setConnect(null)}>
                  Not now
                </Button>
              </View>
            </>
          ) : connect?.phase === "connecting" ? (
            <>
              <ActivityIndicator size="large" color={theme.colors.primary} />
              <Text variant="titleMedium" style={{ fontWeight: "700", marginTop: 18 }}>
                Connecting…
              </Text>
              <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant, textAlign: "center" }}>
                Handing the session to SteemAuthenticator — you can keep
                browsing once it lands.
              </Text>
            </>
          ) : connect?.phase === "connected" ? (
            <>
              <View style={[styles.connectIcon, { backgroundColor: theme.colors.primaryContainer }]}>
                <CheckCircle2 size={44} color={theme.colors.primary} />
              </View>
              <Text variant="titleLarge" style={{ fontWeight: "800", textAlign: "center" }}>
                Connected to {connect.app}
              </Text>
              <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant, textAlign: "center" }}>
                Approve requests right here — they pop up over this page and
                never take you away from it.
              </Text>
              <Button mode="contained" onPress={() => setConnect(null)} style={{ marginTop: 10 }}>
                Back to browsing
              </Button>
            </>
          ) : connect?.phase === "error" ? (
            <>
              <View style={[styles.connectIcon, { backgroundColor: theme.colors.errorContainer }]}>
                <X size={40} color={theme.colors.onErrorContainer} />
              </View>
              <Text variant="titleMedium" style={{ fontWeight: "700", textAlign: "center", color: theme.colors.error }}>
                Could not connect
              </Text>
              <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant, textAlign: "center" }}>
                {"text" in (connect ?? {}) ? connect.text : ""}
              </Text>
              <Button mode="contained" onPress={() => setConnect(null)} style={{ marginTop: 10 }}>
                Close
              </Button>
            </>
          ) : null}
        </View>
      </Modal>

      {/* ---------------- neutral hint pill ---------------- */}
      {hint && !popoverVisible && !connect ? (
        <Animated.View
          entering={FadeIn.duration(220)}
          style={[
            styles.handoff,
            {
              top: popoverTop,
              backgroundColor: theme.colors.surfaceVariant,
              borderWidth: 1,
              borderColor: theme.colors.outlineVariant,
            },
          ]}
          accessibilityRole="alert"
        >
          <Pressable
            onPress={() => setHint(null)}
            accessibilityRole="button"
            accessibilityLabel="Dismiss"
          >
            <Text variant="bodySmall" style={{ color: theme.colors.onSurface, fontWeight: "600" }}>
              {hint}
            </Text>
          </Pressable>
        </Animated.View>
      ) : null}

      {/* ---------------- approval request popover ---------------- */}
      {popoverVisible && pending ? (
        <Animated.View
          entering={SlideInDown.springify().damping(18)}
          style={[styles.popover, { top: popoverTop }]}
          accessibilityRole="alert"
        >
          <View
            style={[
              styles.popoverCard,
              { backgroundColor: theme.colors.surface, borderColor: theme.colors.primary },
            ]}
          >
            <View style={styles.popRow}>
              <View style={[styles.popDot, { backgroundColor: theme.colors.primary }]} />
              <Text
                variant="labelLarge"
                style={{ color: theme.colors.primary, fontWeight: "800", flex: 1 }}
              >
                Approval request{queue.length > 1 ? ` · ${queue.length} waiting` : ""}
              </Text>
              <Pressable
                onPress={() => setHiddenRequest(pending.requestId)}
                hitSlop={10}
                accessibilityRole="button"
                accessibilityLabel="Hide for now"
              >
                <X size={18} color={theme.colors.onSurfaceVariant} />
              </Pressable>
            </View>
            <Text
              variant="titleSmall"
              numberOfLines={1}
              style={{ color: theme.colors.onSurface, fontWeight: "700" }}
            >
              {sessionApp ? `${sessionApp} wants your approval` : "Approval requested"}
            </Text>
            <Text variant="bodySmall" numberOfLines={2} style={{ color: theme.colors.onSurfaceVariant }}>
              {requestSummary}
            </Text>
            <Button
              mode="contained"
              compact
              onPress={() => setSheetVisible(true)}
            >
              Review &amp; approve
            </Button>
          </View>
        </Animated.View>
      ) : null}

      {/* Hidden-to-badge: this screen has no tab bar, so the badge is the
          only way back to a request the user dismissed. */}
      {badgeVisible && pending ? (
        <Animated.View
          entering={FadeIn.duration(200)}
          style={[styles.badge, { bottom: systemClearance(insets.bottom) + 16 }]}
        >
          <Pressable
            onPress={() => {
              setHiddenRequest(null);
              setSheetVisible(true);
            }}
            accessibilityRole="button"
            accessibilityLabel="Review the waiting approval request"
            style={[styles.badgePill, { backgroundColor: theme.colors.primaryContainer }]}
          >
            <Text
              variant="labelSmall"
              style={{ color: theme.colors.onPrimaryContainer, fontWeight: "800" }}
            >
              {queue.length > 1 ? `${queue.length} requests waiting` : "1 request waiting"} · Review
            </Text>
          </Pressable>
        </Animated.View>
      ) : null}

      {/* The approval decision, in-place: same hook/PIN/broadcast as the
          /session screen, so the page underneath keeps its context. */}
      <ApprovalSheet
        visible={sheetVisible}
        onDismiss={() => setSheetVisible(false)}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  fill: { flex: 1 },
  progressSpacer: { height: 4 },
  addrRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  addrInput: {
    flex: 1,
    fontSize: 14,
    paddingVertical: 7,
    paddingHorizontal: 12,
    borderRadius: 999,
  },
  home: { padding: 16, gap: 10 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 14,
    borderWidth: 1,
    borderRadius: radii.lg,
  },
  rowBody: { flex: 1, gap: 1 },
  rowIcon: {
    width: 36,
    height: 36,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  favicon: { width: 36, height: 36, borderRadius: 10 },
  connectFull: {
    margin: 0,
    borderRadius: 0,
    height: "100%",
    maxHeight: "100%",
    padding: 28,
    justifyContent: "center",
  },
  connectInner: { alignItems: "center", gap: 10 },
  connectIcon: {
    width: 84,
    height: 84,
    borderRadius: 26,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 6,
  },
  handoff: {
    position: "absolute",
    left: 12,
    right: 12,
    zIndex: 20,
    elevation: 8,
    borderRadius: radii.md,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  popover: {
    position: "absolute",
    left: 12,
    right: 12,
    zIndex: 30,
    elevation: 10,
  },
  popoverCard: {
    borderWidth: 1.5,
    borderRadius: radii.lg,
    padding: 14,
    gap: 6,
    shadowColor: "#000",
    shadowOpacity: 0.25,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
  },
  popRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  popDot: { width: 10, height: 10, borderRadius: 5 },
  badge: {
    position: "absolute",
    right: 16,
    zIndex: 25,
    elevation: 9,
  },
  badgePill: {
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 999,
    shadowColor: "#000",
    shadowOpacity: 0.25,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
  },
});
