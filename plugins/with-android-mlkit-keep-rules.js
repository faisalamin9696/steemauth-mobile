/**
 * Local Expo config plugin: keep ML Kit's ComponentRegistrar no-arg
 * constructors alive through R8 (full mode).
 *
 * Why this exists (release-only bug, Play closed testing):
 *  - android/gradle.properties ships `android.enableMinifyInReleaseBuilds=true`,
 *    so every release build goes through R8 full mode.
 *  - ML Kit discovers its components from manifest metadata by REFLECTION,
 *    calling each `ComponentRegistrar`'s no-arg constructor. R8 keeps the
 *    class names but strips those constructors
 *    ("Could not instantiate ...BarcodeRegistrar ... NoSuchMethodException").
 *  - With no components registered, expo-camera's BarcodeAnalyzer init throws
 *    ("Failed to initialize BarcodeAnalyzer: Attempt to read from field ...
 *    on a null object reference"). expo-camera only LOGS that exception, so
 *    the preview renders fine but onBarcodeScanned never fires - QR scanning
 *    silently does nothing. Debug builds never minify, which is why Android
 *    Studio runs scan correctly.
 *
 * The rule is appended idempotently, so repeated prebuilds never duplicate it.
 */
const { withDangerousMod } = require("@expo/config-plugins");
const fs = require("fs");
const path = require("path");

const MARKER = "com.google.firebase.components.ComponentRegistrar";

const RULES = [
  "",
  "# ML Kit (expo-camera QR scanning): keep ComponentRegistrar no-arg",
  "# constructors - R8 full mode strips them and ML Kit instantiates them",
  "# by reflection from manifest metadata. Stripping them breaks",
  "# BarcodeAnalyzer initialization (scan silently never fires).",
  "-keep class * implements com.google.firebase.components.ComponentRegistrar {",
  "  <init>();",
  "}",
  "",
].join("\n");

module.exports = function withMlkitKeepRules(config) {
  return withDangerousMod(config, [
    "android",
    async (cfg) => {
      const file = path.join(
        cfg.modRequest.projectRoot,
        "android",
        "app",
        "proguard-rules.pro",
      );
      const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
      if (!current.includes(MARKER)) {
        fs.writeFileSync(file, current.replace(/\s*$/, "") + "\n" + RULES);
      }
      return cfg;
    },
  ]);
};
