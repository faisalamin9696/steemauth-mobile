# SteemAuth Protocol (v3)

> **v3 moves the plane into the relay.** One transport, no credentials in
> clients: the QR carries a relay URL (`rt`), an unguessable room (`rm`) and
> the phone's room token (`tk`); `steemauth-relay` keeps each room as a
> sequenced log with replay, authenticates joins with hashed tokens, and
> never sees plaintext (every envelope is AES + HMAC with the QR key `k`).
> v1 (relay frames) and v2 (Supabase `sup` payloads) are refused by the
> version check on both sides. The browser mirror lives in
> `@steempro/steemauth-qr` (its `docs/protocol.md` is the wire spec; the
> suites cross-check both implementations on every run).

## Flow

1. The web app builds a QR (`v: 3`) containing the relay URL, room, phone
   token, session id and AES key — all generated client-side — and
   **connects first**: it registers the room (sending only sha256 hashes of
   both tokens), joins and pulls the backlog, so nothing can race `ready`.
2. The phone scans, validates the payload (version, expiry, formats,
   blocklist, target account), joins the room with the phone token, and
   sends `ready` as a sealed row.
3. Requests (`request` rows) and results (`result` rows) stream through the
   room; the relay acks each send and fans it out to the other members.
4. Revocation is a `revoke` row; the room (and its log) die with the
   session.

## 1. QR payload

```jsonc
{
  "v": 3,                            // protocol version
  "t": "steem.session",              // payload type
  "sid": "<uuid>",                   // session id (inside the ciphertext)
  "app": "SteemPro",                 // requesting application name (≤ 80)
  "url": "https://...",              // declared origin (informational)
  "src": "https://...",              // verified origin (auto, non-overridable)
  "chain": "steem",                  // target chain
  "rt": "wss://relay.steempro.com",  // the relay plane — the only endpoint
  "rm": "rm_<base64url>",            // room (~176 bits)
  "tk": "tok_<base64url>",           // the PHONE's token (app keeps its own)
  "k": "<base64-32bytes>",           // payload key (both sides know it)
  "ts": 1712345678900,               // issued-at (ms)
  "exp": 1712345738900,              // expiry (ms) — refused past this
  "account": "alice"                 // optional target account
}
```

Validation (`parseSessionQr`, identical to the package's `parseQrPayload`):

- `t === "steem.session"` and `v === 3` — v1/v2 payloads are refused by the
  version check with a clear message (never misread, never hang);
- `sid` ≥ 8 chars, `k` ≥ 16 chars, `exp > now`, `ts` ≤ 60 s in the future;
- `chain` (if present) `steem`; `src` (if present) a strict origin shape
  (host[:port] only — no path/userinfo/whitespace, display-spoofing
  material for the blocklist and approval UI);
- `rt` must be `ws(s)://`, `rm` must match `rm_[A-Za-z0-9_-]{16,64}`, `tk`
  must match `tok_[A-Za-z0-9_-]{32,128}`;
- `account` (if present) is a valid Steem username — the phone
  auto-selects it on connect.

There is no `sup` field and no endpoint discovery — the relay URL is a
public constant (`DEFAULT_RELAY_URL`) or the app's `relayUrl` option. The
app's own token never appears in the QR; only its sha256 hash reaches the
relay, at room registration.

## 2. Relay room (the only transport)

One WebSocket per side to `rt`, addressed by room. The relay keeps a
**sequenced log per room** (seq starts at 1) and enforces:

- **Join auth**: sha256 token compare (constant-time); failed joins count
  per IP — 5 failures → 10-minute ban; unknown/expired rooms → `room_expired`.
- **Registration**: `create` carries both token hashes + ttl; idempotent on
  resume (same hashes → `ok`), conflicting hashes → `room_exists`.
- **Delivery**: `msg { payload }` → relay assigns `seq` → `ack` to the
  sender + fanout to OTHER members (no sender echo); `pull { cursor }` →
  replay `seq > cursor` on every (re)join — the refresh/background healer.
- **Limits**: envelope ≤ 64 KB (`{ c, m }` shape enforced before the
  store), frame ≤ 70 KB, ≤ 4 members/room, 20 msg/s/connection, per-IP
  create/join caps, slow-consumer cut (> 1 MB buffered).
- **Lifetime**: sliding idle expiry (15 min) + hard cap (60 min); the
  sweeper deletes the room AND its rows; the app may `close` immediately.

### Replay safety (phone side)

Two guards make replay safe after an app restart:

- the room is **fresh per session** (minted in the QR), so no honest row
  can predate the session — unlike v2's shared `sid`, there is no page-clock
  watermark to get wrong;
- the **decided-ids gate** (`replayGuard`): ids already approved/rejected
  are re-seeded from secure storage, so a replayed request can never reach
  the approval screen twice (double-broadcast protection).

Envelope-level: `openMessage` verifies the HMAC before decryption and
returns null on any failure — a replayed or forged envelope is dropped
before it can become a message.

### Session lifetime

- The room lives from registration until idle/hard expiry — exactly the
  session's window (QR TTL + slack), so revocation-by-room is complete.
- Process death: the phone persists `{ payload, decided }` in secure
  storage (it contains `k` — Keychain/Keystore only) and resumes the same
  room with the phone token until `exp`.
- The web side persists `{ payload, app token, pending request }` and
  resumes with the SAME request id (a re-show, not a duplicate).

### Messages

Inside `payload.c`, every message carries `sid`:

| Direction | Type | Fields |
|---|---|---|
| phone → app | `ready` | `account`, `authority`, `device?` |
| app → phone | `request` | `id`, `ops` (≤ 20), `sign?`, `action?`, `meta?`, `exp?` |
| phone → app | `result` | `id`, `ok`, `txId?`, `error?`, `account?`, `signature?` |
| either | `cancel` | `id`, `reason?` |
| phone → app | `revoke` | `reason?` |
| either | `ping` / `pong` | keepalive |

`request` invariants: `ops` xor `sign`; ≤ 20 `[name, params]` pairs from
the 48-op whitelist; at least one op must reference the connected account
when one is set; authority is derived per batch (`custom_json` with
non-empty `required_auths` requires active); `exp` voids the request once
passed. Ordinary requests carry the QR's expiry — only
`session.authenticate()` takes a client-settable window.

### Encryption (encrypt-then-MAC)

- `c` = passphrase AES-256-CBC (OpenSSL `Salted__` envelope, crypto-js on
  this side / crypto-es on the web — byte-interchangeable);
- `m` = HMAC-SHA256 over `c` with `SHA256("steemauth-v3-mac:" + k)`;
- `openMessage` verifies `m` **before** decrypting and drops failures
  silently — the relay can neither read messages nor inject one that
  verifies; tampering, cross-session replays and forged rows die at the tag.

## Compatibility policy

v3 is additive-only: new optional fields never break older v3 peers. Hard
breaks bump `v` (v1 and v2 are refused today). Wire changes require the qr package's `verify-protocol` suite (which loads
this repo's parsers directly) updated together.
