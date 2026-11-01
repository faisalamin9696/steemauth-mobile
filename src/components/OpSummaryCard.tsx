import type { DecodedOperation } from "@/lib/steem/decoder";
import { StyleSheet, View } from "react-native";
import { Card, Chip, Divider, Text, useTheme } from "react-native-paper";
import { roleAccent, roleLabel } from "@/lib/keyRouting";
import { roleAccentColors } from "@/components/theme";

export function OpSummaryCard({
  op,
  index,
}: {
  op: DecodedOperation;
  index: number;
}) {
  const theme = useTheme();
  // Risk-coded key border: posting=green, active=amber (moves funds),
  // owner=red, memo=blue — the stakes are readable before the words.
  const keyAccent = roleAccentColors(theme, roleAccent(op.authority));
  return (
    <Card mode="outlined" style={styles.card}>
      <Card.Title
        title={op.title}
        titleVariant="titleSmall"
        subtitle={`Operation ${index + 1} · ${op.type}`}
        titleStyle={{ color: theme.colors.onSurface, fontWeight: "700" }}
        subtitleStyle={{ color: theme.colors.onSurfaceVariant }}
        right={() => (
          <View style={styles.titleRight}>
            {op.sensitive ? (
              <Chip
                icon="alert"
                compact
                mode="flat"
                style={[styles.chip, { backgroundColor: theme.colors.errorContainer }]}
                textStyle={{ color: theme.colors.onErrorContainer }}
              >
                Sensitive
              </Chip>
            ) : null}
            <Chip
              compact
              mode="outlined"
              style={[styles.chip, { borderColor: keyAccent.border, borderWidth: 1.5 }]}
              textStyle={{ color: keyAccent.text, fontWeight: "700" }}
            >
              {roleLabel(op.authority)} key
            </Chip>
          </View>
        )}
      />
      <Divider />
      <Card.Content style={styles.content}>
        <Text variant="titleSmall" style={{ color: theme.colors.onSurface }}>
          {op.summary}
        </Text>
        {op.fields.map((f, i) => (
          <View key={i} style={styles.row}>
            <Text
              variant="bodySmall"
              style={[styles.fieldLabel, { color: theme.colors.onSurfaceVariant }]}
            >
              {f.label}
            </Text>
            <Text
              variant="bodyMedium"
              style={[
                styles.fieldValue,
                { color: theme.colors.onSurface },
                f.emphasis && styles.emphasis,
                f.warning && { color: theme.colors.error, fontWeight: "600" },
              ]}
            >
              {f.value}
            </Text>
          </View>
        ))}
      </Card.Content>
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { marginBottom: 10 },
  chip: { marginRight: 0 },
  titleRight: { flexDirection: "row", alignItems: "center", gap: 6, marginRight: 8 },
  content: { paddingTop: 10, gap: 4 },
  row: { flexDirection: "row", gap: 8 },
  fieldLabel: { minWidth: 84 },
  fieldValue: { flexShrink: 1 },
  emphasis: { fontWeight: "700" },
});
