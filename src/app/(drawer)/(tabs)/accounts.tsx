import { useCallback, useState } from "react";
import { Alert, ScrollView, StyleSheet, View } from "react-native";
import { Button, Card, Text, useTheme } from "react-native-paper";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { tabClearance } from "@/components/theme";
import { UserPlus, Plus } from "lucide-react-native";
import { ScreenHeader } from "@/components/ScreenHeader";
import { useAppDispatch, useAppSelector } from "@/store/hooks";
import {
  upsertAccount,
  upsertAccountKey,
  removeAccount,
  setActiveAccount,
  importedRoles,
  type KeyRole,
} from "@/store/accountsSlice";
import { AccountCard } from "@/components/AccountCard";
import { KeyImportDialog } from "@/components/KeyImportDialog";
import { deleteStoredKeys, type StoredKey } from "@/lib/vault";
import { isKeyRole } from "@/lib/keyRouting";

export default function AccountsScreen() {
  const dispatch = useAppDispatch();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { accounts, activeUsername } = useAppSelector((s) => s.accounts);
  const biometricsEnabled = useAppSelector((s) => s.settings.biometricsEnabled);

  const [dialogOpen, setDialogOpen] = useState(false);
  /** Account whose keys are being managed (the "add the active key" flow). */
  const [managingName, setManagingName] = useState<string | null>(null);
  // Re-resolved from the store each render so a removal under an open dialog
  // can't leave a stale target behind.
  const managing = managingName
    ? (accounts.find((a) => a.username === managingName) ?? null)
    : null;

  /** First import: create the account record + the redux mirror. */
  const handleCreated = useCallback(
    (record: StoredKey, publicKey: string) => {
      const role: KeyRole = isKeyRole(record.authority) ? record.authority : "posting";
      dispatch(
        upsertAccount({
          username: record.username,
          publicKey,
          encryptedWif: record.encKey,
          role,
          keys: { [role]: publicKey },
          createdAt: record.createdAt,
          updatedAt: Date.now(),
        }),
      );
      dispatch(setActiveAccount(record.username));
    },
    [dispatch],
  );

  /** Additional key for an account already here: one more slot, one chip. */
  const handleAddedKey = useCallback(
    (record: StoredKey, publicKey: string) => {
      const role: KeyRole = isKeyRole(record.authority) ? record.authority : "posting";
      dispatch(
        upsertAccountKey({
          username: record.username,
          authority: role,
          publicKey,
        }),
      );
    },
    [dispatch],
  );

  const confirmRemove = (name: string) => {
    Alert.alert("Remove account", `Remove @${name} from this device?`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Remove",
        style: "destructive",
        onPress: async () => {
          // Keys FIRST, then the mirror: the reverse order (mirror gone,
          // deletion unawaited) leaves an empty accounts slice next to
          // surviving vault records, which the cold-start lock reads as
          // "nothing to protect" (confirmed finding). Failure now surfaces
          // and the mirror stays intact (locked + retryable).
          try {
            await deleteStoredKeys(name);
            dispatch(removeAccount(name));
          } catch {
            Alert.alert(
              "Removal failed",
              "The stored keys could not be removed. Please try again.",
            );
          }
        },
      },
    ]);
  };

  return (
    <SafeAreaView
      style={[styles.container, { backgroundColor: theme.colors.background }]}
      edges={["top"]}
    >
      <ScreenHeader
        title="Accounts"
        subtitle="Keys are encrypted and stored only on this device"
      />
      <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        {accounts.map((a) => (
          <AccountCard
            key={a.username}
            account={a}
            active={a.username === activeUsername}
            onPress={() => dispatch(setActiveAccount(a.username))}
            onRemove={() => confirmRemove(a.username)}
            onEditKeys={() => setManagingName(a.username)}
          />
        ))}

        {accounts.length === 0 ? (
          <Card mode="contained" style={styles.card}>
            <Card.Content>
              <View style={styles.emptyState}>
                <UserPlus size={38} color={theme.colors.primary} />
                <Text variant="titleMedium" style={{ color: theme.colors.onSurface }}>
                  No accounts yet
                </Text>
                <Text variant="bodyMedium" style={[styles.dim, { textAlign: "center" }]}>
                  Add a Steem account to start approving actions from the web
                  app. Your private key is encrypted with your PIN before it is
                  ever stored.
                </Text>
              </View>
            </Card.Content>
          </Card>
        ) : null}

        <Button
          mode="contained"
          icon={({ size, color }) => <Plus size={size} color={color} />}
          onPress={() => setDialogOpen(true)}
          style={styles.addBtn}
        >
          Add account
        </Button>
        <View style={{ height: tabClearance(insets.bottom) }} />
      </ScrollView>

      <KeyImportDialog
        visible={dialogOpen}
        biometricsEnabled={biometricsEnabled}
        onDismiss={() => setDialogOpen(false)}
        onSaved={handleCreated}
      />

      <KeyImportDialog
        visible={managing !== null}
        username={managing?.username}
        existing={managing ? importedRoles(managing) : undefined}
        biometricsEnabled={biometricsEnabled}
        onDismiss={() => setManagingName(null)}
        onSaved={handleAddedKey}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  scroll: { paddingHorizontal: 16, gap: 12, paddingTop: 8 },
  dim: { opacity: 0.7 },
  card: { padding: 4 },
  addBtn: { marginTop: 4 },
  emptyState: { alignItems: "center", gap: 8, paddingVertical: 14 },
});
