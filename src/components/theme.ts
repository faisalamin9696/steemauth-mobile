import { MD3LightTheme, MD3DarkTheme, type MD3Theme } from "react-native-paper";
import { Platform } from "react-native";
import { clearanceFor, tabClearanceFor } from "@/lib/layout";
import type { RoleAccent } from "@/lib/keyRouting";

/**
 * App palette. `brand` feeds the paper theme; `palettes` adds semantic
 * tokens (success/warning/gradients) that work in BOTH modes — screens
 * must read colors from here instead of hardcoding hex values, so text
 * stays readable in dark mode.
 */

interface PaletteColors {
  primary: string;
  onPrimary: string;
  primaryContainer: string;
  onPrimaryContainer: string;
  secondary: string;
  onSecondary: string;
  secondaryContainer: string;
  onSecondaryContainer: string;
  tertiary: string;
  onTertiary: string;
  tertiaryContainer: string;
  onTertiaryContainer: string;
  error: string;
  onError: string;
  errorContainer: string;
  onErrorContainer: string;
  success: string;
  onSuccess: string;
  successContainer: string;
  onSuccessContainer: string;
  warning: string;
  warningContainer: string;
  onWarningContainer: string;
  background: string;
  onBackground: string;
  surface: string;
  onSurface: string;
  surfaceVariant: string;
  onSurfaceVariant: string;
  outline: string;
  outlineVariant: string;
  elevation: {
    level0: string;
    level1: string;
    level2: string;
    level3: string;
    level4: string;
    level5: string;
  };
}

const light: PaletteColors = {
  primary: "#2563EB", // vivid blue (brand — matches the logo tile)
  onPrimary: "#FFFFFF",
  primaryContainer: "#DBE7FF",
  onPrimaryContainer: "#001945",
  secondary: "#0E9F6E", // emerald
  onSecondary: "#FFFFFF",
  secondaryContainer: "#A9F2D4",
  onSecondaryContainer: "#002114",
  tertiary: "#7C3AED", // violet accent
  onTertiary: "#FFFFFF",
  tertiaryContainer: "#EEE5FF",
  onTertiaryContainer: "#25005A",
  error: "#BA1A1A",
  onError: "#FFFFFF",
  errorContainer: "#FFDAD6",
  onErrorContainer: "#410002",
  success: "#15803D",
  onSuccess: "#FFFFFF",
  successContainer: "#D3F5DF",
  onSuccessContainer: "#00210F",
  warning: "#B45309",
  warningContainer: "#FEEFCB",
  onWarningContainer: "#3A2500",
  // Navy-tinted light theme: the neutrals lean blue so the light mode reads
  // as the same brand as the navy icon and the dark mode (no grey-on-brand).
  background: "#F3F6FC",
  onBackground: "#101B33",
  surface: "#FFFFFF",
  onSurface: "#101B33",
  surfaceVariant: "#E6ECF7",
  onSurfaceVariant: "#46536E",
  outline: "#66738C",
  outlineVariant: "#D3DBEB",
  elevation: {
    level0: "transparent",
    level1: "#FFFFFF",
    level2: "#F1F4FA",
    level3: "#E9EDF6",
    level4: "#E7EBF5",
    level5: "#E2E6F2",
  },
};

const dark: PaletteColors = {
  primary: "#A9C6FF",
  onPrimary: "#002E73",
  primaryContainer: "#0A4694",
  onPrimaryContainer: "#DBE7FF",
  secondary: "#52D6AE",
  onSecondary: "#00382A",
  secondaryContainer: "#00523D",
  onSecondaryContainer: "#A9F2D4",
  tertiary: "#C9B7FF",
  onTertiary: "#3B1C78",
  tertiaryContainer: "#53349B",
  onTertiaryContainer: "#EEE5FF",
  error: "#FFB4AB",
  onError: "#690005",
  errorContainer: "#93000A",
  onErrorContainer: "#FFDAD6",
  success: "#7CE8AE",
  onSuccess: "#00391F",
  successContainer: "#005233",
  onSuccessContainer: "#D3F5DF",
  warning: "#F7C66A",
  warningContainer: "#5A3B00",
  onWarningContainer: "#FEEFCB",
  // Wallet navy (fintech dark surfaces): blue-tinted, not neutral grey, so the
  // dark mode reads as the same brand as the navy app icon.
  background: "#0F172A",
  onBackground: "#F1F5F9",
  surface: "#182234",
  onSurface: "#F1F5F9",
  surfaceVariant: "#24304A",
  onSurfaceVariant: "#94A3B8",
  outline: "#94A3B8",
  outlineVariant: "#334155",
  elevation: {
    level0: "transparent",
    level1: "#1B2740",
    level2: "#1F2C46",
    level3: "#243350",
    level4: "#283855",
    level5: "#2C3D5A",
  },
};

export const lightTheme: MD3Theme = {
  ...MD3LightTheme,
  colors: { ...MD3LightTheme.colors, ...light },
} as MD3Theme;

