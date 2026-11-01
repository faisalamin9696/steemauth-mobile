/**
 * Key routing verification — which stored key may sign a request, and what
 * the phone says when it has none.
 *
 * `lib/keyRouting.ts` is deliberately store/RPC-free so the rules that gate
 * every approval are testable under plain Node (same reason as
 * `steem/authority`).
 *
 * The invariants under test:
 *   - a request is never signed with a WEAKER key than it requires;
 *   - the exact key wins when present (least privilege);
 *   - a stronger key may stand in for a weaker one (active signs for posting);
 *   - memo is exact-only — it is not part of the broadcast ladder;
 *   - an unsatisfiable request produces a message naming the key to add;
 *   - legacy single-key accounts still read as { role: publicKey }.
 *
 * Run: npx tsx scripts/verify-key-routing.ts
 */
import {
  requiredKeyAuthority,
  pickKeyAuthority,
  missingKeyReason,
  isKeyRole,
  roleAccent,
  KEY_ROLES,
  roleLabel,
  type KeyRole,
} from "../src/lib/keyRouting";
import accountsReducer, {
  accountKeys,
  importedRoles,
  upsertAccount,
  upsertAccountKey,
  type StoredAccount,
} from "../src/store/accountsSlice";

let failures = 0;
function check(name: string, ok: boolean, extra?: unknown) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) {
    failures++;
    if (extra !== undefined) console.log("      ", JSON.stringify(extra));
  }
}

const op = (type: string, params: Record<string, unknown> = {}): [string, Record<string, unknown>] => [type, params];

// ---------------------------------------------------------------------------
console.log("--- requiredKeyAuthority: what the request demands ---");
check("sign request defaults to posting", requiredKeyAuthority([], { keyType: undefined }) === "posting");
check(
  "sign request honours its keyType",
  requiredKeyAuthority([], { keyType: "Active" }) === "active",
);
check(
  "unrecognised keyType falls back to posting (weakest key)",
  requiredKeyAuthority([], { keyType: "whatever" }) === "posting",
);
check("comment needs posting", requiredKeyAuthority([op("comment")]) === "posting");
check("vote needs posting", requiredKeyAuthority([op("vote")]) === "posting");
check("claim_reward_balance needs posting", requiredKeyAuthority([op("claim_reward_balance")]) === "posting");
check("transfer needs active", requiredKeyAuthority([op("transfer")]) === "active");
check("withdraw_vesting needs active", requiredKeyAuthority([op("withdraw_vesting")]) === "active");
check("account_update needs active", requiredKeyAuthority([op("account_update")]) === "active");
check(
  "custom_json without required_auths → posting",
  requiredKeyAuthority([op("custom_json", { id: "steemcurator001", json: "{}", required_posting_auths: ["alice"] })]) === "posting",
);
check(
  "custom_json with required_auths → active",
  requiredKeyAuthority([op("custom_json", { id: "steemconnect", json: "{}", required_auths: ["alice"] })]) === "active",
);
check(
  "mixed batch takes the strongest (vote + transfer)",
  requiredKeyAuthority([op("vote"), op("transfer")]) === "active",
);
check("empty ops → posting", requiredKeyAuthority([]) === "posting");
check("undefined ops → posting", requiredKeyAuthority(undefined) === "posting");
check(
  "garbage entries are ignored, not crashy",
  requiredKeyAuthority([42, null, "vote", op("transfer")]) === "active",
);
check(
  "broadcast wins over a sign request's weaker keyType only via ops path",
  requiredKeyAuthority([op("transfer")], undefined) === "active",
);

// ---------------------------------------------------------------------------
console.log("--- pickKeyAuthority: which stored key is used ---");
const cases: Array<[string, KeyRole[], KeyRole, KeyRole | null]> = [
  ["exact posting match", ["posting"], "posting", "posting"],
  ["posting-only device cannot sign active", ["posting"], "active", null],
  ["posting-only device cannot sign owner", ["posting"], "owner", null],
  ["both held → exact wins (least privilege)", ["posting", "active"], "posting", "posting"],
  ["active held → may sign for posting", ["active"], "posting", "active"],
  ["owner held → may sign for active", ["owner"], "active", "owner"],
  ["posting+owner, needs active → owner (weakest sufficient)", ["posting", "owner"], "active", "owner"],
  ["only owner can sign owner", ["posting", "active"], "owner", null],
  ["nothing held → null", [], "posting", null],
  ["memo is exact-only", ["posting"], "memo", null],
  ["memo held → memo", ["posting", "memo"], "memo", "memo"],
  ["posting held cannot sign memo", ["posting", "active", "owner"], "memo", null],
];
for (const [name, available, required, expected] of cases) {
  check(`${name} → ${expected ?? "blocked"}`, pickKeyAuthority(available, required) === expected, {
    available,
    required,
    got: pickKeyAuthority(available, required),
  });
}

// Never a weaker key — walk every pairing to be sure.
const LADDER: KeyRole[] = ["posting", "active", "owner"];
const RANK: Record<string, number> = { memo: 0, posting: 1, active: 2, owner: 3 };
for (const have of LADDER) {
  for (const need of LADDER) {
    const picked = pickKeyAuthority([have], need);
    if (picked !== null && RANK[picked]! < RANK[need]!) {
      check(`NEVER weaker: ${have} for ${need}`, false, { picked, need });
    }
  }
}
check("no weaker key is ever chosen (ladder sweep)", true);

