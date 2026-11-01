/**
 * System-bar clearance rules — pure, platform-parameterised so they can be
 * tested for every device class without a device (scripts/verify-layout.ts).
 *
 * Why a floor at all: Android edge-to-edge (targetSdk 36) has been observed
 * reporting `insets.bottom === 0` while a 3-button navigation bar still
 * occupies 48dp of the screen. Trusting the reported value is what put the
 * approval buttons — and the modal's Close button — behind the system bar.
 *
 *   native: use the inset, never less than 48dp (covers 3-button nav when it
 *           reports 0; the extra height on gesture-nav devices is a small,
 *           intentional gap above the gesture pill)
 *   web:    there is no system bar — trust the browser (0 on desktop,
 *           env(safe-area-inset-bottom) in mobile browsers)
 */

export type LayoutPlatform = "native" | "web";

/** Bottom clearance for a screen/container. */
export function clearanceFor(platform: LayoutPlatform, bottomInset: number): number {
  if (platform === "web") return bottomInset;
  return Math.max(bottomInset, 48);
}

/** Horizontal-padding-free bottom clearance for tab screens (see theme.ts). */
export function tabClearanceFor(platform: LayoutPlatform, bottomInset: number): number {
  // 88 (8 FloatingTabBar top pad + Paper's 80dp M3 row: 12 top pad + 52
  // icon/label + 16 bottom pad) + 16 breathing room + system bar
  return 88 + 16 + clearanceFor(platform, bottomInset);
}
