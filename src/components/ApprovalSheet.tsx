import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from "react-native";
import { Button, Card, Chip, Menu, Modal, Portal, Text, useTheme } from "react-native-paper";
import { LinearGradient } from "expo-linear-gradient";
import * as Clipboard from "expo-clipboard";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  ChevronDown,
  Copy,
  Fingerprint,
  KeyRound,
  ShieldCheck,
} from "lucide-react-native";
import { useAppDispatch, useAppSelector } from "@/store/hooks";
import { dismissResult } from "@/store/sessionSlice";
import { setActiveAccount } from "@/store/accountsSlice";
import { useApproval } from "@/lib/useApproval";
import { OpSummaryCard } from "@/components/OpSummaryCard";
import { PinGate } from "@/components/PinGate";
import { appOrigin } from "@/lib/protocol";
import { roleAccent, roleLabel } from "@/lib/keyRouting";
import { hapticMedium } from "@/lib/haptics";
import { paletteFor, radii, roleAccentColors, shadows, systemClearance } from "@/components/theme";

interface Props {
  visible: boolean;
  onDismiss: () => void;
}

/**
 * The approval decision as a MODAL — the browser screen's way through the
 * same flow the /session screen owns: same shared `useApproval` hook (same
 * authority check, same PIN/biometric gate, same broadcast), so the two
 * surfaces can never drift. Used by the in-app browser so a request never
 * costs the user their page.
 *
 * Auto-closes when the queue empties (decided / session ended); with more
 * requests queued, the next one takes its place in the same sheet.
 */
