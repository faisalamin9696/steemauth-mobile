/**
 * Secure local storage for private keys and account metadata.
 *
 * Design (mirrors steempro-next's approach, adapted to RN):
 *  - Private keys are AES-encrypted with a key derived from the app PIN
 *    (PBKDF2, 10k iterations, random salt + IV — same format as
 *    utils/encryption.ts in steempro-next: "saltHex:ivHex:ciphertext").
 *  - The encrypted blobs live in expo-secure-store (Keychain / Keystore).
 *  - Account metadata (no secrets) lives in Redux, persisted to AsyncStorage.
 *  - With biometrics enabled, a copy of the key is stored re-encrypted with
 *    a device-random secret that is only readable after a biometric prompt.
 */
import * as SecureStore from 'expo-secure-store';
import CryptoJS from 'crypto-js';
import { getItem, setItem, deleteItem } from './secureStorage';
import { isKeyRole, type KeyRole } from './keyRouting';

const SERVICE = 'steemauth';

/**
 * PBKDF2 cost for NEW writes (PIN verifier and key blobs).
 *
 * The old defaults - 50k iterations for the verifier, 10k for blobs - run in
 * pure-JS CryptoJS and cost roughly a second on a mid-range phone: every
 * unlock paid it (the complaint this replaces). 8k is defensible because it is
 * not the only wall: the blobs live in the platform keystore (hardware
 * backed), the PIN space is 6 digits, and failed attempts are exponentially
 * rate-limited (lockout table below). Legacy records keep their original
 * cost forever (nothing breaks) and are re-written at the new cost on the
 * first successful use - a silent, one-time upgrade.
 */
const PBKDF2_ITER = 8_000;
const LEGACY_PIN_ITER = 50_000;
const LEGACY_BLOB_ITER = 10_000;
const BLOB_TAG = 'pbkdf2-';

function storeKey(name: string): string {
  return `${SERVICE}.${name}`;
}

// ---------------------------------------------------------------------------
// Key encryption (same wire format as steempro-next)
// ---------------------------------------------------------------------------

export function encryptSecret(secret: string, password: string): string {
  const salt = CryptoJS.lib.WordArray.random(128 / 8);
  const iv = CryptoJS.lib.WordArray.random(128 / 8);
  const derived = CryptoJS.PBKDF2(password, salt, {
    keySize: 128 / 32,
    iterations: PBKDF2_ITER,
  });
  const encrypted = CryptoJS.AES.encrypt(secret, derived, { iv });
  // Versioned: `pbkdf2-<iter>:<saltHex>:<ivHex>:<ct>` - the tag carries the
  // iteration count so decrypt never has to guess, while the legacy 3-part
  // form (no tag) keeps decrypting at its original cost forever.
  return `${BLOB_TAG}${PBKDF2_ITER}:${salt.toString(CryptoJS.enc.Hex)}:${iv.toString(
    CryptoJS.enc.Hex,
  )}:${encrypted.toString()}`;
}

export function decryptSecret(blob: string, password: string): string | null {
  try {
    const parts = blob.split(':');
    // New form carries its cost in the tag; the legacy 3-part form does not.
    const versioned = parts.length === 4 && parts[0].startsWith(BLOB_TAG);
    const iterations = versioned
      ? Number(parts[0].slice(BLOB_TAG.length)) || LEGACY_BLOB_ITER
      : LEGACY_BLOB_ITER;
    const [saltHex, ivHex, ciphertext] = versioned ? parts.slice(1) : parts;
    if (!saltHex || !ivHex || !ciphertext) return null;
    const salt = CryptoJS.enc.Hex.parse(saltHex);
    const iv = CryptoJS.enc.Hex.parse(ivHex);
    const derived = CryptoJS.PBKDF2(password, salt, {
      keySize: 128 / 32,
      iterations,
    });
    const text = CryptoJS.AES.decrypt(ciphertext, derived, { iv }).toString(
      CryptoJS.enc.Utf8,
    );
    return text || null;
  } catch {
    return null;
  }
}

/** True while a blob still uses the legacy (untagged) parameters. */
export function blobIsLegacy(blob: string): boolean {
  return !blob.startsWith(BLOB_TAG);
}

// ---------------------------------------------------------------------------
// PIN / password verifier
// ---------------------------------------------------------------------------

interface PinRecord {
  salt: string;
  hash: string;
  /** PBKDF2 iterations the hash was computed with (absent = legacy 50k). */
  iter?: number;
}

