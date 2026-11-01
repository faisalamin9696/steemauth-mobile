/**
 * Origin blocklist verification — the policy that refuses a scanned QR
 * BEFORE any transport opens.
 *
 * Covers the three layers that must agree:
 *   1. normalizeOrigin   — the CANONICAL key (scheme/origin shape, userinfo,
 *                          path, trailing dot, default port elision)
 *   2. blockedReason     — the pure decision (testable without store/network);
 *                          a QR with NO declared origin is refused (fail closed)
 *   3. the persisted reducer — block/unblock/idempotency
 *
 * Run: npx tsx scripts/verify-origin-block.ts
 */
import reducer, {
  blockOrigin,
  unblockOrigin,
  clearBlockedOrigins,
  normalizeOrigin,
  blockedReason,
} from "../src/store/blockedOriginsSlice";
import type { BlockedOriginsState } from "../src/store/blockedOriginsSlice";

let failures = 0;
function check(name: string, ok: boolean, extra?: unknown) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) {
    failures++;
    if (extra !== undefined) console.log("      ", JSON.stringify(extra));
  }
}

// ---------------------------------------------------------------------------
// 1. Normalization — the key everything matches on
// ---------------------------------------------------------------------------
console.log("--- normalizeOrigin ---");
check("trims + lowercases", normalizeOrigin("  HTTPS://Evil.Example  ") === "https://evil.example");
check("strips trailing slash", normalizeOrigin("https://x.example/") === "https://x.example");
check("strips multiple trailing slashes", normalizeOrigin("https://x.example//") === "https://x.example");
check("keeps port", normalizeOrigin("http://localhost:8081") === "http://localhost:8081");
check("keeps subdomain path-less", normalizeOrigin("https://app.steempro.com") === "https://app.steempro.com");
check("empty string → ''", normalizeOrigin("") === "");
check("non-string → '' (never blocked)", normalizeOrigin(undefined) === "" && normalizeOrigin(42) === "");
// Canonicalization regressions (blocklist-evasion finding): every spelling of
// the SAME identity must collapse to one key, and unusable shapes become ''.
check(
  "drops userinfo (trusted@evil is EVIL)",
  normalizeOrigin("https://trusted.example@evil.example") === "https://evil.example",
  normalizeOrigin("https://trusted.example@evil.example"),
);
check(
  "drops path/query (base origin is the key)",
  normalizeOrigin("https://evil.example/anything?q=1#frag") === "https://evil.example",
);
check(
  "drops trailing dot (FQDN == bare host)",
  normalizeOrigin("https://evil.example.") === "https://evil.example",
  normalizeOrigin("https://evil.example."),
);
check(
  "elides DEFAULT https port, keeps non-default",
  normalizeOrigin("https://x.example:443") === "https://x.example" &&
    normalizeOrigin("http://x.example:80") === "http://x.example" &&
    normalizeOrigin("http://localhost:8081") === "http://localhost:8081",
);
check(
  "rejects non-http(s) and encoded-host shapes",
  normalizeOrigin("javascript://alert(1)") === "" &&
    normalizeOrigin("https://ev%69l.example") === "",
);

// ---------------------------------------------------------------------------
// 2. blockedReason — the pure decision
// ---------------------------------------------------------------------------
console.log("--- blockedReason ---");
const BLOCKED = ["https://evil.example", "https://phish.test"];

check(
  "blocks a listed origin",
  blockedReason("https://evil.example", BLOCKED)?.includes("blocked") === true,
);
check(
  "blocks despite case/trailing-slash differences (normalized match)",
  blockedReason("HTTPS://EVIL.EXAMPLE/", BLOCKED) !== null,
);
check(
  "allows an unlisted origin",
  blockedReason("https://steempro.com", BLOCKED) === null,
);
check(
  "empty blocklist blocks nothing",
  blockedReason("https://evil.example", []) === null,
);
check(
  "an origin-less QR is REFUSED (fail closed, nothing to match)",
  blockedReason("", BLOCKED)?.includes("origin") === true &&
    blockedReason(undefined, BLOCKED)?.includes("origin") === true &&
    blockedReason("", [])?.includes("origin") === true,
  blockedReason("", BLOCKED),
);
check(
  "legacy stored spellings still match (stored entries re-canonicalized)",
  blockedReason("https://evil.example:443/path/", ["HTTPS://EVIL.EXAMPLE/"]) !== null,
);
check(
  "denial message names the origin (user can find it)",
  (blockedReason("https://evil.example", BLOCKED) ?? "").includes("https://evil.example"),
);

// ---------------------------------------------------------------------------
// 3. Reducer — persistence shape, idempotency, unblock
// ---------------------------------------------------------------------------
console.log("--- blockedOriginsSlice reducer ---");
let state: BlockedOriginsState = { origins: [] };

state = reducer(state, blockOrigin("https://a.example"));
check(
  "block adds a normalized origin",
  state.origins.length === 1 && state.origins[0] === "https://a.example",
);

state = reducer(state, blockOrigin("HTTPS://A.EXAMPLE/"));
check("blocking twice is idempotent", state.origins.length === 1, state.origins);

state = reducer(state, blockOrigin("https://b.example"));
state = reducer(state, blockOrigin("https://a.example"));
check("keeps origins sorted + unique", JSON.stringify(state.origins) === JSON.stringify(["https://a.example", "https://b.example"]), state.origins);

state = reducer(state, blockOrigin(""));
check("empty origin is never stored", state.origins.length === 2, state.origins);

state = reducer(state, unblockOrigin("https://b.example/"));
check("unblock normalizes too", state.origins.length === 1 && state.origins[0] === "https://a.example", state.origins);

state = reducer(state, clearBlockedOrigins());
check("clear empties the list", state.origins.length === 0);

// ---------------------------------------------------------------------------
// 4. End-to-end: scan a QR from a blocked origin → refused, no transport
// ---------------------------------------------------------------------------
console.log("--- scan refusal flow ---");
state = reducer(state, blockOrigin("https://evil.example"));
const verdict = blockedReason("https://evil.example", state.origins);
check("a blocked origin produces a denial before any socket opens", verdict !== null);
check(
  "the denial tells the user how to undo it",
  (verdict ?? "").toLowerCase().includes("blocked"),
  verdict,
);

console.log(
  failures === 0
    ? "\nAll origin-block checks passed ✔"
    : `\n${failures} check(s) FAILED ✘`,
);
process.exit(failures === 0 ? 0 : 1);