export function ApprovalSheet({ visible, onDismiss }: Props) {
  const theme = useTheme();
  const pending = useAppSelector((s) => s.session.pending);
  const session = useAppSelector((s) => s.session.session);
  const biometricsEnabled = useAppSelector((s) => s.settings.biometricsEnabled);
  const lastResult = useAppSelector((s) => s.session.lastResult);
  /** True while the broadcast is on the wire — buttons swap to a spinner. */
  const broadcasting = useAppSelector((s) => s.session.connection) === "sending";
  const dispatch = useAppDispatch();
  const activeUsername = useAppSelector((s) => s.accounts.activeUsername);
  const accounts = useAppSelector((s) => s.accounts.accounts);
  const insets = useSafeAreaInsets();
  const [menuOpen, setMenuOpen] = useState(false);
  /** Receipt copy feedback — the txid stays selectable either way. */
  const [copied, setCopied] = useState(false);
  /**
   * Targeted session (the QR named its account): the request belongs to that
   * account — shown as a fixed chip, because switching away would be undone
   * by the session's per-message re-assert anyway. Free sessions (login QRs,
   * older frontends) get the live switcher — that's exactly when a
   * multi-account user needs to pick which key signs.
   */
  const sessionAccount = session?.account ?? null;
  const {
    activeAccount,
    usableKey,
    blockedKeyReason,
    authorizing,
    setAuthorizing,
    snack,
    biometricUnlock,
    pinUnlock,
    reject,
  } = useApproval();

  // Close only when there is neither a request NOR an outcome on screen:
  // swallowing a broadcast failure the moment pending clears was how a
  // "failed" decision vanished with no explanation.
  useEffect(() => {
    if (visible && !pending && !lastResult) {
      console.log("[steemauth] approval sheet closed (nothing to show)");
      onDismiss();
    }
  }, [visible, pending, lastResult, onDismiss]);

  // Outcome first: after a decision the sheet shows the result (same wording
  // as the approval screen) until the user taps Done.
  const showResult = visible && !pending && lastResult;
  const ok = lastResult?.ok ?? false;
  const palette = paletteFor(theme);

  const copyTx = async () => {
    if (!lastResult?.txId) return;
    try {
      await Clipboard.setStringAsync(lastResult.txId);
      await hapticMedium();
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // No clipboard access — the id above stays long-press selectable.
    }
  };

  const requester = session?.app ?? "An app";
  // Observability: where the sheet was dismissed is exactly what the last
  // "it closed by itself" report could not answer.
  const openRequestId = pending?.requestId;
  useEffect(() => {
    if (visible && openRequestId) {
      console.log("[steemauth] approval sheet open:", openRequestId);
    }
  }, [visible, openRequestId]);
  const origin = session ? appOrigin(session) : null;
  // Risk-coded accent for the required-key chip: posting=green (routine),
  // active=amber (moves funds), owner=red, memo=blue — the stakes are
  // readable at a glance in both light and dark mode.
  const keyAccent = usableKey ? roleAccentColors(theme, roleAccent(usableKey)) : null;

  return (
    <Portal>
      <Modal
        visible={visible}
        onDismiss={onDismiss}
        contentContainerStyle={[
          styles.sheet,
          {
            backgroundColor: theme.colors.surface,
            // System-bar floor: without it the action row sat under the
            // navigation buttons (the "hard to reach" report).
            paddingBottom: systemClearance(insets.bottom),
          },
        ]}
      >
        {/* KeyboardAvoidingView: without it the PIN pad sits behind the
            keyboard; the gap lives here so header/body/actions space evenly. */}
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : undefined}
          style={styles.sheetBody}
        >
        <View style={styles.header}>
          <View style={[styles.headerIcon, { backgroundColor: theme.colors.primaryContainer }]}>
            <ShieldCheck size={20} color={theme.colors.onPrimaryContainer} />
          </View>
          <View style={{ flex: 1 }}>
            <Text variant="titleMedium" style={{ color: theme.colors.onSurface, fontWeight: "700" }}>
              {requester}
            </Text>
            {origin ? (
              <Text variant="bodySmall" numberOfLines={1} style={{ color: theme.colors.onSurfaceVariant }}>
                {origin} · @{activeUsername ?? "unknown"}
              </Text>
            ) : null}
          </View>

          {/* Which account signs THIS request: fixed when the QR targeted
              one, a switcher when the session is free. */}
          {sessionAccount ? (
            <Chip
              compact
              mode="outlined"
              style={styles.chip}
              textStyle={styles.chipText}
            >
              Requires @{sessionAccount}
            </Chip>
          ) : accounts.length > 1 ? (
            <Menu
              visible={menuOpen}
              onDismiss={() => setMenuOpen(false)}
              anchor={
                <Pressable
                  onPress={() => setMenuOpen(true)}
                  accessibilityRole="button"
                  accessibilityLabel="Switch the account that signs this request"
                  style={styles.acctBtn}
                >
                  <Text variant="labelMedium" style={{ color: theme.colors.primary, fontWeight: "700" }}>
                    @{activeUsername ?? "unknown"}
                  </Text>
                  <ChevronDown size={14} color={theme.colors.primary} />
                </Pressable>
              }
              contentStyle={{
                backgroundColor: theme.colors.surface,
                borderRadius: radii.md,
              }}
            >
              {accounts.map((a) => (
                <Menu.Item
                  key={a.username}
                  title={`@${a.username}`}
                  trailingIcon={a.username === activeUsername ? "check" : undefined}
                  onPress={() => {
                    setMenuOpen(false);
                    if (a.username !== activeUsername) {
                      dispatch(setActiveAccount(a.username));
                    }
                  }}
                />
              ))}
            </Menu>
          ) : null}
        </View>

        <ScrollView
          style={showResult ? styles.bodyResult : styles.body}
          contentContainerStyle={{ gap: 8 }}
        >
          {showResult && lastResult ? (
            <LinearGradient
              colors={
                ok ? [...palette.gradientSuccess] : [theme.colors.error, theme.colors.error]
              }
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={[styles.receipt, shadows.card]}
            >
              <View style={styles.receiptIcon}>
                {ok ? (
                  <CheckCircle2 size={40} color="#fff" />
                ) : (
                  <AlertTriangle size={38} color="#fff" />
                )}
              </View>
              <Text variant="titleLarge" style={styles.receiptTitle}>
                {ok ? "Approved & broadcast" : "Not completed"}
              </Text>
              <Text variant="bodyMedium" style={styles.receiptSub}>
                {lastResult.message}
              </Text>

              {lastResult.txId ? (
                <View style={styles.txBox}>
                  <Text variant="labelSmall" style={styles.txLabel}>
                    TRANSACTION ID
                  </Text>
                  <Text variant="bodySmall" selectable style={styles.txId}>
                    {lastResult.txId}
                  </Text>
                  <Button
                    mode="contained-tonal"
                    compact
                    icon={({ size, color }) =>
                      copied ? (
                        <CheckCircle2 size={size} color={color} />
                      ) : (
                        <Copy size={size} color={color} />
                      )
                    }
                    onPress={copyTx}
                  >
                    {copied ? "Copied" : "Copy"}
                  </Button>
                </View>
              ) : null}

              {ok && lastResult.block ? (
                <View style={styles.blockPill}>
                  <Text variant="labelSmall" style={styles.blockPillText}>
                    Included in block #{lastResult.block}
                  </Text>
                </View>
              ) : null}

              <Button
                mode="contained"
                compact
                buttonColor="rgba(255,255,255,0.95)"
                textColor="#15803D"
                contentStyle={styles.actionBtn}
                style={styles.receiptDone}
                onPress={() => dispatch(dismissResult())}
              >
                Done
              </Button>
            </LinearGradient>
          ) : pending ? (
            pending.sign ? (
              <Card mode="contained" style={styles.card}>
                <Card.Content>
                  <Text variant="titleSmall" style={{ fontWeight: "700", marginBottom: 6 }}>
                    {pending.action === "authenticate" ? "Sign-in request" : "Text you are signing"}
                  </Text>
                  <Text
                    variant="bodySmall"
                    selectable
                    style={{
                      fontFamily: "monospace",
                      lineHeight: 18,
                      color: theme.colors.onSurface,
                    }}
                  >
                    {pending.sign.data}
                  </Text>
                  <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, marginTop: 8 }}>
                    Nothing is broadcast — this only produces a signature.
                  </Text>
                </Card.Content>
              </Card>
            ) : (
              pending.decoded.map((op, i) => (
                <OpSummaryCard key={i} op={op} index={i} />
              ))
            )
          ) : null}

          {blockedKeyReason ? (
            <Text variant="bodySmall" style={{ color: theme.colors.error }}>
              {blockedKeyReason} Approving is disabled until then.
            </Text>
          ) : null}

          {/* The key-type chip only when the operation cards are NOT already
              showing one (each card carries its own risk-coded chip — a
              second identical chip below them was noise). Sign-in requests
              have no cards, so they keep this one. */}
          {usableKey && !blockedKeyReason && !pending?.decoded?.length ? (
            <View style={styles.chipRow}>
              <Chip
                compact
                mode="outlined"
                style={[styles.chip, keyAccent && { borderColor: keyAccent.border, borderWidth: 1.5 }]}
                textStyle={keyAccent ? { color: keyAccent.text, fontWeight: "700" } : undefined}
              >
                {roleLabel(usableKey)}
              </Chip>
            </View>
          ) : null}
        </ScrollView>

        {pending && !showResult ? (
          authorizing ? (
          <PinGate
            title={`Authorize as @${activeAccount?.username ?? "unknown"}`}
            subtitle="The request is signed on this device only."
            onUnlock={pinUnlock}
            onCancel={() => setAuthorizing(false)}
          />
        ) : broadcasting ? (
          <View style={styles.broadcasting}>
            <ActivityIndicator animating size="small" color={theme.colors.primary} />
            <Text
              variant="titleSmall"
              style={{ color: theme.colors.onSurface, fontWeight: "700" }}
            >
              Broadcasting to the Steem network…
            </Text>
            <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, textAlign: "center" }}>
              Keep the app open — this usually takes a few seconds.
            </Text>
          </View>
        ) : (
          <View style={styles.actions}>
            <Button
              mode="contained"
              compact
              contentStyle={[styles.actionBtn, styles.actionBtnX]}
              icon={({ size, color }) => <Fingerprint size={size} color={color} />}
              disabled={!biometricsEnabled || !usableKey || !!blockedKeyReason}
              onPress={biometricUnlock}
            >
              Approve
            </Button>
            <Button
              mode="outlined"
              compact
              contentStyle={[styles.actionBtn, styles.actionBtnX]}
              icon={({ size, color }) => <KeyRound size={size} color={color} />}
              disabled={!usableKey || !!blockedKeyReason}
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
              onPress={reject}
            >
              Reject
            </Button>
          </View>
        )) : null}

        {snack ? (
          <Text variant="bodySmall" style={{ color: theme.colors.error, textAlign: "center" }}>
            {snack}
          </Text>
        ) : null}
        </KeyboardAvoidingView>
      </Modal>
    </Portal>
  );
}