export async function setPin(pin: string): Promise<void> {
  const salt = CryptoJS.lib.WordArray.random(128 / 8).toString(CryptoJS.enc.Hex);
  const hash = CryptoJS.PBKDF2(pin, salt, {
    keySize: 256 / 32,
    iterations: PBKDF2_ITER,
  }).toString(CryptoJS.enc.Hex);
  await setItem(storeKey('pin'), JSON.stringify({ salt, hash, iter: PBKDF2_ITER }));
}

export async function verifyPin(pin: string): Promise<boolean> {
  const raw = await getItem(storeKey('pin'));
  if (!raw) return false;
  try {
    const rec = JSON.parse(raw) as PinRecord;
    const ok = checkPinRecord(rec, pin);
    // First successful unlock on old params: re-write at the current cost
    // (same salt, PIN in hand) so every later unlock is the fast path.
    if (ok && rec.iter !== PBKDF2_ITER) upgradePinRecord(rec, pin);
    return ok;
  } catch {
    return false;
  }
}

/** Compute a verifier hash at an explicit cost. */
function pinHash(pin: string, salt: string, iterations: number): string {
  return CryptoJS.PBKDF2(pin, salt, {
    keySize: 256 / 32,
    iterations,
  }).toString(CryptoJS.enc.Hex);
}

/** Verify against whatever cost the record was written with. */
function checkPinRecord(rec: PinRecord, pin: string): boolean {
  return pinHash(pin, rec.salt, rec.iter ?? LEGACY_PIN_ITER) === rec.hash;
}

/** Best-effort, non-blocking re-write of the verifier at the current cost. */
function upgradePinRecord(rec: PinRecord, pin: string): void {
  void setItem(
    storeKey('pin'),
    JSON.stringify({ salt: rec.salt, hash: pinHash(pin, rec.salt, PBKDF2_ITER), iter: PBKDF2_ITER }),
  )
    .then(() => {
      // One line, once ever: proof on the device that the slow legacy
      // verifier was upgraded to the fast parameters.
      console.log('[steemauth] PIN verifier upgraded to current cost');
    })
    .catch(() => {
      // Retry naturally on the next successful unlock.
    });
}

export async function hasPin(): Promise<boolean> {
  return Boolean(await getItem(storeKey('pin')));
}

export async function clearPin(): Promise<void> {
  await deleteItem(storeKey('pin'));
}

// ---------------------------------------------------------------------------
// Failed-attempt lockout (exponential backoff)
// ---------------------------------------------------------------------------

interface AttemptRecord {
  /** consecutive failures since last success */
  count: number;
  /** ms epoch until which PIN entry is disabled (0 = not locked) */
  lockedUntil: number;
}

const LOCKOUT_SCHEDULE_MS = [0, 0, 0, 30_000, 60_000, 300_000]; // fails 0-2 free, then 30s/1m/5m (capped)

function lockoutFor(count: number): number {
  if (count < LOCKOUT_SCHEDULE_MS.length) return LOCKOUT_SCHEDULE_MS[count]!;
  return LOCKOUT_SCHEDULE_MS[LOCKOUT_SCHEDULE_MS.length - 1]!;
}

function parseAttempts(raw: string | null): AttemptRecord {
  if (!raw) return { count: 0, lockedUntil: 0 };
  try {
    const parsed = JSON.parse(raw) as AttemptRecord;
    return {
      count: typeof parsed.count === 'number' ? parsed.count : 0,
      lockedUntil: typeof parsed.lockedUntil === 'number' ? parsed.lockedUntil : 0,
    };
  } catch {
    return { count: 0, lockedUntil: 0 };
  }
}

async function readAttempts(): Promise<AttemptRecord> {
  return parseAttempts(await getItem(storeKey('pin_attempts')));
}

export interface PinCheck {
  ok: boolean;
  /** ms remaining on a lockout (0 when not locked) */
  lockedForMs: number;
  /** attempts left before a lockout kicks in (undefined when locked) */
  attemptsLeft?: number;
}

/** Current lockout state without checking any PIN. */
export async function pinLockState(): Promise<PinCheck> {
  const rec = await readAttempts();
  const now = Date.now();
  if (rec.lockedUntil > now) {
    return { ok: false, lockedForMs: rec.lockedUntil - now };
  }
  const attemptsLeft = Math.max(
    0,
    3 - rec.count, // warn starting at 3 consecutive failures
  );
  return { ok: false, lockedForMs: 0, attemptsLeft };
}

/**
 * Verify the PIN with lockout enforcement. Failures register a backoff
 * window; a success clears the counter. Used by PinGate.
 */
