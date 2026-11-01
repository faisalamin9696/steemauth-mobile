import { useCallback, useEffect, useRef, useState, type ComponentRef } from "react";
import {
  Alert,
  Keyboard,
  Platform,
  ScrollView,
  StyleSheet,
  useWindowDimensions,
  View,
} from "react-native";
import {
  Button,
  Chip,
  Dialog,
  Portal,
  SegmentedButtons,
  Text,
  TextInput,
} from "react-native-paper";
import { decodeWif, wifToPublicKey, deriveFromMasterPassword } from "@/lib/steem/keys";
import { isValidAccountName } from "@/lib/steem/decoder";
import { steemRpc, type SteemAccount } from "@/lib/steem/api";
import { ensurePinExists, isBiometricAvailable } from "@/lib/secure";
import { verifyPinLocked, hasPin, saveStoredKey, encryptSecret, encryptForBiometrics, type StoredKey } from "@/lib/vault";
import { KEY_ROLES, roleLabel, type KeyRole } from "@/lib/keyRouting";

type InputMode = "wif" | "master";

const ROLE_HINT: Record<KeyRole, string> = {
  posting: "Post, vote, comment and claim rewards.",
  active: "Transfers, power up/down, stake changes.",
  owner: "Change keys — full control. Store only if you need it.",
  memo: "Read and send encrypted memos.",
};

interface FormProps {
  /** Fixed account → "add another key" mode (no username field). */
  username?: string;
  /** Authorities already on this device — rendered with a check. */
  existing?: readonly KeyRole[];
  biometricsEnabled: boolean;
  onDismiss: () => void;
  /** The key is already in the vault when this fires. */
  onSaved: (record: StoredKey, publicKey: string) => void;
  /** Lets the shell block dismissal while an import is running. */
  onBusyChange: (busy: boolean) => void;
  /** Top edge of the open keyboard (null when closed): drives the dialog
   *  lift + the height cap. Owned by the outer component. */
  keyboardTop: number | null;
  /** Reports the form container's layout height (dialog-lift math). */
  onFrame: (height: number) => void;
}

export interface KeyImportDialogProps
  extends Omit<FormProps, "onBusyChange" | "keyboardTop" | "onFrame"> {
  visible: boolean;
}

/**
 * One dialog for both key flows:
 *
 *  - **create** — first key for a username: creates/validates the device PIN,
 *    the account name is editable;
 *  - **add**    — another authority for an account already on this device
 *    (posting in → active out): the PIN is *verified*, so a key can never be
 *    stored encrypted under a password nobody will ever type again.
 *
 * Both cross-check the derived public key against the chain before storing,
 * when the account exists and the network answers — the most common way to
 * end up with a key that fails at signing time is pasting the wrong WIF. An
 * unreachable network never blocks an import.
 *
 * The form mounts only while the dialog is open (that is why there is no
 * "reset on visible" effect): every open starts from clean initial state and
 * from the authorities the account is still missing.
 */
