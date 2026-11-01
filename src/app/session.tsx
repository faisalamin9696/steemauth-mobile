import { useEffect, useState } from "react";
import { Platform, ScrollView, StyleSheet, View } from "react-native";
import { router } from "expo-router";
import * as Clipboard from "expo-clipboard";
import { LinearGradient } from "expo-linear-gradient";
import {
  Appbar,
  Button,
  Card,
  Chip,
  ProgressBar,
  Snackbar,
  Text,
  Banner,
  useTheme,
} from "react-native-paper";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import {
  X,
  Fingerprint,
  KeyRound,
  Ban,
  CheckCircle2,
  AlertTriangle,
  Copy,
  Link2,
} from "lucide-react-native";
import { useAppSelector } from "@/store/hooks";
import { useApproval } from "@/lib/useApproval";
import { OpSummaryCard } from "@/components/OpSummaryCard";
import { PinGate } from "@/components/PinGate";
import { paletteFor, shadows, systemClearance } from "@/components/theme";

import { appOrigin } from "@/lib/protocol";
import { secureScreenOn, secureScreenOff } from "@/lib/screenPrivacy";
import { hapticMedium } from "@/lib/haptics";

/** Live countdown to the session QR expiry. */
function useSessionCountdown(exp: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!exp) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [exp]);
  if (!exp) return 0;
  return Math.max(0, Math.floor((exp - now) / 1000));
}

