import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  RefreshControl,
  SectionList,
  StyleSheet,
  View,
} from "react-native";
import { Chip, Button, Text, useTheme } from "react-native-paper";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { History, CheckCircle2, XCircle, Trash2, Cloud, CloudOff } from "lucide-react-native";
import { ScreenHeader } from "@/components/ScreenHeader";
import { paletteFor, radii, tabClearance } from "@/components/theme";
import { store } from "@/store";
import { useAppDispatch, useAppSelector } from "@/store/hooks";
import {
  clearActivity,
  mergeActivity,
  markSynced,
  type ActivityEntry,
} from "@/store/activitySlice";
import {
  activitySyncConfigured,
  pullActivity,
  pushActivity,
} from "@/lib/activityStore";
import { hapticLight } from "@/lib/haptics";
import Animated, { FadeInDown } from "react-native-reanimated";

/** Rows rendered per page — the list is paged, not dumped. */
const PAGE_SIZE = 25;

function dayLabel(ts: number): string {
  const d = new Date(ts);
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86_400_000);
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (same(d, today)) return "Today";
  if (same(d, yesterday)) return "Yesterday";
  return d.toLocaleDateString();
}

export default function ActivityScreen() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const palette = paletteFor(theme);
  const dispatch = useAppDispatch();
  const activeUsername = useAppSelector((s) => s.accounts.activeUsername);
  const allEntries = useAppSelector((s) => s.activity.entries);
  /**
   * Only the ACTIVE account's history is ever rendered. The local store may
   * hold rows from other accounts this device has held, and the cloud table
   * holds every user's rows — neither belongs on someone else's screen.
   */
  const entries = activeUsername
    ? allEntries.filter((e) => e.account === activeUsername)
    : [];
  const [filter, setFilter] = useState<"all" | "ok" | "failed">("all");
  const [refreshing, setRefreshing] = useState(false);
  /**
   * Paging window. The scope (account + filter) is part of the key, so a
   * scope change implicitly falls back to a single page — derived state
   * rather than an effect resetting a counter.
   */
  const scopeKey = `${activeUsername ?? ""}|${filter}`;
  const [page, setPage] = useState({ key: scopeKey, count: PAGE_SIZE });
  const visible = page.key === scopeKey ? page.count : PAGE_SIZE;
  const [synced, setSynced] = useState(() => activitySyncConfigured());

  /** Push unsynced local entries, then pull remote history and merge. */
  const sync = useCallback(async () => {
    if (!activitySyncConfigured()) {
      setSynced(false);
      return;
    }
    setRefreshing(true);
    try {
      // retry anything that failed while offline (read fresh from the store)
      const unsynced = store
        .getState()
        .activity.entries.filter((e) => !e.synced);
      for (const e of unsynced) {
        if (await pushActivity(e)) dispatch(markSynced(e.id));
      }
      // pull THIS account's cloud history (never the whole table) and merge
      const remote = await pullActivity(activeUsername ?? "", 100);
      if (remote.length) dispatch(mergeActivity(remote));
      setSynced(true);
    } finally {
      setRefreshing(false);
    }
  }, [dispatch, activeUsername]);

  useEffect(() => {
    let cancelled = false;
    // Yield a tick so setRefreshing/setSynced run in an async continuation,
    // not synchronously inside the effect body (React Compiler rule).
    void (async () => {
      await Promise.resolve();
      if (!cancelled) await sync();
    })();
    return () => {
      cancelled = true;
    };
  }, [sync]);

  const confirmClear = () => {
    Alert.alert(
      "Clear activity?",
      "This removes the local approval history on this device (cloud rows are kept).",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Clear", style: "destructive", onPress: () => { if (activeUsername) dispatch(clearActivity(activeUsername)); } },
      ],
    );
  };

  const filtered = entries.filter((e) =>
    filter === "all" ? true : filter === "ok" ? e.ok : !e.ok,
  );
  const shown = filtered.slice(0, visible);
  const hasMore = shown.length < filtered.length;
  const loadMore = () =>
    setPage((p) => ({
      key: scopeKey,
      count: Math.min(
        (p.key === scopeKey ? p.count : PAGE_SIZE) + PAGE_SIZE,
        filtered.length,
      ),
    }));

  const sections = (() => {
    const groups = new Map<string, ActivityEntry[]>();
    for (const e of shown) {
      const key = dayLabel(e.at);
      const arr = groups.get(key) ?? [];
      arr.push(e);
      groups.set(key, arr);
    }
    return [...groups.entries()].map(([title, data]) => ({ title, data }));
  })();

  const renderItem = ({ item, index }: { item: ActivityEntry; index: number }) => (
    // Rows arrive in a light stagger — 35ms apart, capped at 8 — so a page of
    // history reads as arriving rather than popping in all at once.
    <Animated.View
      entering={FadeInDown.duration(240).delay(Math.min(index, 8) * 35)}
      style={[
        styles.row,
        { backgroundColor: theme.colors.surface, borderColor: theme.colors.outlineVariant },
      ]}
    >
      <View
        style={[
          styles.icon,
          {
            backgroundColor: item.ok ? palette.successContainer : theme.colors.errorContainer,
          },
        ]}
      >
        {item.ok ? (
          <CheckCircle2 size={18} color={palette.onSuccessContainer} />
        ) : (
          <XCircle size={18} color={theme.colors.onErrorContainer} />
        )}
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <Text variant="bodyMedium" style={{ color: theme.colors.onSurface, fontWeight: "600" }} numberOfLines={1}>
          {item.action}
        </Text>
        <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }} numberOfLines={1}>
          @{item.account} · {item.app} · {new Date(item.at).toLocaleTimeString()}
        </Text>
        {item.txId ? (
          <Chip icon="link-variant" compact style={styles.txChip}>
            {item.txId.slice(0, 14)}…
          </Chip>
        ) : item.error ? (
          <Text variant="labelSmall" style={{ color: theme.colors.error }} numberOfLines={2}>
            {item.error}
          </Text>
        ) : null}
      </View>
      {synced ? (
        <Cloud size={14} color={item.synced ? palette.success : theme.colors.outline} />
      ) : null}
    </Animated.View>
  );

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: theme.colors.background }]} edges={["top"]}>
      <ScreenHeader
        title="Activity"
        subtitle={
          synced
            ? "Synced to Supabase · stored only on this device otherwise"
            : "Stored only on this device"
        }
      />

      <View style={styles.filters}>
        <Chip selected={filter === "all"} onPress={() => setFilter("all")} showSelectedCheck>
          All
        </Chip>
        <Chip selected={filter === "ok"} onPress={() => setFilter("ok")} showSelectedCheck>
          Approved
        </Chip>
        <Chip selected={filter === "failed"} onPress={() => setFilter("failed")} showSelectedCheck>
          Rejected
        </Chip>
        <View style={{ flex: 1 }} />
        <Chip
          icon={({ size, color }) =>
            synced ? <Cloud size={size - 4} color={color} /> : <CloudOff size={size - 4} color={color} />
          }
          onPress={() => {
            void hapticLight();
            void sync();
          }}
        >
          Sync
        </Chip>
        {entries.length > 0 ? (
          <Chip icon={({ size, color }) => <Trash2 size={size - 4} color={color} />} onPress={confirmClear}>
            Clear
          </Chip>
        ) : null}
      </View>

      {entries.length === 0 ? (
        <View style={styles.empty}>
          <History size={44} color={theme.colors.outline} />
          <Text variant="titleMedium" style={{ color: theme.colors.onSurface }}>
            {activeUsername ? "Nothing yet" : "No account selected"}
          </Text>
          <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant, textAlign: "center" }}>
            Every approval or rejection you make will appear here — synced to
            your Supabase project when configured, otherwise stored only on
            this device.
          </Text>
        </View>
      ) : (
        <SectionList
          sections={sections}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          renderSectionHeader={({ section }) => (
            <Text
              variant="labelLarge"
              style={[styles.sectionHeader, { color: theme.colors.onSurfaceVariant }]}
            >
              {section.title}
            </Text>
          )}
          // Fill the screen: without a bounded height the list sized itself to
          // its content and the bottom clearance got pushed off-screen, so
          // long histories slid under the tab bar.
          style={{ flex: 1 }}
          contentContainerStyle={[
            styles.list,
            { paddingBottom: tabClearance(insets.bottom) },
          ]}
          stickySectionHeadersEnabled={false}
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={() => void sync()} />
          }
          // Paged list: the next window loads as the footer approaches, and the
          // footer button does the same for anyone navigating by keyboard.
          onEndReached={loadMore}
          onEndReachedThreshold={0.5}
          ListFooterComponent={
            hasMore ? (
              <Button mode="outlined" compact onPress={loadMore} style={styles.moreBtn}>
                Load more ({filtered.length - shown.length} of {filtered.length})
              </Button>
            ) : filtered.length > PAGE_SIZE ? (
              <Text
                variant="labelSmall"
                style={[styles.moreDone, { color: theme.colors.onSurfaceVariant }]}
              >
                All {filtered.length} entries loaded
              </Text>
            ) : undefined
          }
        />
      )}

    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  filters: {
    flexDirection: "row",
    alignItems: "center",
    // Five chips on one line overflows a 375px phone; let the row wrap
    // instead of pushing the last chip off-screen.
    flexWrap: "wrap",
    rowGap: 6,
    gap: 8,
    paddingHorizontal: 16,
    // Optical rhythm under the header and above the first section.
    paddingTop: 4,
    paddingBottom: 12,
  },
  list: { paddingHorizontal: 16, paddingTop: 4 },
  sectionHeader: { fontWeight: "700", marginTop: 12, marginBottom: 8 },
  row: {
    flexDirection: "row",
    gap: 12,
    padding: 12,
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    marginBottom: 8,
    alignItems: "center",
  },
  icon: { width: 36, height: 36, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  txChip: { alignSelf: "flex-start", marginTop: 2 },
  moreBtn: { marginTop: 6, marginBottom: 4 },
  moreDone: { textAlign: "center", marginTop: 8, marginBottom: 4 },
  empty: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    paddingHorizontal: 40,
  },
});
