/**
 * Safe-area / system-bar clearance verification.
 *
 * These rules decide where every screen's content ends relative to the device
 * chrome, so they are tested for every device class rather than eyeballed on
 * one phone:
 *
 *   native — trust the reported inset but never go below 48dp. The floor is
 *            the fix for edge-to-edge devices that report 0 behind a 3-button
 *            navigation bar (which is how the approval modal's Close button
 *            ended up under the system buttons).
 *   web    — no system bar: trust the browser's own value (0 on desktop,
 *            env(safe-area-inset-bottom) in mobile browsers).
 *
 * Run: npx tsx scripts/verify-layout.ts
 */
import { clearanceFor, tabClearanceFor } from "../src/lib/layout";

let failures = 0;
function check(name: string, ok: boolean, extra?: unknown): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) {
    failures++;
    if (extra !== undefined) console.log("      ", JSON.stringify(extra));
  }
}

console.log("--- native: reported inset with the 48dp floor ---");
check("inset 0 (edge-to-edge, 3-button nav) -> 48dp floor", clearanceFor("native", 0) === 48, {
  got: clearanceFor("native", 0),
});
check("gesture nav (24dp) -> 48dp (clears the pill with margin)", clearanceFor("native", 24) === 48, {
  got: clearanceFor("native", 24),
});
check("3-button nav (48dp) -> 48dp exactly", clearanceFor("native", 48) === 48);
check("a taller reported inset is honoured, never floored down", clearanceFor("native", 96) === 96);
check("clearance never shrinks as the inset grows (monotonic)",
  clearanceFor("native", 0) <= clearanceFor("native", 24) &&
  clearanceFor("native", 24) <= clearanceFor("native", 48) &&
  clearanceFor("native", 48) <= clearanceFor("native", 96),
);

console.log("--- web: no system bar ---");
check("desktop inset 0 -> 0 (no dead gap under the bottom bar)", clearanceFor("web", 0) === 0);
check("mobile-browser inset is honoured as reported", clearanceFor("web", 34) === 34);

console.log("--- tab screens: content clearance pairs with the bar ---");
// The bar block is 88dp (8 FloatingTabBar top pad + Paper's 80dp M3 row:
// 12 + 52 icon/label + 16) PLUS its own systemClearance; content must clear
// that block by a constant 16dp.
const platforms = ["native", "web"] as const;
const insets = [0, 12, 24, 48, 60, 90];
check(
  "content always clears the bar block by exactly 16dp (every platform/inset)",
  platforms.every((p) => insets.every((inset) => tabClearanceFor(p, inset) - (88 + clearanceFor(p, inset)) === 16)),
);
check("native inset 0 -> 152dp (bar 136 + 16)", tabClearanceFor("native", 0) === 152, {
  got: tabClearanceFor("native", 0),
});
check("web inset 0 -> 104dp (bar 88 + 16)", tabClearanceFor("web", 0) === 104, {
  got: tabClearanceFor("web", 0),
});

process.exit(failures === 0 ? 0 : 1);