export default function SessionScreen() {
  const theme = useTheme();
  const palette = paletteFor(theme);
  const { connection, session, pending, lastResult, error, queue } = useAppSelector(
    (s) => s.session,
  );
  const biometricsEnabled = useAppSelector((s) => s.settings.biometricsEnabled);
  const activeUsername = useAppSelector((s) => s.accounts.activeUsername);

  const [copied, setCopied] = useState(false);


  // Diagnostic: proves a scan actually reached the approval screen. The
  // else-branch reports the empty-body case: a screen with no session and no
  // pending request renders only this header, and knowing whether the
  // connection was already torn down (idle) or is still waiting for a request
  // the frontend never sent is the whole diagnosis.
  useEffect(() => {
    console.log(
      "[steemauth] session screen state:",
      connection,
      "| session:",
      Boolean(session),
      "| pending:",
      Boolean(pending),
    );
  }, [connection, pending, session]);

  // Never let approval content leak into screenshots / the app switcher
  // (web-safe: no-ops where unsupported).
  useEffect(() => {
    void secureScreenOn("session");
    return () => {
      void secureScreenOff("session");
    };
  }, []);

  const secondsLeft = useSessionCountdown(session?.exp ?? null);

  /**
   * Unlock + broadcast live in a hook shared with the Approvals tab, so the
   * two Approve paths can never drift: same authority check (never prompt
   * for a key this device does not hold), same PIN/biometric gate, same
   * broadcast, same consent flag.
   */
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
    reject: rejectRequest,
  } = useApproval();

  /**
   * Who is asking: the app that opened this session and sent the request.
   */
  const requester = session?.app ?? "An app";

  const reject = () => {
    void rejectRequest();
    // With a queue the NEXT request can appear the moment this one is
    // declined - say so, or the refusal looks like nothing happened.
    setSnack("Request declined.");
  };

  const close = () => {
    // Closing the screen is neither a decision nor the end of the session:
    // the requesting app keeps its half until the QR's `exp`, so follow-up
    // operations still show up on the Approvals tab. The manager's expiry
    // timer is the single teardown bound (see sessionManager.armExpiry).
    // Pop ONE level - back to whatever opened us (the browser, a tab).
    // dismissAll() would dump the user on Home and lose that context.
    if (router.canGoBack()) router.back();
    else router.replace("/");
  };

  const copyTx = async () => {
    if (!lastResult?.txId) return;
    try {
      await Clipboard.setStringAsync(lastResult.txId);
      await hapticMedium();
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setSnack("Could not access the clipboard.");
    }
  };


  const mmss = `${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, "0")}`;
  const ok = lastResult?.ok ?? false;
  /** While the broadcast is on the wire the decisions are locked (one tap). */
  const broadcasting = connection === "sending";
  const insets = useSafeAreaInsets();

  return (
    <SafeAreaView
      style={[
        styles.safe,
        {
          backgroundColor: theme.colors.background,
          // The CONTAINER owns the system-bar clearance: Close and the
          // snackbar sit outside the ScrollView, so the scroll's own floor
          // never protected them — that is how Close landed under the nav bar.
          // The shared floor also covers a device that reports 0 while a
          // 3-button navigation bar still occupies the bottom.
          paddingBottom: systemClearance(insets.bottom),
        },
      ]}
      // No edges: the top inset belongs to the Appbar (its statusBarHeight
      // default), the bottom to the explicit padding above — SafeAreaView's
      // own inset would override that padding with a possibly-reported 0.
      edges={[]}
    >
      <Appbar.Header mode="small" style={{ backgroundColor: theme.colors.background }} elevated={false}>
        <Appbar.Action icon={({ size, color }) => <X size={size - 4} color={color} />} onPress={close} />
        <Appbar.Content
          title="Approve request"
          // Countdown digits go tabular so the header stops twitching every
          // second while it ticks down (numbers must not shift the layout).
          subtitleStyle={{ fontVariant: ["tabular-nums"] }}
          subtitle={
            session ? `${session.app} · expires in ${mmss}` : undefined
          }
        />
        {session ? (
          <Chip compact icon="shield-lock-outline" style={styles.secureChip}>
            On-device
          </Chip>
        ) : null}
        <View style={{ width: 10 }} />
      </Appbar.Header>

      <ScrollView
        contentContainerStyle={[
          styles.scroll,
          // The container clears the system bar (see above); the scroll only
          // needs breathing room before the Close button.
          { paddingBottom: 24 },
        ]}
        showsVerticalScrollIndicator={false}
      >
        {/* Waiting for request */}
        {connection === "connecting" || connection === "waiting" ? (
          <>
            <ProgressBar indeterminate />
            <Card mode="contained" style={styles.card}>
              <Card.Content style={styles.centerCol}>
                <View style={[styles.waitIcon, { backgroundColor: theme.colors.primary }]}>
                  <Link2 size={26} color={theme.colors.onPrimary} />
                </View>
                <Text variant="titleMedium" style={{ color: theme.colors.onSurface, fontWeight: "700" }}>
                  Connected — waiting for the request
                </Text>
                <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant, textAlign: "center", lineHeight: 20 }}>
                  Acting as @{activeUsername}. Keep this screen open and confirm
                  the action in {session?.app ?? "the requesting app"}.
                </Text>
              </Card.Content>
            </Card>
          </>
        ) : null}

        {/* Incoming request */}
        {connection === "request" && pending ? (
          <>
            <Banner visible icon="shield-check" actions={[]}>
              <Text>
                <Text style={{ fontWeight: "700" }}>{requester}</Text>{" "}
                {pending.sign ? (
                  pending.action === "authenticate" ? (
                    `wants to sign you in as @${activeUsername}. Nothing is broadcast — approving stores this app as a session you can revoke later.`
                  ) : (
                    `wants to verify you own @${activeUsername}. Nothing is broadcast — this only produces a signature.`
                  )
                ) : (
                  <>
                    wants{" "}
                    {pending.decoded.length} action
                    {pending.decoded.length > 1 ? "s" : ""} signed as @{activeUsername}{" "}
                    — review every field below.
                  </>
                )}
              </Text>
              {session && appOrigin(session) ? (
                <Text
                  variant="bodySmall"
                  style={{ color: theme.colors.onSurfaceVariant, textAlign: "center", marginTop: 2 }}
                  selectable
                >
                  {appOrigin(session)}
                </Text>
              ) : null}
            </Banner>

            {queue.length > 1 ? (
              <View style={{ alignItems: "center" }}>
                <Chip compact mode="outlined">
                  {queue.length} waiting - this one first
                </Chip>
              </View>
            ) : null}

            {blockedKeyReason ? (
              <Banner visible icon="alert-circle-outline" actions={[]}>
                <Text style={{ fontWeight: "700" }}>Key not on this device. </Text>
                <Text>{blockedKeyReason} Approving is disabled until then.</Text>
              </Banner>
            ) : null}

            {pending.sign ? (
              <Card mode="contained" style={styles.card}>
                <Card.Content>
                  <Text
                    variant="titleSmall"
                    style={{ fontWeight: "700", marginBottom: 6 }}
                  >
                    {pending.action === "authenticate"
                      ? "Sign-in request"
                      : "Text you are signing"}
                  </Text>
                  <Text
                    variant="bodySmall"
                    selectable
                    style={{
                      fontFamily: Platform.select({
                        ios: "Menlo",
                        android: "monospace",
                        default: "monospace",
                      }),
                      lineHeight: 18,
                    }}
                  >
                    {pending.sign.data}
                  </Text>
                  <Text
                    variant="bodySmall"
                    style={{
                      color: theme.colors.onSurfaceVariant,
                      marginTop: 10,
                    }}
                  >
                    {pending.action === "authenticate" ? (
                      <>
                        Signing proves you hold the {pending.sign.keyType ?? "Posting"}{" "}
                        key for @{activeUsername} and lets {requester} sign
                        you in. It does not move funds. You can revoke this
                        session anytime from Sessions.
                      </>
                    ) : (
                      <>
                        Signing proves you hold the {pending.sign.keyType ?? "Posting"}{" "}
                        key for @{activeUsername}. It does not move funds,
                        publish anything, or write to the blockchain.
                      </>
                    )}
                  </Text>
                </Card.Content>
              </Card>
            ) : (
              pending.decoded.map((op, i) => (
                <OpSummaryCard key={i} op={op} index={i} />
              ))
            )}

            {!authorizing ? (
              <View style={styles.actions}>
                <Button
                  mode="contained"
                  contentStyle={styles.actionBtn}
                  icon={({ size, color }) => <Fingerprint size={size} color={color} />}
                  disabled={!biometricsEnabled || !usableKey || broadcasting}
                  onPress={biometricUnlock}
                >
                  Approve with biometrics
                </Button>
                <Button
                  mode="outlined"
                  contentStyle={styles.actionBtn}
                  icon={({ size, color }) => <KeyRound size={size} color={color} />}
                  disabled={!usableKey || broadcasting}
                  onPress={() => setAuthorizing(true)}
                >
                  Approve with PIN
                </Button>
                <Button
                  mode="text"
                  textColor={theme.colors.error}
                  contentStyle={styles.actionBtn}
                  icon={({ size, color }) => <Ban size={size} color={color} />}
                  onPress={reject}
                >
                  Reject request
                </Button>
              </View>
            ) : (
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
                  title={`Authorize as @${activeAccount?.username ?? ""}`}
                  subtitle="The transaction is signed on this device only."
                  onUnlock={pinUnlock}
                  onCancel={() => setAuthorizing(false)}
                />
              </View>
            )}
          </>
        ) : null}

        {/* Broadcasting */}
        {connection === "sending" ? (
          <View style={styles.broadcastCol}>
            <ProgressBar indeterminate />
            <Text variant="titleMedium" style={{ color: theme.colors.onSurface, fontWeight: "700", marginTop: 10 }}>
              Signing & broadcasting…
            </Text>
            <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant, textAlign: "center" }}>
              Keep the app open — this usually takes a few seconds.
            </Text>
          </View>
        ) : null}

        {/* Result */}
        {connection === "done" && lastResult ? (
          <LinearGradient
            colors={ok ? [...palette.gradientSuccess] : [theme.colors.error, theme.colors.error]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={[styles.resultCard, shadows.card]}
          >
            <View style={styles.resultIcon}>
              {ok ? (
                <CheckCircle2 size={40} color="#fff" />
              ) : (
                <AlertTriangle size={38} color="#fff" />
              )}
            </View>
            <Text variant="titleLarge" style={styles.resultTitle}>
              {ok ? "Approved & broadcast" : "Not completed"}
            </Text>
            <Text variant="bodyMedium" style={styles.resultSub}>
              {lastResult.message}
            </Text>

            {lastResult.txId ? (
              <View style={styles.txRow}>
                {/* Full id — wrapped and selectable; the Copy button is the
                    one-tap path (40 hex chars never fit one line). */}
                <Text variant="bodySmall" selectable style={styles.txText}>
                  {lastResult.txId}
                </Text>
                <Button
                  mode="contained-tonal"
                  compact
                  icon={({ size, color }) =>
                    copied ? <CheckCircle2 size={size} color={color} /> : <Copy size={size} color={color} />
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
              buttonColor="rgba(255,255,255,0.95)"
              textColor="#15803D"
              onPress={close}
              style={styles.doneBtn}
            >
              Done
            </Button>
          </LinearGradient>
        ) : null}


        {/* Error */}
        {connection === "error" && error ? (
          <View style={[styles.errorCard, { backgroundColor: theme.colors.errorContainer }]}>
            <AlertTriangle size={26} color={theme.colors.onErrorContainer} />
            <Text variant="titleMedium" style={{ color: theme.colors.onErrorContainer, fontWeight: "700" }}>
              Request rejected
            </Text>
            <Text variant="bodyMedium" style={{ color: theme.colors.onErrorContainer, textAlign: "center" }}>
              {error}
            </Text>
          </View>
        ) : null}
      </ScrollView>

      {connection === "request" ? null : (
        <Button mode="outlined" onPress={close} style={styles.closeBtn}>
          Close
        </Button>
      )}

      <Snackbar
        visible={!!snack}
        onDismiss={() => setSnack(null)}
        duration={4000}
        // Absolute children ignore the container's padding (measured), so the
        // system-bar floor has to be applied here too — otherwise the toast
        // renders behind the navigation buttons.
        style={{ bottom: systemClearance(insets.bottom) }}
      >
        {snack}
      </Snackbar>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  secureChip: { marginRight: 4 },
  scroll: { gap: 12, paddingBottom: 24, paddingHorizontal: 16, paddingTop: 4 },
  card: { padding: 6 },
  centerCol: { alignItems: "center", gap: 8, paddingVertical: 18 },
  waitIcon: {
    width: 54,
    height: 54,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 4,
  },
  actions: { gap: 10, marginTop: 8 },
  consentRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
    borderRadius: 14,
    borderWidth: 1,
    padding: 12,
    marginTop: 4,
  },
  checkbox: {
    width: 20,
    height: 20,
    borderRadius: 6,
    borderWidth: 2,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 1,
  },
  actionBtn: { height: 46, borderRadius: 14 },
  pinWrap: {
    marginTop: 8,
    padding: 16,
    borderRadius: 24,
    borderWidth: StyleSheet.hairlineWidth,
  },
  broadcastCol: { alignItems: "center", gap: 6, paddingVertical: 26, paddingHorizontal: 10 },
  resultCard: {
    borderRadius: 28,
    padding: 24,
    alignItems: "center",
    gap: 8,
  },
  resultIcon: {
    width: 74,
    height: 74,
    borderRadius: 37,
    backgroundColor: "rgba(255,255,255,0.22)",
    alignItems: "center",
    justifyContent: "center",
  },
  resultTitle: { color: "#fff", fontWeight: "800" },
  resultSub: { color: "rgba(255,255,255,0.92)", textAlign: "center" },
  txRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "rgba(0,0,0,0.25)",
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 14,
    marginTop: 6,
    alignSelf: "stretch",
  },
  txText: { flex: 1, color: "rgba(255,255,255,0.95)" },
  blockPill: {
    backgroundColor: "rgba(0,0,0,0.25)",
    borderRadius: 999,
    paddingVertical: 4,
    paddingHorizontal: 12,
    marginTop: 2,
  },
  blockPillText: { color: "rgba(255,255,255,0.9)", fontWeight: "700" },
  doneBtn: { marginTop: 6, borderRadius: 999 },
  errorCard: {
    borderRadius: 24,
    padding: 20,
    alignItems: "center",
    gap: 8,
    marginTop: 6,
  },
  closeBtn: { marginHorizontal: 16, marginBottom: 8, borderRadius: 999 },
});
