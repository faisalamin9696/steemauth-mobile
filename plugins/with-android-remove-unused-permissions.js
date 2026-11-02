/**
 * Local Expo config plugin: strip permissions SteemAuth never uses.
 *
 * Removed (verified unused by grep across src/):
 *  - RECORD_AUDIO           declared only by app.json; the app records no
 *                           audio/video (expo-camera is photo + QR only).
 *  - SYSTEM_ALERT_WINDOW    "display over other apps" - no overlay feature.
 *  - READ_MEDIA_IMAGES      rides in from expo-screen-capture's AAR manifest
 *                           (the module is used only for FLAG_SECURE
 *                           screenshot BLOCKING, which reads no media) - this
 *                           is the one Play asks you to justify.
 *  - READ/WRITE_EXTERNAL_STORAGE (maxSdk 32)  legacy storage; avatars are
 *                           fetched over HTTPS and keys live in the keystore.
 *
 * Two prongs because permissions arrive from two places:
 *  1. filter: plain <uses-permission> entries written into the APP manifest
 *     by app.json / module configs / earlier plugins;
 *  2. tools:node="remove" rules: entries declared by library AAR manifests at
 *     Gradle merge time (app-level filtering cannot see those).
 * Both are idempotent; entries are only added when not already filtered.
 *
 * Kept on purpose: CAMERA (QR scan), INTERNET (relay/RPC/avatars),
 * VIBRATE (haptics), USE_BIOMETRIC + USE_FINGERPRINT (unlock/approve).
 */
const { withAndroidManifest } = require("@expo/config-plugins");

const UNUSED = [
  "android.permission.RECORD_AUDIO",
  "android.permission.SYSTEM_ALERT_WINDOW",
  "android.permission.READ_MEDIA_IMAGES",
  "android.permission.READ_EXTERNAL_STORAGE",
  "android.permission.WRITE_EXTERNAL_STORAGE",
];

module.exports = function withUnusedPermissionRemoval(config) {
  return withAndroidManifest(config, (cfg) => {
    const manifest = cfg.modResults.manifest;
    const perms = manifest["uses-permission"] ?? [];

    // 1. Drop plain entries (app.json / module-config / template sources).
    const kept = perms.filter((p) => !UNUSED.includes(p?.$?.["android:name"]));
    const removedCount = perms.length - kept.length;

    // 2. Merge-rule entries for AAR-declared permissions (e.g. READ_MEDIA_IMAGES
    //    from expo-screen-capture). tools:node="remove" makes the Gradle
    //    manifest merger drop the library's declaration from the final APK.
    for (const name of UNUSED) {
      const alreadyHasRule = kept.some(
        (p) => p?.$?.["android:name"] === name && p.$["tools:node"] === "remove",
      );
      const hasPlainEntry = kept.some(
        (p) => p?.$?.["android:name"] === name && p.$["tools:node"] !== "remove",
      );
      if (alreadyHasRule || hasPlainEntry) continue;
      kept.push({ $: { "android:name": name, "tools:node": "remove" } });
    }

    manifest["uses-permission"] = kept;
    if (removedCount > 0) {
      // eslint-disable-next-line no-console
      console.log(
        `[with-android-remove-unused-permissions] removed ${removedCount} unused permission(s), merge-removal rules in place`,
      );
    }
    return cfg;
  });
};