export async function verifyPinLocked(pin: string): Promise<PinCheck> {
  // Both reads in flight at once: independent SecureStore round trips that
  // used to run back-to-back and doubled the unlock latency for no reason.
  const [attemptsRaw, raw] = await Promise.all([
    getItem(storeKey('pin_attempts')),
    getItem(storeKey('pin')),
  ]);
  const rec = parseAttempts(attemptsRaw);
  const now = Date.now();
  if (rec.lockedUntil > now) {
    return { ok: false, lockedForMs: rec.lockedUntil - now };
  }

  if (!raw) return { ok: false, lockedForMs: 0 };

  let valid = false;
  try {
    const pinRec = JSON.parse(raw) as PinRecord;
    valid = checkPinRecord(pinRec, pin);
    // Silent one-time upgrade: first success on legacy params re-writes the
    // verifier at the current cost (same salt, PIN in hand).
    if (valid && pinRec.iter !== PBKDF2_ITER) upgradePinRecord(pinRec, pin);
  } catch {
    valid = false;
  }

  if (valid) {
    if (rec.count > 0 || rec.lockedUntil > 0) {
      await deleteItem(storeKey('pin_attempts'));
    }
    return { ok: true, lockedForMs: 0 };
  }

  const count = rec.count + 1;
  const lockMs = lockoutFor(count);
  await setItem(
    storeKey('pin_attempts'),
    JSON.stringify({ count, lockedUntil: lockMs > 0 ? now + lockMs : 0 }),
  );
  return {
    ok: false,
    lockedForMs: lockMs,
    attemptsLeft: Math.max(0, 3 - count),
  };
}

// ---------------------------------------------------------------------------
// Private key vault
// ---------------------------------------------------------------------------

export interface StoredKey {
  username: string;
  authority: string; // posting | active | memo | owner
  /** encrypted with the PIN-derived password */
  encKey: string;
  /** optional copy encrypted with the device secret (biometric unlock) */
  bioKey?: string;
  createdAt: number;
}

// One record PER AUTHORITY: an account may hold posting, active, owner and
// memo keys, and importing one later must never overwrite another (the
// posting key the phone signs logins with stays exactly where it was).
//
// Layout:   key.<username>.<authority>   ← the encrypted key
//           keys.<username>              ← index of authorities present
// Older builds stored a single record at `key.<username>` with an `authority`
// field; the first touch of an account migrates it into its own slot, so no
// stored key ever goes invisible after an app update.

const KEYCHAIN_OPTS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

const indexName = (username: string) => `keys.${username}`;
const slotName = (username: string, authority: string) =>
  `key.${username}.${authority}`;
const legacyName = (username: string) => `key.${username}`;

async function readIndex(username: string): Promise<KeyRole[]> {
  const raw = await getItem(storeKey(indexName(username)));
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isKeyRole) : [];
  } catch {
    return [];
  }
}

async function writeIndex(username: string, roles: KeyRole[]): Promise<void> {
  await setItem(storeKey(indexName(username)), JSON.stringify(roles), KEYCHAIN_OPTS);
}

async function readSlot(
  username: string,
  authority: KeyRole,
): Promise<StoredKey | null> {
  const raw = await getItem(storeKey(slotName(username, authority)));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredKey;
  } catch {
    return null;
  }
}

/**
 * Move a pre-multi-key record into its authority slot. Never overwrites a
 * slot that already exists (the newer key wins) and never deletes a record
 * it could not parse — a corrupt legacy entry is left alone rather than
 * silently destroying the only copy.
 */
/** Usernames whose legacy single-key record has already been checked. */
const legacyChecked = new Set<string>();

async function migrateLegacyKey(username: string): Promise<void> {
  // One check per username per run: once read (and deleted on migration) the
  // legacy record cannot reappear, so paying a SecureStore round trip on
  // EVERY key load was pure latency on the approve path.
  if (legacyChecked.has(username)) return;
  legacyChecked.add(username);
  const raw = await getItem(storeKey(legacyName(username)));
  if (!raw) return;
  let record: StoredKey | null = null;
  try {
    record = JSON.parse(raw) as StoredKey;
  } catch {
    return;
  }
  if (!record || typeof record.encKey !== "string") return;

  const role: KeyRole = isKeyRole(record.authority) ? record.authority : "posting";
  const occupied = await getItem(storeKey(slotName(username, role)));
  if (!occupied) {
    await setItem(storeKey(slotName(username, role)), raw, KEYCHAIN_OPTS);
  }
  const index = await readIndex(username);
  if (!index.includes(role)) await writeIndex(username, [...index, role]);
  await deleteItem(storeKey(legacyName(username)));
}

/** Store (or replace) the key for ONE authority of an account. */
export async function saveStoredKey(record: StoredKey): Promise<void> {
  await migrateLegacyKey(record.username);
  const role: KeyRole = isKeyRole(record.authority) ? record.authority : "posting";
  await setItem(storeKey(slotName(record.username, role)), JSON.stringify(record), KEYCHAIN_OPTS);
  const index = await readIndex(record.username);
  if (!index.includes(role)) await writeIndex(record.username, [...index, role]);
}

