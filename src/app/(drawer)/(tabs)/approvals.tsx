import { useEffect } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { Button, Card, Chip, ProgressBar, Snackbar, Text, useTheme } from "react-native-paper";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { router } from "expo-router";
import {
  Ban,
  CheckCircle2,
  Fingerprint,
  Inbox,
  KeyRound,
  Send,
  XCircle,
} from "lucide-react-native";
import { ScreenHeader } from "@/components/ScreenHeader";
import { radii, tabClearance } from "@/components/theme";
import { PinGate } from "@/components/PinGate";
import { useAppDispatch, useAppSelector } from "@/store/hooks";
import {
  dismissResult as dismissSessionResult,
  type PendingRequest,
} from "@/store/sessionSlice";
import { useApproval } from "@/lib/useApproval";

/**
 * Approvals — the decision surface.
 *
 * Two halves, in the order a user needs them:
 *
 *   1. PENDING NOW  — the live request, if one exists. An open session sits
 *      here until acted on, and the decision is made
 *      RIGHT HERE: same authority check, PIN/biometric gate and broadcast as
 *      the approval screen (both run through `useApproval`, so they cannot
 *      drift). The full-screen modal stays one tap away for reviewing every
 *      decoded operation before signing.
 *   2. RECENT DECISIONS — what was approved or rejected, newest first, with
 *      the transaction id (or the failure reason).
 *
 * Accounts moved to Home's "Manage accounts" button, which is why this tab
 * has its slot: the decision is the thing a user comes back for.
 */

