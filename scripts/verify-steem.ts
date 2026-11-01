/**
 * Sanity check: compare the pure-JS Steem crypto/serializer port against
 * @steempro/dsteem (the reference used in steempro-next).
 *
 * Run with: npx tsx scripts/verify-steem.ts
 */
import { createRequire } from "node:module";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  encodeWif,
  decodeWif,
  wifToPublicKey,
  signDigest,
  derivePublicKey,
  verifyDigest,
  fromHex,
} from "../src/lib/steem/keys";
import { serializeTransaction } from "../src/lib/steem/serializer";

// Reference implementation lives in the sibling steempro-next project.
const refRequire = createRequire("E:/official/steempro-next/package.json");
const {
  PrivateKey,
  Signature,
  cryptoUtils,
  DEFAULT_CHAIN_ID,
} = refRequire("@steempro/dsteem") as typeof import("@steempro/dsteem");

let failures = 0;
function check(name: string, ok: boolean) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) failures++;
}

// 1. WIF round-trip + public key parity
const ref = PrivateKey.fromSeed("steemauth test seed");
const wif = ref.toString();
check("WIF round-trip", encodeWif(decodeWif(wif)) === wif);
check(
  "public key matches dsteem",
  wifToPublicKey(wif) === ref.createPublic().toString(),
);

// 2. Signature: sign a digest, recover the key with dsteem and compare
const digest = cryptoUtils.sha256(Buffer.from("steemauth digest"));
const sig = signDigest(new Uint8Array(digest), decodeWif(wif));
check("signature length (130 hex chars)", sig.length === 130);
let recoveredOk = false;
try {
  const recovered = Signature.fromString(sig).recover(new Uint8Array(digest));
  recoveredOk = recovered.toString() === wifToPublicKey(wif);
} catch {
  recoveredOk = false;
}
check("dsteem recovers our public key from our signature", recoveredOk);
check(
  "our verifyDigest accepts our signature",
  verifyDigest(new Uint8Array(digest), sig, derivePublicKey(decodeWif(wif))),
);

// 3. Transaction serialization parity — compare
//    sha256(chainId || serializedTx) with dsteem's transactionDigest.
const tx = {
  ref_block_num: 1,
  ref_block_prefix: 2,
  expiration: "2030-01-01T00:00:00",
  operations: [
    [
      "vote",
      { voter: "alice", author: "bob", permlink: "hello-world", weight: 10000 },
    ],
    ["transfer", { from: "alice", to: "bob", amount: "1.234 STEEM", memo: "test memo" }],
  ] as any,
  extensions: [] as any[],
};

const mine = serializeTransaction(tx as any);
const chainId = fromHex(
  Buffer.from(DEFAULT_CHAIN_ID).toString("hex"),
);
const combined = new Uint8Array(chainId.length + mine.length);
combined.set(chainId, 0);
combined.set(mine, chainId.length);
const myDigest = Buffer.from(sha256(combined)).toString("hex");
const refDigest = Buffer.from(cryptoUtils.transactionDigest(tx)).toString("hex");
check("transaction digest matches dsteem transactionDigest", myDigest === refDigest);
if (myDigest !== refDigest) {
  console.log("mine:  ", myDigest);
  console.log("dsteem:", refDigest);
}

// 4. Broader operation coverage (custom_json, comment, account_update2,
//    transfer_to_vesting, withdraw_vesting, claim_reward_balance).
const bigTx = {
  ...tx,
  operations: [
    [
      "comment",
      {
        parent_author: "",
        parent_permlink: "steem",
        author: "alice",
        permlink: "my-post",
        title: "Hello",
        body: "Body text",
        json_metadata: JSON.stringify({ app: "steemauth" }),
      },
    ],
    [
      "custom_json",
      {
        required_auths: [],
        required_posting_auths: ["alice"],
        id: "sm_follow",
        json: JSON.stringify({ follower: "alice", following: "bob" }),
      },
    ],
    ["transfer_to_vesting", { from: "alice", to: "bob", amount: "1.000 STEEM" }],
    [
      "withdraw_vesting",
      { account: "alice", vesting_shares: "1000.000000 VESTS" },
    ],
    [
      "claim_reward_balance",
      {
        account: "alice",
        reward_steem: "0.010 STEEM",
        reward_sbd: "0.020 SBD",
        reward_vests: "30.000000 VESTS",
      },
    ],
    [
      "account_update2",
      {
        account: "alice",
        owner: null,
        active: null,
        posting: null,
        memo_key: wifToPublicKey(wif),
        json_metadata: "{}",
        posting_json_metadata: JSON.stringify({ profile: { name: "Alice" } }),
        extensions: [],
      },
    ],
  ] as any,
};

const myBig = serializeTransaction(bigTx as any);
const combinedBig = new Uint8Array(chainId.length + myBig.length);
combinedBig.set(chainId, 0);
combinedBig.set(myBig, chainId.length);
const myBigDigest = Buffer.from(sha256(combinedBig)).toString("hex");
const refBigDigest = Buffer.from(cryptoUtils.transactionDigest(bigTx)).toString("hex");
check(
  "multi-op transaction digest matches dsteem",
  myBigDigest === refBigDigest,
);
if (myBigDigest !== refBigDigest) {
  console.log("mine:  ", myBigDigest);
  console.log("dsteem:", refBigDigest);
}

process.exit(failures === 0 ? 0 : 1);