export const darkTheme: MD3Theme = {
  ...MD3DarkTheme,
  colors: { ...MD3DarkTheme.colors, ...dark },
} as MD3Theme;

/** Semantic tokens + gradients per mode. */
export interface AppPalette {
  success: string;
  onSuccess: string;
  successContainer: string;
  onSuccessContainer: string;
  warning: string;
  warningContainer: string;
  onWarningContainer: string;
  /** hero gradient for headers / hero cards */
  gradientHero: readonly [string, string];
  /** QR / primary action gradient */
  gradientQr: readonly [string, string];
  /** success toast / chip gradient */
  gradientSuccess: readonly [string, string];
  /** drawer header gradient */
  gradientDrawer: readonly [string, string];
  /** translucent glass surface for floating bars */
  glass: string;
  glassBorder: string;
}

export const lightPalette: AppPalette = {
  success: light.success,
  onSuccess: light.onSuccess,
  successContainer: light.successContainer,
  onSuccessContainer: light.onSuccessContainer,
  warning: light.warning,
  warningContainer: light.warningContainer,
  onWarningContainer: light.onWarningContainer,
  gradientHero: ["#2563EB", "#0B2A63"],
  gradientQr: ["#1D4ED8", "#2563EB"],
  gradientSuccess: ["#0E9F6E", "#15803D"],
  gradientDrawer: ["#1E40AF", "#0B2A63"],
  glass: "rgba(255,255,255,0.92)",
  glassBorder: "rgba(255,255,255,0.6)",
};

export const darkPalette: AppPalette = {
  success: dark.success,
  onSuccess: dark.onSuccess,
  successContainer: dark.successContainer,
  onSuccessContainer: dark.onSuccessContainer,
  warning: dark.warning,
  warningContainer: dark.warningContainer,
  onWarningContainer: dark.onWarningContainer,
  gradientHero: ["#1D4ED8", "#0A1F44"],
  gradientQr: ["#3B82F6", "#1D4ED8"],
  gradientSuccess: ["#005233", "#0A4694"],
  gradientDrawer: ["#1D4ED8", "#0A1F44"],
  glass: "rgba(23,27,35,0.92)",
  glassBorder: "rgba(255,255,255,0.08)",
};

export function paletteFor(theme: MD3Theme): AppPalette {
  return theme.dark ? darkPalette : lightPalette;
}

/**
 * Resolve a key-role accent (keyRouting's `roleAccent`) to a border/text
 * pair — posting=success, active=warning, owner=error, memo=primary.
 * Readable in BOTH modes; components must never hardcode the hex values.
 */
export function roleAccentColors(
  theme: MD3Theme,
  accent: RoleAccent,
): { border: string; text: string } {
  const c = theme.colors as MD3Theme["colors"] & PaletteColors;
  switch (accent) {
    case "success":
      return { border: c.success, text: c.success };
    case "warning":
      return { border: c.warning, text: c.warning };
    case "error":
      return { border: c.error, text: c.error };
    case "primary":
      return { border: c.primary, text: c.primary };
  }
}

/** Shared elevation shadows (iOS + Android). */
export const shadows = {
  floating: {
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.25,
    shadowRadius: 12,
    elevation: 8,
  },
  card: {
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 6,
    elevation: 2,
  },
} as const;

/**
 * One shape vocabulary for the whole app (react-native-design: a consistent
 * radius scale beats per-screen magic numbers — cards read as a family).
 * sm: chips/inner tiles · md: list rows · lg: cards · xl: hero/feature ·
 * pill: buttons and badges.
 */
export const radii = { sm: 12, md: 16, lg: 20, xl: 24, xxl: 28, pill: 999 } as const;

/**
 * Bottom clearance that works on EVERY device — one rule, used by the tab
 * bar, the approval modal, Settings, Scan, the drawer and the lock screen, so
 * no screen can regress onto its own rule. Rules live in `lib/layout.ts`
 * (pure, tested per platform by scripts/verify-layout.ts); this wrapper just
 * picks the platform.
 */
export function systemClearance(bottomInset: number): number {
  return clearanceFor(Platform.OS === "web" ? "web" : "native", bottomInset);
}

/**
 * Bottom clearance for scrollable content on tab screens.
 *
 * The FloatingTabBar is absolutely positioned and stacks: an 8dp top pad, its
 * row (Paper's 80dp M3 item block — 12 top pad, 52dp icon/label, 16 bottom
 * pad) and `systemClearance(insets.bottom)` (it stretches to the screen edge).
 * Five items sit flush in that row — no raised centre button, so no overhang
 * to clear. Screens used to guess this with 110/120 magic numbers, which were
 * not enough on 3-button nav.
 *
 * Pair it with the bar's own paddingBottom (same helper) so content and bar
 * agree in every nav mode.
 */
export function tabClearance(bottomInset: number): number {
  return tabClearanceFor(Platform.OS === "web" ? "web" : "native", bottomInset);
}
