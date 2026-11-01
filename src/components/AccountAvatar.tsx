// ---------------------------------------------------------------------------
// SteemAuth :: components/AccountAvatar.tsx
//
// A Steem account portrait in a circle. The picture comes from
// steemitimages (src/lib/avatar.ts picks the right size); expo-image keeps
// every fetched URL in memory + on disk (cachePolicy="memory-disk"), so a
// portrait is painted from local storage after its first appearance — on
// every screen and across relaunches. That is the React Native counterpart
// of the service-worker Cache Storage the web builds use.
//
// An account that does not exist answers 200 with JSON, not a picture, so
// the *decode* is what fails — onError flips to the initials and the
// picture never shows. Until the load finishes the initials are painted
// underneath and the image fades in on top (transition), so the circle is
// never empty.
//
// Dependency: expo-image only.
// ---------------------------------------------------------------------------
import { memo, useEffect, useState } from "react";
import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { Image } from "expo-image";
import { Text, useTheme } from "react-native-paper";
import { useAppSelector } from "@/store/hooks";
import { avatarUrl, avatarVariantFor } from "@/lib/avatar";

type ImageState = "loading" | "ready" | "failed";

interface Props {
  account: string;
  /** drawn size in logical pixels (the fetch size is doubled for retina) */
  size?: number;
  /** ring / border / spacing around the circle */
  style?: StyleProp<ViewStyle>;
}

export const AccountAvatar = memo(function AccountAvatar({
  account,
  size = 40,
  style,
}: Props) {
  const theme = useTheme();
  const [state, setState] = useState<ImageState>("loading");
  // Consent gate (confirmed disclosure finding): remote fetches are OPT-IN.
  // With the setting off (the default) no URL is ever built and the local
  // letter tile renders — zero third-party egress. Toggling the setting
  // changes `url`, which resets the load cycle via the effect below.
  const remoteAvatars = useAppSelector((s) => s.settings.remoteAvatarsEnabled);
  const url = remoteAvatars ? avatarUrl(account, avatarVariantFor(size)) : null;

  // New account (or size → new URL): start the cycle over.
  useEffect(() => {
    setState("loading");
  }, [url]);

  const circle = {
    width: size,
    height: size,
    borderRadius: size / 2,
    backgroundColor: theme.colors.surfaceVariant,
  };

  return (
    <View style={[circle, styles.clip, style]}>
      {/* initials underneath — visible until the picture covers them */}
      <View style={styles.center} pointerEvents="none">
        <Text
          variant={size >= 48 ? "titleMedium" : "labelLarge"}
          style={{
            color: theme.colors.onSurfaceVariant,
            fontWeight: "800",
            fontSize: size * 0.38,
          }}
        >
          {account.slice(0, 1).toUpperCase()}
        </Text>
      </View>

      {url && state !== "failed" ? (
        <Image
          source={{ uri: url }}
          style={StyleSheet.absoluteFill}
          contentFit="cover"
          cachePolicy="memory-disk"
          transition={220}
          onLoad={() => setState("ready")}
          onError={() => setState("failed")}
        />
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  clip: { overflow: "hidden" },
  center: {
    position: "absolute",
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    alignItems: "center",
    justifyContent: "center",
  },
});