/**
 * Load one key.
 *
 * With `authority`: exactly that key (null when the phone does not hold it —
 * the caller turns that into "add your Active key in Accounts" instead of a
 * broadcast that dies on-chain). Without: the account's primary record, which
 * is what the old single-key API meant.
 */
export async function loadStoredKey(
  username: string,
  authority?: KeyRole,
): Promise<StoredKey | null> {
  await migrateLegacyKey(username);
  if (authority) return readSlot(username, authority);
  for (const role of await readIndex(username)) {
    const record = await readSlot(username, role);
    if (record) return record;
  }
  return null;
}

/** Every key held for an account (strongest→weakest not guaranteed; index order). */
export async function loadAllStoredKeys(username: string): Promise<StoredKey[]> {
  await migrateLegacyKey(username);
  const roles = await readIndex(username);
  const records = await Promise.all(roles.map((role) => readSlot(username, role)));
  return records.filter((r): r is StoredKey => r !== null);
}

/** Remove every key of an account (account removal / full wipe). */
export async function deleteStoredKeys(username: string): Promise<void> {
  await migrateLegacyKey(username);
  const roles = await readIndex(username);
  await Promise.all(
    roles.map((role) => deleteItem(storeKey(slotName(username, role)))),
  );
  await deleteItem(storeKey(indexName(username)));
  await deleteItem(storeKey(legacyName(username)));
}

// ---------------------------------------------------------------------------
// Biometric device secret
// ---------------------------------------------------------------------------

const DEVICE_SECRET_NAME = 'device_secret';

/**
 * In-process cache of the device secret.
 *
 * The secret itself is stored WITH the OS user-presence binding
 * (requireAuthentication): reading it now triggers the system biometric /
 * device-credential prompt on both platforms (AESEncryptor/decryptItem run
 * authenticateCipher for auth-bound items; iOS maps to the kSec access-control
 * class). That is the whole point — code running inside the app process can no
 * longer read the biometric-wrap key with zero prompts (the documented
 * invariant at the top of this file). The cache exists so the honest approve
 * flow pays that prompt at most once per process launch instead of on every
 * approval; an attacker who reaches the secret BEFORE any honest read still
 * faces the OS prompt, which is the boundary this binding creates.
 */
let cachedDeviceSecret: string | null = null;

export async function getOrCreateDeviceSecret(): Promise<string> {
  if (cachedDeviceSecret) return cachedDeviceSecret;
  const key = storeKey(DEVICE_SECRET_NAME);
  const boundMarker = storeKey(DEVICE_SECRET_NAME + '_bound');
  // Can this device store an auth-bound item at all? If not (no biometrics),
  // write plain — a bound write we could never read would brick biometrics.
  let canAuth = false;
  try {
    canAuth = Boolean(await Promise.resolve(SecureStore.canUseBiometricAuthentication()));
  } catch {
    canAuth = false;
  }

  const existing = await getItem(key);
  if (existing) {
    // One-time migration: records written before the binding existed keep
    // their VALUE (every existing bioKey copy keeps decrypting) but are
    // re-saved WITH requireAuthentication, so all future reads are OS-gated.
    // The marker keeps the migration to a single re-save (and prompt) per
    // install instead of one per call.
    if (canAuth && !(await getItem(boundMarker))) {
      await setItem(key, existing, {
        keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
        requireAuthentication: true,
      });
      await setItem(boundMarker, '1', {
        keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
      });
    }
    cachedDeviceSecret = existing;
    return existing;
  }
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  // Hex, not base64: Hermes has no guaranteed global `btoa`, and its absence
  // is exactly what made the FIRST biometric key save throw ("btoa is not
  // defined") as soon as biometrics defaulted on.
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  await setItem(key, hex, {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    ...(canAuth ? { requireAuthentication: true } : {}),
  });
  if (canAuth) {
    await setItem(boundMarker, '1', {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
  }
  cachedDeviceSecret = hex;
  return hex;
}

/** Encrypt a private key for biometric unlock. */
export async function encryptForBiometrics(
  wif: string,
  username: string,
): Promise<string> {
  const secret = await getOrCreateDeviceSecret();
  return encryptSecret(wif, `${secret}:${username}`);
}

/** Decrypt a biometric key copy. Only call after a successful biometric prompt. */
export async function decryptBiometricKey(
  bioKey: string,
  username: string,
): Promise<string | null> {
  const secret = await getOrCreateDeviceSecret();
  return decryptSecret(bioKey, `${secret}:${username}`);
}