export function KeyImportDialog(props: KeyImportDialogProps) {
  const { visible, ...form } = props;
  // Read at dismissal time — a ref so an in-flight import needs no re-render
  // to keep the dialog from being dismissed out from under itself.
  const busyRef = useRef(false);
  const handleDismiss = () => {
    if (!busyRef.current) form.onDismiss();
  };

  // ---- Keyboard lift ------------------------------------------------------
  // This dialog lives in an RN Modal whose window does NOT resize for the
  // keyboard on real devices (edge-to-edge Android), so neither the
  // manifest's adjustResize nor a behavior-less KeyboardAvoidingView moves
  // it: the keyboard simply overlays the lower half. Measure the dialog box
  // (vertically centered in the full-screen modal) against the keyboard's
  // top edge and translate the WHOLE Dialog by the overlap. Self-correcting:
  // if a window does resize/pan, the overlap measures <= 0 and nothing moves.
  const [keyboardTop, setKeyboardTop] = useState<number | null>(null);
  const [shift, setShift] = useState(0);
  const keyboardTopRef = useRef<number | null>(null);
  const containerH = useRef(0);
  const { height } = useWindowDimensions();
  const heightRef = useRef(height);
  useEffect(() => {
    heightRef.current = height;
  }, [height]);

  const recompute = useCallback(() => {
    const top = keyboardTopRef.current;
    if (top == null || containerH.current <= 0) {
      setShift(0);
      return;
    }
    // Box bottom when centered: (window + box height) / 2. Margins are
    // symmetric so they cancel out of the centering math.
    const boxBottom = (heightRef.current + containerH.current) / 2;
    const overlap = Math.max(0, Math.round(boxBottom - top));
    setShift((prev) => (prev === overlap ? prev : overlap));
  }, []);

  useEffect(() => {
    const showEvent = Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow";
    const hideEvent = Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide";
    const shown = Keyboard.addListener(showEvent, (e) => {
      const kbH = Math.round(e.endCoordinates.height);
      const top =
        e.endCoordinates.screenY > 0
          ? Math.round(e.endCoordinates.screenY)
          : heightRef.current - kbH;
      keyboardTopRef.current = top;
      setKeyboardTop(top);
      recompute();
    });
    const hidden = Keyboard.addListener(hideEvent, () => {
      keyboardTopRef.current = null;
      setKeyboardTop(null);
      setShift(0);
    });
    return () => {
      shown.remove();
      hidden.remove();
    };
  }, [recompute]);

  // A stale lift after closing is handled by DERIVED gating (below) - the
  // keyboard's own hide event clears the real state in its listener.

  const handleFrame = useCallback(
    (h: number) => {
      containerH.current = h;
      recompute();
    },
    [recompute],
  );

  return (
    <Portal>
      <Dialog
        visible={visible}
        onDismiss={handleDismiss}
        // ALWAYS carry the transform key: switching between {transform:[…]}
        // and undefined removes the key, and Fabric's restore path coerces
        // the missing value to null -> processTransform(null) crashes with
        // "Cannot read property 'forEach' of null" (Paper Surface writes the
        // possibly-undefined transform back into the style verbatim).
        style={{ transform: [{ translateY: visible && shift > 0 ? -shift : 0 }] }}
      >
        {visible ? (
          <KeyImportForm
            {...form}
            keyboardTop={visible ? keyboardTop : null}
            onFrame={handleFrame}
            onBusyChange={(busy) => {
              busyRef.current = busy;
            }}
          />
        ) : null}
      </Dialog>
    </Portal>
  );
}

