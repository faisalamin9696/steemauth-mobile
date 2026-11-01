import { StyleSheet, View } from "react-native";
import { Card, Chip, IconButton, Text, useTheme } from "react-native-paper";
import { Check } from "lucide-react-native";
import { accountKeys, importedRoles, type StoredAccount } from "@/store/accountsSlice";
import { isKeyRole, roleLabel } from "@/lib/keyRouting";
import { AccountAvatar } from "./AccountAvatar";

/** Green of the "this is the selected account" tick. */
const SELECTED_GREEN = "#16A34A";

interface Props {
  account: StoredAccount;
  active: boolean;
  onPress: () => void;
  onRemove: () => void;
  /** open the "add / replace a key" dialog for this account */
  onEditKeys: () => void;
}

/**
 * One account row.
 *
 * Layout is a hand-rolled row rather than `Card.Title`, because that helper
 * sizes its `left` slot to a fixed 40×40 with its own 16px inset — an avatar
 * given any extra margin then overflows the slot and lands ~30px from the
 * edge while leaving ~2px to the title (the "padding wrong / gap 0" look).
 * Here: 16px leading padding, a real 12px gutter, then the text column.
 *
 * The chips answer "what does this phone actually hold for @user?" - every
 * imported authority and a green tick on the account that is currently
 * selected. Missing keys are added from the key icon on the right: one
 * control for that dialog, not two..
 */
export function AccountCard({ account, active, onPress, onRemove, onEditKeys }: Props) {
  const theme = useTheme();
  const keys = accountKeys(account);
  const roles = importedRoles(account);
  // The pubkey shown belongs to the primary (first imported) key.
  const primaryRole = isKeyRole(account.role) && keys[account.role] ? account.role : roles[0];
  const primaryPub = (primaryRole && keys[primaryRole]) || account.publicKey;

  return (
    <Card
      mode={active ? "contained" : "outlined"}
      style={active ? [styles.active, { borderColor: theme.colors.primary }] : undefined}
      onPress={onPress}
    >
      <View style={styles.row}>
        <AccountAvatar account={account.username} size={44} />

        <View style={styles.body}>
          <Text
            variant="titleMedium"
            numberOfLines={1}
            style={{ color: theme.colors.onSurface, fontWeight: "700" }}
          >
            @{account.username}
          </Text>
          <Text
            variant="labelSmall"
            numberOfLines={1}
            style={{ color: theme.colors.onSurfaceVariant }}
          >
            {primaryRole ? `${roleLabel(primaryRole)} · ` : ""}
            {primaryPub.slice(0, 18)}…
          </Text>

          <View style={styles.chips}>
            {/* Selected account: a green tick, no label — the row already
                says whose keys these are, the tick says which account signs. */}
            {active ? (
              <View
                accessibilityLabel="Currently selected account"
                style={styles.tick}
              >
                <Check size={15} color={SELECTED_GREEN} strokeWidth={3} />
              </View>
            ) : null}

            {roles.map((role) => (
              <Chip
                key={role}
                compact
                mode="outlined"
                onPress={onEditKeys}
                style={styles.chip}
                textStyle={styles.chipText}
              >
                {roleLabel(role)}
              </Chip>
            ))}
          </View>
        </View>

        <View style={styles.actions}>
          <IconButton
            icon="key-outline"
            iconColor={theme.colors.onSurfaceVariant}
            onPress={onEditKeys}
            style={styles.icon}
            accessibilityLabel={`Manage keys for @${account.username}`}
          />
          <IconButton
            icon="trash-can-outline"
            iconColor={theme.colors.error}
            onPress={onRemove}
            style={styles.icon}
            accessibilityLabel={`Remove @${account.username}`}
          />
        </View>
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  active: { borderWidth: 2 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    // 16 matches Card.Content's inset, so the avatar lines up with the text
    // on every other card; 12 is the real gutter between avatar and copy.
    paddingLeft: 16,
    paddingRight: 4,
    paddingVertical: 12,
    gap: 12,
  },
  body: { flex: 1, gap: 2 },
  chips: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: 6,
    marginTop: 6,
  },
  actions: { flexDirection: "row", alignItems: "center" },
  icon: { margin: 0 },
  tick: { width: 16, height: 16, alignItems: "center", justifyContent: "center" },
  // Paper's label ships `minHeight: 24` + `marginVertical: 6` — a ~36px box
  // inside a 26px pill, which is what left the text sitting low. Flatten the
  // label box AND centre the pill's content on both axes: native lays the
  // container out as a column (justifyContent = vertical), web as a row
  // (alignItems = vertical), so it takes both to be centred everywhere.
  chip: {
    height: 26,
    marginVertical: 0,
    justifyContent: "center",
    alignItems: "center",
  },
  chipText: {
    fontSize: 11,
    lineHeight: 16,
    fontWeight: "700",
    minHeight: 0, // beats Paper's label minHeight: 24
    marginVertical: 0, // beats Paper's label marginVertical: 6
    // Android adds ascender/descender padding to the glyph box, which makes
    // centred text look low; the explicit lineHeight already covers it.
    includeFontPadding: false,
  },
});