const styles = StyleSheet.create({
  sheet: {
    // Full-screen: matches the connect modal that precedes it.
    margin: 0,
    borderRadius: 0,
    height: "100%",
    maxHeight: "100%",
    padding: 16,
    paddingTop: 24,
  },
  sheetBody: { flex: 1, gap: 12 },
  header: { flexDirection: "row", alignItems: "center", gap: 12 },
  headerIcon: { width: 40, height: 40, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  // Content-sized (capped): the action row sits RIGHT BELOW the operations
  // in the thumb zone instead of being pinned to the physical bottom edge.
  body: { flexGrow: 0, maxHeight: "52%" },
  /** The receipt card is taller than the request view — give it room. */
  bodyResult: { flexGrow: 0, maxHeight: "78%" },
  card: { borderRadius: radii.md },
  chipRow: { flexDirection: "row", gap: 6, flexWrap: "wrap" },
  chip: { height: 26, marginVertical: 0, justifyContent: "center", alignItems: "center" },
  chipText: { fontSize: 11, fontWeight: "700", minHeight: 0, marginVertical: 0, includeFontPadding: false },
  acctBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    paddingHorizontal: 6,
    paddingVertical: 4,
  },
  actions: { flexDirection: "row", gap: 8, flexWrap: "wrap" },
  actionBtn: { height: 40 },
  /** Horizontal breathing room inside the primary decision buttons. */
  actionBtnX: { paddingHorizontal: 16 },
  /** Broadcast-in-flight row: spinner + honest copy, replaces the buttons. */
  broadcasting: { alignItems: "center", gap: 6, paddingVertical: 22, paddingHorizontal: 10 },
  /** Receipt card — mirrors the approval screen's success gradient. */
  receipt: { borderRadius: radii.xl, padding: 22, alignItems: "center", gap: 8, marginVertical: 8 },
  receiptIcon: {
    width: 74,
    height: 74,
    borderRadius: 37,
    backgroundColor: "rgba(255,255,255,0.22)",
    alignItems: "center",
    justifyContent: "center",
  },
  receiptTitle: { color: "#fff", fontWeight: "800" },
  receiptSub: { color: "rgba(255,255,255,0.92)", textAlign: "center" },
  txBox: {
    alignSelf: "stretch",
    backgroundColor: "rgba(0,0,0,0.25)",
    borderRadius: 14,
    padding: 10,
    gap: 6,
    alignItems: "center",
    marginTop: 6,
  },
  txLabel: { color: "rgba(255,255,255,0.7)", letterSpacing: 1 },
  txId: { color: "rgba(255,255,255,0.95)", textAlign: "center" },
  blockPill: {
    backgroundColor: "rgba(0,0,0,0.25)",
    borderRadius: radii.pill,
    paddingVertical: 4,
    paddingHorizontal: 12,
    marginTop: 2,
  },
  blockPillText: { color: "rgba(255,255,255,0.9)", fontWeight: "700" },
  receiptDone: { marginTop: 6, borderRadius: radii.pill },
});
