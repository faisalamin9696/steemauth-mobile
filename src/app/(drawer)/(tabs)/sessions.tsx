import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  RefreshControl,
  ScrollView,
  StyleSheet,
  View,
} from "react-native";
import { Button, Card, Chip, Text, useTheme } from "react-native-paper";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import {
  Globe,
  Trash2,
  ShieldAlert,
  Link2Off,
  Clock,
  Cloud,
  CloudOff,
  Smartphone,
  Ban,
  ShieldOff,
} from "lucide-react-native";
import { ScreenHeader } from "@/components/ScreenHeader";
import { AccountAvatar } from "@/components/AccountAvatar";
import { paletteFor, radii, tabClearance } from "@/components/theme";
import { useAppDispatch, useAppSelector } from "@/store/hooks";
import { revokeConnectedApp, terminateSessionForOrigin } from "@/lib/sessionManager";
import { appOrigin } from "@/lib/protocol";
import {
  blockOrigin,
  unblockOrigin,
  normalizeOrigin,
} from "@/store/blockedOriginsSlice";
import {
  pullSessions,
  revokeSession,
  sessionSyncConfigured,
  type CloudSession,
} from "@/lib/sessionsStore";
import { hapticMedium, hapticError, hapticLight } from "@/lib/haptics";

function timeAgo(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** A row the tab renders — the union of the local registry + the cloud table. */
interface DisplaySession {
  key: string;
  appName: string;
  /** null when the session only exists in the cloud (another device). */
  url: string | null;
  account: string;
  at: number;
  sid: string | null;
  status: "active" | "revoked" | "expired" | "unregistered";
  /** true when this device currently holds the live transport for it */
  live: boolean;
  /** local registry id — revoke through revokeConnectedApp when set */
  localId: string | null;
  /** approved on another device (cloud row with no local registry entry) */
  remote: boolean;
}

export default function ConnectedAppsScreen() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const palette = paletteFor(theme);
  const dispatch = useAppDispatch();
  const apps = useAppSelector((s) => s.connectedApps.apps);
  const blocked = useAppSelector((s) => s.blockedOrigins.origins);
  const session = useAppSelector((s) => s.session.session);
  const connection = useAppSelector((s) => s.session.connection);
  const [snack, setSnack] = useState<string | null>(null);
  const [cloud, setCloud] = useState<CloudSession[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [synced, setSynced] = useState(() => sessionSyncConfigured());

  /** Is this row's origin on the blocklist? Empty origin → never blocked. */
  const isBlockedUrl = (url: string | null): boolean => {
    if (!url) return false;
    const n = normalizeOrigin(url);
    return n !== "" && blocked.includes(n);
  };

  const isLive = useCallback(
    (app: { app: string; url: string }) =>
      !!session &&
      session.app === app.app &&
      // Same preference as markAppConnected: verified `src` over `url`.
      appOrigin(session) === app.url &&
      (connection === "waiting" || connection === "request" || connection === "sending"),
    [session, connection],
  );

  /**
   * Pull the sessions table. The cloud row is the authoritative lifecycle
   * (active / revoked / expired); the local registry supplies the origin and
   * the per-device revoke control that the table deliberately does not store.
   */
  const sync = useCallback(async () => {
    if (!sessionSyncConfigured()) {
      setSynced(false);
      return;
    }
    setRefreshing(true);
    try {
      const remote = await pullSessions(100);
      setCloud(remote);
      setSynced(true);
    } finally {
      setRefreshing(false);
    }
  }, []);

  // Yield a tick so setRefreshing runs in an async continuation, not
  // synchronously inside the effect body (React Compiler rule).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await Promise.resolve();
      if (!cancelled) await sync();
    })();
    return () => {
      cancelled = true;
    };
  }, [sync]);

  const cloudBySid = new Map(cloud.map((c) => [c.sid, c]));
  const claimedSids = new Set(
    apps.map((a) => a.lastSid).filter((s): s is string => !!s),
  );

  const rows: DisplaySession[] = (() => {
    // 1. Local registry — enrich each with the cloud lifecycle for its sid.
    const list: DisplaySession[] = apps.map((a) => {
      const c = a.lastSid ? cloudBySid.get(a.lastSid) : undefined;
      const live = isLive(a);
      // A row that was never registered (a plain broadcast approval, not an
      // authenticate) stays "unregistered" — real, but with no cloud record.
      const status = c ? c.status : live ? "active" : "unregistered";
      return {
        key: a.id,
        appName: a.app,
        url: a.url || null,
        account: a.account,
        at: a.lastConnectedAt,
        sid: a.lastSid || null,
        status,
        live,
        localId: a.id,
        remote: false,
      };
    });

    // 2. Cloud-only active sessions — approved on another device, or an app
    //    this device has never seen. They only exist in the sessions table.
    for (const c of cloud) {
      if (c.status !== "active") continue;
      if (claimedSids.has(c.sid)) continue;
      list.push({
        key: `cloud:${c.sid}`,
        appName: c.appName,
        url: null,
        account: c.account,
        at: c.createdAt,
        sid: c.sid,
        status: "active",
        live: false,
        localId: null,
        remote: true,
      });
    }

    list.sort((a, b) => b.at - a.at);
    return list;
  })();

  const activeCount = rows.filter((r) => r.status === "active").length;

  const confirmRevoke = useCallback(
    (row: DisplaySession) => {
      const doRevoke = () => {
        if (row.localId) {
          // Tears the live transport, drops the local row, revokes the cloud
          // row by sid — all in one call.
          const torn = revokeConnectedApp(row.localId);
          void (torn ? hapticError() : hapticMedium());
          setSnack(
            torn
              ? `${row.appName} revoked — its session was ended.`
              : `${row.appName} revoked.`,
          );
        } else if (row.sid) {
          // Cloud-only: no local transport to tear down, but the durable row
          // must be marked revoked so the other device learns it was kicked.
          void revokeSession(row.sid, "Revoked in the authenticator.");
          setCloud((prev) =>
            prev.map((c) =>
              c.sid === row.sid
                ? { ...c, status: "revoked" as const, revokedAt: Date.now() }
                : c,
            ),
          );
          void hapticMedium();
          setSnack(`${row.appName} revoked.`);
        }
      };

      if (row.live || row.status === "active") {
        Alert.alert(
          `Revoke ${row.appName}?`,
          "This app holds an active session. Revoking ends the session immediately and marks it revoked in the cloud — the app will need you to scan a new QR to reconnect.",
          [
            { text: "Cancel", style: "cancel" },
            { text: "Revoke", style: "destructive", onPress: doRevoke },
          ],
        );
      } else {
        doRevoke();
      }
    },
    [],
  );

  /**
   * Block the verified origin of a row. Blocking is device-local policy:
   * future QR codes from it are refused BEFORE any transport opens, and any
   * live session it currently holds is torn down too.
   */
  const confirmBlock = useCallback(
    (row: DisplaySession) => {
      if (!row.url) return; // cloud-only rows carry no origin to block
      const origin = normalizeOrigin(row.url);
      if (!origin) return;

      const doBlock = () => {
        dispatch(blockOrigin(origin));
        const terminated = terminateSessionForOrigin(origin);
        void hapticError();
        setSnack(
          terminated
            ? `${origin} blocked — its live session was ended.`
            : `${origin} blocked. Future QR codes from it are refused.`,
        );
      };

      Alert.alert(
        `Block ${origin}?`,
        "SteemAuth will refuse future QR codes from this origin before any connection is opened. If it holds a live session right now, that session is ended too. You can unblock from this screen at any time.",
        [
          { text: "Cancel", style: "cancel" },
          { text: "Block origin", style: "destructive", onPress: doBlock },
        ],
      );
    },
    [dispatch],
  );

  const statusChip = (row: DisplaySession) => {
    switch (row.status) {
      case "active":
        return (
          <View style={[styles.liveChip, { backgroundColor: palette.successContainer }]}>
            <View style={[styles.liveDot, { backgroundColor: palette.success }]} />
            <Text variant="labelSmall" style={{ color: palette.onSuccessContainer, fontWeight: "700" }}>
              Active
            </Text>
          </View>
        );
      case "revoked":
        return (
          <Chip compact mode="flat" style={{ backgroundColor: theme.colors.errorContainer }} textStyle={{ color: theme.colors.onErrorContainer, fontWeight: "700" }}>
            Revoked
          </Chip>
        );
      case "expired":
        return (
          <Chip compact mode="flat" style={{ backgroundColor: theme.colors.surfaceVariant }} textStyle={{ color: theme.colors.onSurfaceVariant, fontWeight: "700" }}>
            Expired
          </Chip>
        );
      default:
        return null;
    }
  };

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: theme.colors.background }]} edges={["top"]}>
      <ScreenHeader
        title="Sessions"
        subtitle={
          rows.length
            ? `${activeCount} active · ${rows.length} total`
            : "Apps you've approved via QR"
        }
      />

      <View style={styles.filters}>
        <Chip
          icon={({ size, color }) =>
            synced ? <Cloud size={size - 4} color={color} /> : <CloudOff size={size - 4} color={color} />
          }
          onPress={() => {
            void hapticLight();
            void sync();
          }}
        >
          {synced ? "Synced" : "Local only"}
        </Chip>
        <View style={{ flex: 1 }} />
        <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>
          {activeCount} active session{activeCount === 1 ? "" : "s"}
        </Text>
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={() => void sync()} />
        }
      >
        {rows.length === 0 ? (
          <View style={styles.empty}>
            <Globe size={44} color={theme.colors.outline} />
            <Text variant="titleMedium" style={{ color: theme.colors.onSurface }}>
              No sessions yet
            </Text>
            <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant, textAlign: "center" }}>
              {synced
                ? "Apps you scan a QR from show up here, synced across your devices. Revoke one at any time to end its access."
                : "Apps you scan a QR from show up here. Revoke one at any time to end its access — an active session is torn down immediately."}
            </Text>
          </View>
        ) : (
          <>
            <View style={[styles.notice, { backgroundColor: theme.colors.surfaceVariant }]}>
              <ShieldAlert size={16} color={theme.colors.onSurfaceVariant} />
              <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, flex: 1 }}>
                Revoking an app ends its live session and marks it revoked in
                the cloud, so it is kicked even on devices you are not holding.
                It can reconnect only by scanning a new QR.
              </Text>
            </View>

            {rows.map((row) => (
              <Card key={row.key} mode="outlined" style={styles.card}>
                <Card.Title
                  title={row.appName}
                  titleVariant="titleMedium"
                  titleStyle={{ color: theme.colors.onSurface, fontWeight: "700" }}
                  subtitle={row.url ?? "from another device"}
                  subtitleStyle={{ color: theme.colors.onSurfaceVariant }}
                  // Origins are long and unbroken — one line keeps the card
                  // height stable (the full URL stays reachable via the row's
                  // open action).
                  subtitleNumberOfLines={1}
                  left={() =>
                    row.account && row.account !== "unknown" ? (
                      <AccountAvatar account={row.account} size={40} />
                    ) : (
                      <View style={[styles.appIcon, { backgroundColor: theme.colors.primaryContainer }]}>
                        {row.remote ? (
                          <Smartphone size={18} color={theme.colors.onPrimaryContainer} />
                        ) : (
                          <Globe size={18} color={theme.colors.onPrimaryContainer} />
                        )}
                      </View>
                    )
                  }
                  right={() => (
                    <View style={styles.rowActions}>
                      {row.url && !isBlockedUrl(row.url) ? (
                        <Button
                          mode="text"
                          compact
                          textColor={theme.colors.primary}
                          onPress={() => confirmBlock(row)}
                          icon={({ size, color }) => <Ban size={size - 4} color={color} />}
                          style={{ marginRight: 4 }}
                        >
                          Block
                        </Button>
                      ) : null}
                      <Button
                        mode="text"
                        compact
                        textColor={theme.colors.error}
                        onPress={() => confirmRevoke(row)}
                        icon={({ size, color }) => <Trash2 size={size - 4} color={color} />}
                        style={{ marginRight: 8 }}
                      >
                        Revoke
                      </Button>
                    </View>
                  )}
                />
                <Card.Content style={styles.cardContent}>
                  <View style={styles.metaRow}>
                    {statusChip(row)}
                    {isBlockedUrl(row.url) ? (
                      <Chip
                        compact
                        mode="flat"
                        icon={({ size, color }) => <Ban size={size - 4} color={color} />}
                        style={{ backgroundColor: theme.colors.errorContainer }}
                        textStyle={{ color: theme.colors.onErrorContainer, fontWeight: "700" }}
                      >
                        Blocked
                      </Chip>
                    ) : null}
                    {row.live ? (
                      <View style={[styles.liveChip, { backgroundColor: theme.colors.primaryContainer }]}>
                        <View style={[styles.liveDot, { backgroundColor: theme.colors.primary }]} />
                        <Text variant="labelSmall" style={{ color: theme.colors.onPrimaryContainer, fontWeight: "700" }}>
                          This device
                        </Text>
                      </View>
                    ) : null}
                    <View style={styles.metaItem}>
                      <Clock size={12} color={theme.colors.onSurfaceVariant} />
                      <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>
                        {timeAgo(row.at)}
                      </Text>
                    </View>
                    {row.account && row.account !== "unknown" ? (
                      <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>
                        · @{row.account}
                      </Text>
                    ) : null}
                  </View>
                </Card.Content>
              </Card>
            ))}
          </>
        )}

        {/* Blocked origins — the device-local blocklist, managed here. */}
        {blocked.length > 0 ? (
          <Card mode="outlined" style={styles.card}>
            <Card.Title
              title="Blocked origins"
              titleVariant="titleSmall"
              titleStyle={{ color: theme.colors.onSurface, fontWeight: "700" }}
              subtitle={`${blocked.length} origin${blocked.length > 1 ? "s" : ""} refused on this device`}
              subtitleStyle={{ color: theme.colors.onSurfaceVariant }}
              left={() => (
                <View style={[styles.appIcon, { backgroundColor: theme.colors.errorContainer }]}>
                  <ShieldOff size={18} color={theme.colors.onErrorContainer} />
                </View>
              )}
            />
            <Card.Content style={styles.cardContent}>
              {blocked.map((origin) => (
                <View key={origin} style={styles.blockedRow}>
                  <Ban size={14} color={theme.colors.error} />
                  <Text
                    variant="bodyMedium"
                    numberOfLines={1}
                    style={{ color: theme.colors.onSurface, flex: 1 }}
                  >
                    {origin}
                  </Text>
                  <Button
                    mode="text"
                    compact
                    onPress={() => {
                      dispatch(unblockOrigin(origin));
                      void hapticMedium();
                      setSnack(`${origin} unblocked.`);
                    }}
                  >
                    Unblock
                  </Button>
                </View>
              ))}
            </Card.Content>
          </Card>
        ) : null}

        {rows.length > 0 ? (
          <Button
            mode="outlined"
            textColor={theme.colors.error}
            icon={({ size, color }) => <Link2Off size={size} color={color} />}
            onPress={() =>
              Alert.alert(
                "Revoke all sessions?",
                "Every connected app loses access, and any active session ends immediately — on this device and in the cloud. Apps can reconnect only by scanning a new QR.",
                [
                  { text: "Cancel", style: "cancel" },
                  {
                    text: "Revoke all",
                    style: "destructive",
                    onPress: () => {
                      for (const row of rows) {
                        if (row.localId) revokeConnectedApp(row.localId);
                        else if (row.sid)
                          void revokeSession(row.sid, "Revoked in the authenticator.");
                      }
                      setCloud((prev) =>
                        prev.map((c) =>
                          c.status === "active"
                            ? { ...c, status: "revoked" as const, revokedAt: Date.now() }
                            : c,
                        ),
                      );
                      void hapticError();
                      setSnack("All sessions revoked.");
                    },
                  },
                ],
              )
            }
            style={{ marginTop: 4 }}
          >
            Revoke all sessions
          </Button>
        ) : null}

        <View style={{ height: tabClearance(insets.bottom) }} />
      </ScrollView>

      {snack ? (
        <View style={[styles.snack, { backgroundColor: theme.colors.inverseSurface, bottom: tabClearance(insets.bottom) - 8 }]}>
          <Text variant="bodyMedium" style={{ color: theme.colors.inverseOnSurface }}>
            {snack}
          </Text>
          <Button
            mode="text"
            compact
            textColor={theme.colors.inversePrimary}
            onPress={() => setSnack(null)}
          >
            Dismiss
          </Button>
        </View>
      ) : null}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  scroll: { paddingHorizontal: 16, gap: 12, paddingBottom: 8 },
  filters: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    rowGap: 6,
    gap: 8,
    paddingHorizontal: 16,
    paddingBottom: 8,
  },
  empty: { alignItems: "center", justifyContent: "center", gap: 10, paddingTop: 60, paddingHorizontal: 30 },
  notice: {
    flexDirection: "row",
    gap: 10,
    alignItems: "flex-start",
    borderRadius: 16,
    padding: 12,
  },
  card: { borderRadius: radii.lg },
  cardContent: { paddingBottom: 12, paddingTop: 2 },
  rowActions: { flexDirection: "row", alignItems: "center" },
  blockedRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 6,
  },
  // Sits inside Card.Title's fixed 40×40 `left` slot, which already carries
  // the 16px card inset and a 16px gutter — no extra margin (an extra one
  // overflows the slot and collapses the gap to the title).
  appIcon: { width: 38, height: 38, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  metaRow: { flexDirection: "row", alignItems: "center", gap: 10, flexWrap: "wrap" },
  metaItem: { flexDirection: "row", alignItems: "center", gap: 4 },
  liveChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
  },
  liveDot: { width: 6, height: 6, borderRadius: 3 },
  snack: {
    position: "absolute",
    left: 16,
    right: 16,
    borderRadius: 14,
    paddingVertical: 6,
    paddingHorizontal: 8,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
});