function KeyImportForm({
  username,
  existing,
  biometricsEnabled,
  onDismiss,
  onSaved,
  onBusyChange,
  keyboardTop,
  onFrame,
}: FormProps) {
  const { height } = useWindowDimensions();
  const addMode = Boolean(username);
  const initialRole = ((): KeyRole => {
    const missing = KEY_ROLES.filter((r) => !(existing ?? []).includes(r));
    return missing[0] ?? "posting";
  })();

  const [mode, setMode] = useState<InputMode>("wif");
  const [name, setName] = useState(username ?? "");
  const [role, setRole] = useState<KeyRole>(initialRole);
  const [secret, setSecret] = useState("");
  const [pin, setPin] = useState("");
  const [pin2, setPin2] = useState("");
  const [busy, setBusyState] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ---- Keyboard-aware reveal -------------------------------------------
  // RN never scrolls a focused input into view by itself, and inside this
  // height-capped dialog the lower fields (the PIN rows) live below the fold
  // until something does. Track every field's offset in the scroll content
  // and jump its top just under the frame's top on focus - re-running once
  // the keyboard has finished resizing the dialog (iOS lifts via the
  // KeyboardAvoidingView below, Android resizes via adjustResize).
  const scrollRef = useRef<ComponentRef<typeof ScrollView>>(null);
  const focusedField = useRef<string | null>(null);
  const viewportH = useRef(0);
  const groupY = useRef(0);
  const fieldY = useRef<Record<string, number>>({});
  const scrollY = useRef(0);

  const revealField = useCallback((key: string) => {
    const y = groupY.current + (fieldY.current[key] ?? 0);
    const view = viewportH.current;
    if (!view) return;
    const cur = scrollY.current;
    // Out of frame (above or below) -> put the field's top 16dp under the
    // frame's top. Already comfortably visible -> leave the user's scroll.
    if (y - 16 < cur || y + 64 > cur + view) {
      scrollRef.current?.scrollTo({ y: Math.max(0, y - 16), animated: true });
    }
  }, []);

  const focusField = useCallback(
    (key: string) => {
      focusedField.current = key;
      revealField(key);
    },
    [revealField],
  );

  // Keyboard arrived: give the dialog a beat to re-cap its height (and the
  // outer lift to translate it), then pull the focused field back into view
  // if the re-layout moved it.
  useEffect(() => {
    if (keyboardTop == null) {
      focusedField.current = null;
      return;
    }
    const key = focusedField.current;
    if (!key) return;
    const id = setTimeout(() => revealField(key), 120);
    return () => clearTimeout(id);
  }, [keyboardTop, revealField]);

  const setBusy = useCallback(
    (value: boolean) => {
      setBusyState(value);
      onBusyChange(value);
    },
    [onBusyChange],
  );

  const submit = useCallback(async () => {
    setError(null);
    const accountName = (username ?? name).trim().replace(/^@/, "");
    if (!isValidAccountName(accountName)) {
      setError("Enter a valid Steem account name.");
      return;
    }
    if (pin.length !== 6) {
      setError("Enter your 6-digit device PIN.");
      return;
    }
    if (!addMode && pin !== pin2) {
      setError("Choose a 6-digit PIN and confirm it.");
      return;
    }

    setBusy(true);
    try {
      if (addMode) {
        // Storing a key under a mistyped PIN would make it permanently
        // undecryptable — verify before writing anything. The LOCKOUT-
        // ENFORCING variant is mandatory here: this dialog used to call the
        // bare verifyPin, which never reads or registers failures — an
        // unbounded PIN oracle beside the very lockout the code cites as
        // compensation for the 8k KDF cost.
        const check = await verifyPinLocked(pin);
        if (!check.ok) {
          setError(
            check.lockedForMs > 0
              ? "Too many attempts — PIN entry is temporarily disabled."
              : "That PIN does not match this device.",
          );
          return;
        }
      } else if (await hasPin()) {
        // The device PIN already exists (first run or first account): it is
        // the ONLY passphrase stored keys decrypt with, so verify it here —
        // ensurePinExists would silently no-op and a typo would brick the key.
        const check = await verifyPinLocked(pin);
        if (!check.ok) {
          setError(
            check.lockedForMs > 0
              ? "Too many attempts — PIN entry is temporarily disabled."
              : "That PIN does not match this device.",
          );
          return;
        }
      } else {
        await ensurePinExists(pin);
      }

      // One chain read validates every key we are about to store.
      const chain = await fetchChainAccount(accountName);

      // A master password derives each authority itself (sha256 of
      // user+role+password), so it imports ALL of them; a pasted WIF is one
      // particular key and follows the authority chosen above.
      const roles: KeyRole[] = mode === "master" ? [...KEY_ROLES] : [role];

      let pastedWif: string | null = null;
      if (mode === "wif") {
        pastedWif = secret.trim();
        decodeWif(pastedWif); // throws for anything that is not a valid WIF
      }

      const stored: string[] = [];
      const skipped: string[] = [];
      for (const authority of roles) {
        const wif =
          pastedWif ?? deriveFromMasterPassword(accountName, secret.trim(), authority);
        const publicKey = wifToPublicKey(wif);

        // Never store a key the chain says is not this account's: a master
        // password that no longer matches (keys were rotated) would fill the
        // vault with keys that can never sign. Offline → store what we have.
        if (chain) {
          const expected = expectedPubkeysFor(chain, authority);
          if (expected.length > 0 && !expected.includes(publicKey)) {
            skipped.push(roleLabel(authority));
            continue;
          }
        }

        const record: StoredKey = {
          username: accountName,
          authority,
          encKey: encryptSecret(wif, pin),
          createdAt: Date.now(),
        };
        if (biometricsEnabled && (await isBiometricAvailable())) {
          record.bioKey = await encryptForBiometrics(wif, accountName);
        }
        await saveStoredKey(record);
        onSaved(record, publicKey);
        stored.push(roleLabel(authority));
      }

      if (stored.length === 0) {
        setError(
          mode === "master"
            ? `That master password does not match @${accountName}'s keys on chain — nothing was stored.`
            : `This ${roleLabel(role)} key does not match @${accountName}'s ${roleLabel(
                role,
              )} key on chain — check which key you used.`,
        );
        return;
      }
      // Partial success (rotated keys) still closes — but says exactly what
      // made it in, so nothing is silently missing from the card.
      if (skipped.length > 0) {
        Alert.alert(
          "Imported with a note",
          `Stored ${stored.join(", ")}. ${skipped.join(", ")} ${
            skipped.length > 1 ? "do not match" : "does not match"
          } this account on chain, so ${skipped.length > 1 ? "they were" : "it was"} skipped.`,
        );
      }
      onDismiss();
    } catch (e) {
      // Logcat visibility: this failure previously existed ONLY as dialog
      // text, which made the report impossible to diagnose remotely.
      console.error(
        "[steemauth] key import failed:",
        e instanceof Error ? e.message : e,
      );
      setError(
        e instanceof Error ? e.message : "Could not import this key. Check the credentials.",
      );
      return;
    } finally {
      setBusy(false);
    }
  }, [
    username,
    name,
    role,
    mode,
    secret,
    pin,
    pin2,
    addMode,
    biometricsEnabled,
    onSaved,
    onDismiss,
    setBusy,
  ]);

  // Height visible above the keyboard: the modal window never resizes on
  // real devices, so the ceiling is the keyboard's top edge (null -> the
  // plain window height).
  const usableHeight = Math.min(height, keyboardTop ?? height);

  return (
    // Measured for the dialog-level keyboard lift: the outer component
    // translates the whole Dialog by the keyboard overlap (see there).
    <View onLayout={(e) => onFrame(e.nativeEvent.layout.height)}>
      <Dialog.Title>
        {addMode
          ? `${mode === "master" ? "Add keys" : "Add a key"} for @${username}`
          : "Add Steem account"}
      </Dialog.Title>
      <Dialog.Content
        style={[
          styles.dialog,
          // A fixed 440 overflows a short window (or one with the keyboard
          // up); cap against the VISIBLE height (iOS: full height minus the
          // keyboard, Android: already shrunk by adjustResize) with room for
          // the title + actions chrome, so the whole dialog always fits
          // above the keyboard.
          { maxHeight: Math.max(120, Math.min(440, usableHeight - 136)) },
        ]}
      >
        <ScrollView
          ref={scrollRef}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.form}
          scrollEventThrottle={16}
          onScroll={(e) => {
            scrollY.current = e.nativeEvent.contentOffset.y;
          }}
          onLayout={(e) => {
            viewportH.current = e.nativeEvent.layout.height;
          }}
        >
          {/* How the key is supplied + which authority it belongs to */}
          <View style={styles.group}>
            {/* Both modes in both flows: an account imported from a master
                password must be able to add its active key the same way. */}
            <SegmentedButtons
              value={mode}
              onValueChange={(v) => setMode(v as InputMode)}
              buttons={[
                { value: "wif", label: "WIF key" },
                { value: "master", label: "Master password" },
              ]}
            />

            {/* A pasted WIF is one specific key → ask which authority it is.
                A master password derives every authority itself, so showing a
                picker would be a lie: it imports them ALL (each one verified
                against the chain before it is stored). */}
            {mode === "wif" ? (
              <View style={styles.authority}>
                <Text variant="labelLarge" style={styles.section}>
                  Key authority
                </Text>
                <View style={styles.roles}>
                  {KEY_ROLES.map((r) => (
                    <Chip
                      key={r}
                      compact
                      mode={role === r ? "flat" : "outlined"}
                      selected={role === r}
                      onPress={() => setRole(r)}
                      style={styles.roleChip}
                    >
                      {roleLabel(r)}
                      {(existing ?? []).includes(r) ? "  ✓" : ""}
                    </Chip>
                  ))}
                </View>
                <Text variant="bodySmall" style={styles.hint}>
                  {ROLE_HINT[role]}
                  {existing?.includes(role)
                    ? " You already have this key on this device — importing again replaces it."
                    : ""}
                </Text>
              </View>
            ) : (
              <Text variant="bodySmall" style={styles.hint}>
                Your master password derives every key: posting, active, owner and
                memo are imported and stored separately on this device.
                {(existing ?? []).length > 0
                  ? " Keys you already have are only replaced when the derived key is the one on chain."
                  : ""}
              </Text>
            )}
          </View>

          {/* Identity + unlock — separated from the authority block above */}
          <View
            style={styles.group}
            onLayout={(e) => {
              groupY.current = e.nativeEvent.layout.y;
            }}
          >
            {!addMode ? (
              <TextInput
                label="Account name"
                autoCapitalize="none"
                autoCorrect={false}
                value={name}
                onChangeText={setName}
                onFocus={() => focusField("name")}
                onLayout={(e) => {
                  fieldY.current.name = e.nativeEvent.layout.y;
                }}
              />
            ) : null}

            <TextInput
              label={mode === "wif" ? `${roleLabel(role)} WIF key` : "Master password"}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              value={secret}
              onChangeText={setSecret}
              onFocus={() => focusField("secret")}
              onLayout={(e) => {
                fieldY.current.secret = e.nativeEvent.layout.y;
              }}
            />

            <TextInput
              label="Device PIN (6 digits)"
              keyboardType="number-pad"
              secureTextEntry
              maxLength={6}
              value={pin}
              onChangeText={setPin}
              onFocus={() => focusField("pin")}
              onLayout={(e) => {
                fieldY.current.pin = e.nativeEvent.layout.y;
              }}
            />
            {!addMode ? (
              <TextInput
                label="Confirm PIN"
                keyboardType="number-pad"
                secureTextEntry
                maxLength={6}
                value={pin2}
                onChangeText={setPin2}
                onFocus={() => focusField("pin2")}
                onLayout={(e) => {
                  fieldY.current.pin2 = e.nativeEvent.layout.y;
                }}
              />
            ) : null}

            {error ? (
              <Text variant="bodySmall" style={styles.error}>
                {error}
              </Text>
            ) : null}
          </View>
        </ScrollView>
      </Dialog.Content>
      <Dialog.Actions>
        <Button onPress={onDismiss} disabled={busy}>
          Cancel
        </Button>
        <Button onPress={() => void submit()} loading={busy} disabled={busy}>
          {addMode ? (mode === "master" ? "Add keys" : "Add key") : "Import"}
        </Button>
      </Dialog.Actions>
    </View>
  );
}

/** The account as the chain knows it, or null when it cannot be fetched
 *  (account not created yet, or every node unreachable — an import must
 *  keep working offline). */
async function fetchChainAccount(accountName: string): Promise<SteemAccount | null> {
  try {
    return await steemRpc.getAccount(accountName);
  } catch {
    return null;
  }
}

/** Public keys the chain expects for this authority. */
function expectedPubkeysFor(account: SteemAccount, role: KeyRole): string[] {
  if (role === "memo") {
    return account.memo_key ? [account.memo_key] : [];
  }
  return (account[role].key_auths ?? []).map(([key]) => key);
}

const styles = StyleSheet.create({
  dialog: { maxHeight: 440 },
  /** between the authority block and the fields below it */
  form: { gap: 16 },
  /** within a group: mode picker → authority, and field → field */
  group: { gap: 10 },
  /** "Key authority" → its chips → the hint under them */
  authority: { gap: 8 },
  section: { fontWeight: "700" },
  roles: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  roleChip: { marginVertical: 0 },
  hint: { opacity: 0.75 },
  error: { color: "#ba1a1a" },
});