// ---------------------------------------------------------------------------
console.log("--- missingKeyReason: the message shown instead of a chain error ---");
check("no reason when usable", missingKeyReason(["posting"], "posting") === null);
const reason = missingKeyReason(["posting"], "active");
check(
  "names the key to add",
  typeof reason === "string" && reason.includes("Active key"),
  reason,
);
check(
  "points at the screen where it can be added",
  typeof reason === "string" && reason.includes("Accounts"),
  reason,
);
check(
  "memo reason names the memo key",
  missingKeyReason(["posting"], "memo")?.includes("Memo key") === true,
  missingKeyReason(["posting"], "memo"),
);

// ---------------------------------------------------------------------------
console.log("--- role helpers ---");
check(
  "KEY_ROLES is the four Steem authorities",
  JSON.stringify(KEY_ROLES) === JSON.stringify(["posting", "active", "owner", "memo"]),
  KEY_ROLES,
);
check("isKeyRole accepts valid roles", KEY_ROLES.every((r) => isKeyRole(r)));
check("isKeyRole rejects garbage", !isKeyRole("root") && !isKeyRole(7) && !isKeyRole(undefined));
check("roleLabel capitalizes", roleLabel("active") === "Active" && roleLabel("posting") === "Posting");

// ---------------------------------------------------------------------------
console.log("--- StoredAccount: multi-key records + legacy normalization ---");
const legacy: StoredAccount = {
  username: "alice",
  publicKey: "STM5LEGACY",
  encryptedWif: "enc",
  role: "posting",
  createdAt: 1,
  updatedAt: 1,
};
check(
  "legacy record reads as its single key",
  JSON.stringify(accountKeys(legacy)) === JSON.stringify({ posting: "STM5LEGACY" }),
  accountKeys(legacy),
);
check("legacy record shows one chip", importedRoles(legacy).join(",") === "posting", importedRoles(legacy));

const modern: StoredAccount = {
  ...legacy,
  keys: { active: "STM5ACTIVE", posting: "STM5POSTING" },
};
check(
  "multi-key record keeps both",
  JSON.stringify(accountKeys(modern)) === JSON.stringify({ active: "STM5ACTIVE", posting: "STM5POSTING" }),
  accountKeys(modern),
);
check(
  "chips render strongest first (owner → active → posting → memo)",
  importedRoles({ ...legacy, keys: { memo: "M", posting: "P", owner: "O", active: "A" } }).join(",") ===
    "owner,active,posting,memo",
  importedRoles({ ...legacy, keys: { memo: "M", posting: "P", owner: "O", active: "A" } }),
);
check(
  "an unknown stored role still resolves to posting",
  JSON.stringify(accountKeys({ ...legacy, role: "root" as KeyRole })) ===
    JSON.stringify({ posting: "STM5LEGACY" }),
  accountKeys({ ...legacy, role: "root" as KeyRole }),
);

// ---------------------------------------------------------------------------
console.log("--- upsertAccount: a master import writes four keys in a row ---");
const withKey = (role: KeyRole, pub: string): StoredAccount => ({
  username: "alice",
  publicKey: pub,
  encryptedWif: `enc-${role}`,
  role,
  keys: { [role]: pub },
  createdAt: 1,
  updatedAt: 1,
});
const init = () => accountsReducer(undefined, { type: "@@INIT" });

let state = init();
for (const r of ["posting", "active", "owner", "memo"] as KeyRole[]) {
  state = accountsReducer(state, upsertAccount(withKey(r, `PUB-${r}`)));
}
const alice = state.accounts[0]!;
check(
  "all four authorities are kept",
  Object.keys(accountKeys(alice)).sort().join(",") === "active,memo,owner,posting",
  accountKeys(alice),
);
check(
  "primary stays posting — not whichever key finished last",
  alice.role === "posting",
  alice.role,
);
check("headline pubkey is the posting key", alice.publicKey === "PUB-posting", alice.publicKey);
check(
  "legacy encryptedWif still belongs to the primary key",
  alice.encryptedWif === "enc-posting",
  alice.encryptedWif,
);
check("card chips render all four, strongest first", importedRoles(alice).join(",") === "owner,active,posting,memo");
check("activeUsername is set", state.activeUsername === "alice");

state = accountsReducer(
  state,
  upsertAccountKey({ username: "alice", authority: "active", publicKey: "PUB-active-2" }),
);
check(
  "adding one key leaves the others alone",
  accountKeys(state.accounts[0]!).active === "PUB-active-2" &&
    accountKeys(state.accounts[0]!).posting === "PUB-posting",
  accountKeys(state.accounts[0]!),
);

let single = init();
single = accountsReducer(single, upsertAccount(withKey("active", "PUB-A")));
check(
  "a single-key (WIF) import still uses its own authority as primary",
  single.accounts[0]!.role === "active" && single.accounts[0]!.publicKey === "PUB-A",
  single.accounts[0],
);

// ---------------------------------------------------------------------------
console.log("--- roleAccent: risk-coded chip border per key role ---");
check("posting accent = success (green, routine)", roleAccent("posting") === "success");
check("active accent = warning (amber, moves funds)", roleAccent("active") === "warning");
check("owner accent = error (red, highest authority)", roleAccent("owner") === "error");
check("memo accent = primary (blue, specialized)", roleAccent("memo") === "primary");

console.log(
  failures === 0
    ? "\nAll key-routing checks passed ✔"
    : `\n${failures} check(s) FAILED ✘`,
);
process.exit(failures === 0 ? 0 : 1);