/** Clearance for the flat bottom bar + its raised center button. */
function timeAgo(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** Activity stores the method name; a person wants the outcome. */
function describeAction(action: string): string {
  if (action === "authenticate") return "Sign in";
  if (action.startsWith("sign")) return "Signature";
  return action;
}

/** Recent decisions shown here before handing over to the Activity tab. */
const DECISION_LIMIT = 15;

/** One line per queued request: what the phone is about to be asked. */
function queueLabel(r: PendingRequest): string {
  if (r.sign) return "Signature request - nothing is broadcast";
  return r.decoded.map((d) => d.title).join(", ") || r.action || "Request";
}

/** "posting" -> "Posting" (likewise Active / Owner): the bare key type. */
function authorityLabel(authority?: string): string {
  const a = authority ?? "posting";
  return a.charAt(0).toUpperCase() + a.slice(1);
}

export default function ApprovalsScreen() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const dispatch = useAppDispatch();
  const { connection, pending, session, lastResult, transport, queue } = useAppSelector(
    (s) => s.session,
  );
  const entries = useAppSelector((s) => s.activity.entries);
  const activeUsername = useAppSelector((s) => s.accounts.activeUsername);
  const biometricsEnabled = useAppSelector((s) => s.settings.biometricsEnabled);

  const live = connection === "request" && pending ? pending : null;
  const waiting =
    !live && (connection === "waiting" || connection === "connecting");
  const broadcasting = connection === "sending" && pending;
  const result = connection === "done" && lastResult ? lastResult : null;
  const requester = session?.app ?? "an unknown origin";

  /**
   * Only the ACTIVE account's decisions. The local store may hold rows from
   * other accounts this device has had, and none of them belong on this
   * screen — same rule as the Activity tab.
   */
  const decisions = activeUsername
    ? entries.filter((e) => e.account === activeUsername)
    : [];
  const shownDecisions = decisions.slice(0, DECISION_LIMIT);

  const {
    activeAccount,
    usableKey,
    blockedKeyReason,
    authorizing,
    setAuthorizing,
    snack,
    setSnack,
    biometricUnlock,
    pinUnlock,
    reject,
  } = useApproval();

  // Diagnostic: this tab reads the exact same slice as the approval modal, so
  // if a request shows on one and not the other, this line is the whole
  // diagnosis — it prints what the tab saw at the moment it rendered.
  useEffect(() => {
    console.log(
      "[steemauth] approvals state:",
      connection,
      "| pending:",
      Boolean(pending),
      "| session:",
      Boolean(session),
    );
  }, [connection, pending, session]);

  /**
   * What the modal's Done button does: dismiss the result card. The session
   * itself survives (the app may send the next request until the QR's `exp`),
   * so the card collapses back to the "Session open" state instead of idle.
   */
  const dismissResult = () => {
    dispatch(dismissSessionResult());
  };

  const liveSummary = live
    ? live.sign
      ? live.action === "authenticate"
        ? "Sign-in request — nothing is broadcast"
        : "Signature request — nothing is broadcast"
      : `${live.decoded.length} action${live.decoded.length === 1 ? "" : "s"}: ` +
        live.decoded.map((d) => d.title).join(", ")
    : "";

  return (
    <SafeAreaView
      style={[styles.container, { backgroundColor: theme.colors.background }]}
      edges={["top"]}
    >
      <ScreenHeader
        title="Approvals"
        subtitle="Pending requests and recent decisions"
      />

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
      >
        {/* ---------------- pending now ---------------- */}
        {/* Whole card is tappable (buttons inside claim their own touches). */}
        {live || waiting ? (
          <Pressable
            onPress={() => router.push("/session")}
            hitSlop={8}
            style={({ pressed }) => pressed && styles.cardPressed}
          >
            <Card
              mode="contained"
              style={[styles.liveCard, { borderColor: theme.colors.primary }]}
            >
            <View style={styles.liveRow}>
              <View style={[styles.pulse, { backgroundColor: theme.colors.primary }]} />
              <Text
                variant="labelLarge"
                style={{ color: theme.colors.primary, fontWeight: "800", flex: 1 }}
              >
                {live ? "Waiting for your decision" : "Session open"}
              </Text>
              {/* Subtle transport truth (protocol v3): the relay is the only
                  transport, so this shows its health. A flap is diagnostics,
                  not an error state — pull-replay repairs it. */}
              {transport ? (
                <View style={styles.transportChip}>
                  <View
                    style={[
                      styles.pulse,
                      {
                        width: 6,
                        height: 6,
                        backgroundColor:
                          transport === "plane" ? theme.colors.primary : theme.colors.error,
                      },
                    ]}
                  />
                  <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>
                    {transport === "plane" ? "Durable" : "Degraded"}
                  </Text>
                </View>
              ) : null}
            </View>

            {/* Username left, required key right: the key the decision will
                actually exercise sits where the eye already reads the row. */}
            <View style={styles.userRow}>
              <Text
                variant="titleMedium"
                numberOfLines={1}
                style={{
                  color: theme.colors.onSurface,
                  fontWeight: "700",
                  flex: 1,
                }}
              >
                @{activeUsername ?? "unknown"} · {requester}
              </Text>
              {live && !live.sign && live.decoded[0] ? (
                <Chip
                  compact
                  mode="outlined"
                  style={styles.chip}
                  textStyle={styles.chipText}
                >
                  {authorityLabel(live.decoded[0].authority)}
                </Chip>
              ) : null}
            </View>
            <Text
              variant="bodyMedium"
              numberOfLines={2}
              style={{ color: theme.colors.onSurfaceVariant, marginTop: 2 }}
            >
              {waiting
                ? "Connected — waiting for the request to arrive from the app."
                : liveSummary}
            </Text>

            {/* The key pill moved up beside the username; only the sensitive-
                funds warning still earns a row of its own. */}
            {live && !live.sign && live.decoded[0]?.sensitive ? (
              <View style={styles.chipRow}>
                <Chip
                  compact
                  mode="outlined"
                  style={styles.chip}
                  textStyle={styles.chipText}
                >
                  Moves funds
                </Chip>
              </View>
            ) : null}

            {live && blockedKeyReason ? (
              <Text
                variant="bodySmall"
                style={{ color: theme.colors.error, marginTop: 8 }}
              >
                {blockedKeyReason} Approving is disabled until then.
              </Text>
            ) : null}

            {/* The decision itself. */}
            {live && !authorizing ? (
              <View style={styles.actions}>
                <Button
                  mode="contained"
                  compact
                  contentStyle={[styles.actionBtn, styles.actionBtnX]}
                  icon={({ size, color }) => <Fingerprint size={size} color={color} />}
                  disabled={!biometricsEnabled || !usableKey}
                  onPress={biometricUnlock}
                >
                  Approve
                </Button>
                <Button
                  mode="outlined"
                  compact
                  contentStyle={[styles.actionBtn, styles.actionBtnX]}
                  icon={({ size, color }) => <KeyRound size={size} color={color} />}
                  disabled={!usableKey}
                  onPress={() => setAuthorizing(true)}
                >
                  PIN
                </Button>
                <Button
                  mode="text"
                  compact
                  contentStyle={styles.actionBtn}
                  textColor={theme.colors.error}
                  icon={({ size, color }) => <Ban size={size} color={color} />}
                  onPress={() => {
                    void reject();
                    setSnack("Request declined.");
                  }}
                >
                  Reject
                </Button>
              </View>
            ) : null}

            {live && authorizing ? (
              <View
                style={[
                  styles.pinWrap,
                  {
                    backgroundColor: theme.colors.surfaceVariant,
                    borderColor: theme.colors.outlineVariant,
                  },
                ]}
              >
                <PinGate
                  title={`Authorize as @${activeAccount?.username ?? "unknown"}`}
                  subtitle="The transaction is signed on this device only."
                  onUnlock={pinUnlock}
                  onCancel={() => setAuthorizing(false)}
                />
              </View>
            ) : null}

            <Pressable onPress={() => router.push("/session")} hitSlop={8}>
              <Text
                variant="labelSmall"
                style={{ color: theme.colors.primary, marginTop: 10, fontWeight: "700" }}
              >
                {live
                  ? "Review every action on the full screen →"
                  : "Open the approval screen →"}
              </Text>
            </Pressable>
            </Card>
          </Pressable>
        ) : broadcasting ? (
          /* ---------------- broadcasting ---------------- */
          <Card mode="contained" style={styles.infoCard}>
            <View style={styles.emptyState}>
              <Send size={30} color={theme.colors.primary} />
              <Text variant="titleMedium" style={{ color: theme.colors.onSurface }}>
                Broadcasting…
              </Text>
              <Text
                variant="bodyMedium"
                style={[styles.dim, { textAlign: "center" }]}
              >
                Signed on this device — waiting for the Steem network to confirm.
              </Text>
              <ProgressBar
                indeterminate
                color={theme.colors.primary}
                style={{ alignSelf: "stretch", marginTop: 6 }}
              />
            </View>
          </Card>
        ) : result ? (
          /* ---------------- result ---------------- */
          <Card mode="contained" style={styles.infoCard}>
            <View style={styles.emptyState}>
              {result.ok ? (
                <CheckCircle2 size={34} color={theme.colors.primary} />
              ) : (
                <XCircle size={34} color={theme.colors.error} />
              )}
              <Text variant="titleMedium" style={{ color: theme.colors.onSurface }}>
                {result.ok ? "Approved and broadcast" : "Not broadcast"}
              </Text>
              <Text
                variant="bodyMedium"
                style={[styles.dim, { textAlign: "center" }]}
              >
                {result.message}
              </Text>
              {result.txId ? (
                <Text
                  variant="labelSmall"
                  numberOfLines={1}
                  style={{ color: theme.colors.onSurfaceVariant }}
                >
                  {/* Head…tail: a hash never fits, and a bare ellipsis at the
                      end would hide which chain it belongs to. */}
                  tx {result.txId.slice(0, 18)}…{result.txId.slice(-6)}
                </Text>
              ) : null}
              <Button mode="contained" onPress={dismissResult} style={styles.doneBtn}>
                Done
              </Button>
            </View>
          </Card>
        ) : (
          /* ---------------- nothing waiting ---------------- */
          <Card mode="contained" style={styles.infoCard}>
            <View style={styles.emptyState}>
              <Inbox size={34} color={theme.colors.primary} />
              <Text variant="titleMedium" style={{ color: theme.colors.onSurface }}>
                Nothing waiting
              </Text>
              <Text variant="bodyMedium" style={[styles.dim, { textAlign: "center" }]}>
                Requests appear here while they need your decision — the QR
                you scan in a Steem app. Approve with biometrics or PIN right
                here; nothing is signed until you do.
              </Text>
            </View>
          </Card>
        )}

        {/* ------------- queued requests (several at once) ------------- */}
        {/* Arrival order == row seq == creation order: oldest first. The live
            card above is queue[0]; this is the full list so nothing the
            client sent at the same time can hide behind the front slot. */}
        {queue.length > 1 ? (
          <Card mode="contained" style={styles.infoCard}>
            <View style={styles.queueCardInner}>
              <View>
                <Text variant="titleSmall" style={{ color: theme.colors.onSurface }}>
                  Waiting requests ({queue.length})
                </Text>
                <Text variant="bodySmall" style={styles.dim}>
                  Oldest first - you decide them one at a time, starting at the top.
                </Text>
              </View>
              {queue.map((r, i) => (
                <View key={r.requestId} style={styles.queueRow}>
                  <View
                    style={[
                      styles.queueIndex,
                      {
                        backgroundColor:
                          i === 0
                            ? theme.colors.primary
                            : theme.colors.surfaceVariant,
                      },
                    ]}
                  >
                    <Text
                      variant="labelSmall"
                      style={{
                        color:
                          i === 0
                            ? theme.colors.onPrimary
                            : theme.colors.onSurfaceVariant,
                        fontWeight: "800",
                      }}
                    >
                      {i + 1}
                    </Text>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text
                      variant="bodyMedium"
                      numberOfLines={1}
                      style={{ color: theme.colors.onSurface, fontWeight: "600" }}
                    >
                      {queueLabel(r)}
                    </Text>
                    <Text
                      variant="labelSmall"
                      style={{ color: theme.colors.onSurfaceVariant }}
                    >
                      {new Date(r.at).toLocaleTimeString()} -{" "}
                      {i === 0 ? "Up now" : "Queued"}
                    </Text>
                  </View>
                  {i === 0 ? (
                    <Text
                      variant="labelSmall"
                      style={{ color: theme.colors.primary, fontWeight: "800" }}
                    >
                      NOW
                    </Text>
                  ) : null}
                </View>
              ))}
            </View>
          </Card>
        ) : null}

        {/* ---------------- recent decisions ---------------- */}
        <Text variant="titleSmall" style={styles.section}>
          Recent decisions
        </Text>

        {decisions.length === 0 ? (
          <Text variant="bodySmall" style={styles.dim}>
            {activeUsername
              ? `Nothing approved or rejected for @${activeUsername} yet — decisions are listed here, newest first, with the transaction id.`
              : "Nothing approved or rejected yet — decisions are listed here, newest first, with the transaction id."}
          </Text>
        ) : (
          shownDecisions.map((entry) => (
            <View key={entry.id} style={styles.entry}>
              {entry.ok ? (
                <CheckCircle2 size={18} color={theme.colors.primary} />
              ) : (
                <XCircle size={18} color={theme.colors.error} />
              )}
              <View style={{ flex: 1 }}>
                <Text
                  variant="bodyMedium"
                  numberOfLines={1}
                  style={{ color: theme.colors.onSurface, fontWeight: "600" }}
                >
                  {describeAction(entry.action)}
                </Text>
                <Text
                  variant="labelSmall"
                  numberOfLines={1}
                  style={{ color: theme.colors.onSurfaceVariant }}
                >
                  @{entry.account} · {entry.app} · {timeAgo(entry.at)}
                </Text>
                {entry.ok && entry.txId ? (
                  <Text
                    variant="labelSmall"
                    numberOfLines={1}
                    style={{ color: theme.colors.onSurfaceVariant, opacity: 0.8 }}
                  >
                    tx {entry.txId.slice(0, 20)}…
                  </Text>
                ) : !entry.ok && entry.error ? (
                  <Text
                    variant="labelSmall"
                    numberOfLines={1}
                    style={{ color: theme.colors.error }}
                  >
                    {entry.error}
                  </Text>
                ) : null}
              </View>
              <Text
                variant="labelSmall"
                style={{
                  color: entry.ok ? theme.colors.primary : theme.colors.error,
                  fontWeight: "800",
                }}
              >
                {entry.ok ? "APPROVED" : "REJECTED"}
              </Text>
            </View>
          ))
        )}

        {decisions.length > shownDecisions.length ? (
          <Pressable onPress={() => router.push("/activity")} hitSlop={8}>
            <Text
              variant="labelSmall"
              style={{ color: theme.colors.primary, fontWeight: "700" }}
            >
              See all {decisions.length} in Activity →
            </Text>
          </Pressable>
        ) : null}

        {/* clearance for the flat bottom bar + its raised center button */}
        <View style={{ height: tabClearance(insets.bottom) }} />
      </ScrollView>

      <Snackbar
        visible={!!snack}
        onDismiss={() => setSnack(null)}
        duration={4000}
        // Tab screen: float 8dp above the bar block (absolute children ignore
        // the container, and this screen has no bottom padding of its own).
        style={{ bottom: tabClearance(insets.bottom) - 8 }}
      >
        {snack ?? ""}
      </Snackbar>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  queueCardInner: { gap: 10, paddingVertical: 12, paddingHorizontal: 8 },
  queueRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  queueIndex: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  container: { flex: 1 },
  scroll: { paddingHorizontal: 16, paddingTop: 8, gap: 10 },
  liveCard: { borderRadius: radii.lg, borderWidth: 1.5, padding: 12 },
  cardPressed: { opacity: 0.95, transform: [{ scale: 0.99 }] },
  userRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginTop: 6,
  },
  infoCard: { borderRadius: radii.lg, padding: 4 },
  liveRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  transportChip: { flexDirection: "row", alignItems: "center", gap: 4 },
  pulse: { width: 10, height: 10, borderRadius: 5 },
  chipRow: { flexDirection: "row", gap: 6, marginTop: 8, flexWrap: "wrap" },
  // The pill must hold its label WITHOUT crowding it: 28px gives the 12px
  // text real breathing room inside the border (24 + zero padding clipped the
  // glyphs), centered on both axes, never squeezed off the username row.
  chip: {
    height: 28,
    marginVertical: 0,
    paddingVertical: 0,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  chipText: { fontSize: 12, fontWeight: "600" },
  consentRow: { flexDirection: "row", gap: 10, alignItems: "flex-start", marginTop: 10 },
  checkbox: {
    width: 20,
    height: 20,
    borderRadius: 4,
    borderWidth: 1.5,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 2,
  },
  actions: { flexDirection: "row", gap: 8, marginTop: 12, flexWrap: "wrap" },
  actionBtn: { height: 40 },
  /** Horizontal breathing room inside the primary decision buttons. */
  actionBtnX: { paddingHorizontal: 16 },
  pinWrap: { borderWidth: 1, borderRadius: 12, overflow: "hidden", marginTop: 12 },
  doneBtn: { marginTop: 10, paddingHorizontal: 12 },
  emptyState: { alignItems: "center", gap: 8, paddingVertical: 16, paddingHorizontal: 8 },
  section: { fontWeight: "700", marginTop: 6 },
  entry: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "rgba(128,128,128,0.35)",
  },
  dim: { opacity: 0.7 },
});
