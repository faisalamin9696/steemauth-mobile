/**
 * Steem key handling: WIF encode/decode, key derivation and canonical
 * ECDSA signing. Implemented on top of @noble/curves so it runs natively
 * in Hermes without any Buffer/native polyfills.
 *
 * Byte-format reference: @steempro/dsteem lib/crypto.js
 *  - WIF       = base58( 0x80 || key(32) || sha256d(..)[0..4] )
 *  - PublicKey = base58( prefix || pub(33) || ripemd160(..)[0..4] )
 *  - Signature = hex( (recovery + 31) || r(32) || s(32) ), canonical (low-s,
 *    top-bit clean) with deterministic retry — same rules as dsteem.
 */
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { ripemd160 } from '@noble/hashes/legacy.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import bs58 from 'bs58';

export const ADDRESS_PREFIX = 'STM';
export const CHAIN_ID_HEX =
  '0000000000000000000000000000000000000000000000000000000000000000';

const WIF_NETWORK_ID = 0x80;

function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}

function sha256d(data: Uint8Array): Uint8Array {
  return sha256(sha256(data));
}

export function toHex(bytes: Uint8Array): string {
  return bytesToHex(bytes);
}

export function fromHex(hex: string): Uint8Array {
  return hexToBytes(hex);
}

// ---------------------------------------------------------------------------
// WIF
// ---------------------------------------------------------------------------

/** Encode a 32-byte private key as a Steem WIF string. */
export function encodeWif(privateKey: Uint8Array): string {
  if (privateKey.length !== 32) throw new Error('private key must be 32 bytes');
  const payload = concatBytes(Uint8Array.from([WIF_NETWORK_ID]), privateKey);
  const checksum = sha256d(payload).slice(0, 4);
  return bs58.encode(concatBytes(payload, checksum));
}

/** Decode + validate a Steem WIF string into a 32-byte private key. */
export function decodeWif(wif: string): Uint8Array {
  let decoded: Uint8Array;
  try {
    decoded = bs58.decode(wif.trim());
  } catch {
    throw new Error('invalid WIF: not base58');
  }
  if (decoded.length !== 37) {
    throw new Error('invalid WIF: wrong length');
  }
  const payload = decoded.slice(0, 33);
  const checksum = decoded.slice(33);
  if (payload[0] !== WIF_NETWORK_ID) {
    throw new Error('invalid WIF: network id mismatch');
  }
  const expected = sha256d(payload).slice(0, 4);
  for (let i = 0; i < 4; i++) {
    if (checksum[i] !== expected[i]) throw new Error('invalid WIF: checksum mismatch');
  }
  return payload.slice(1);
}

export function isWif(value: string): boolean {
  try {
    decodeWif(value);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Public keys
// ---------------------------------------------------------------------------

/** Encode 33 compressed public key bytes as `STM...` string. */
export function encodePublicKey(pubKey: Uint8Array, prefix = ADDRESS_PREFIX): string {
  const checksum = ripemd160(pubKey).slice(0, 4);
  return prefix + bs58.encode(concatBytes(pubKey, checksum));
}

/** Decode `STM...` public key string into 33 compressed bytes. */
export function decodePublicKey(value: string): Uint8Array {
  const prefix = value.slice(0, 3);
  if (prefix.length !== 3) throw new Error('public key invalid prefix');
  const body = value.slice(3);
  let decoded: Uint8Array;
  try {
    decoded = bs58.decode(body);
  } catch {
    throw new Error('public key: not base58');
  }
  if (decoded.length !== 37) throw new Error('public key: wrong length');
  const key = decoded.slice(0, 33);
  const checksum = decoded.slice(33);
  const expected = ripemd160(key).slice(0, 4);
  for (let i = 0; i < 4; i++) {
    if (checksum[i] !== expected[i]) throw new Error('public key checksum mismatch');
  }
  return key;
}

// ---------------------------------------------------------------------------
// Signing
// ---------------------------------------------------------------------------

/** Steem signature (65 bytes) is not canonical when the top bit is set. */
function isCanonical(signature64: Uint8Array): boolean {
  return !(
    signature64[0] & 0x80 ||
    (signature64[0] === 0 && !(signature64[1] & 0x80)) ||
    signature64[32] & 0x80 ||
    (signature64[32] === 0 && !(signature64[33] & 0x80))
  );
}

/**
 * Sign a 32-byte digest, producing the Steem compact signature string:
 * hex( (recovery + 31) || r || s ) — retries deterministically until the
 * signature satisfies Steem's canonicality rules (mirrors dsteem).
 */
export function signDigest(digest: Uint8Array, privateKey: Uint8Array): string {
  if (digest.length !== 32) throw new Error('digest must be 32 bytes');
  for (let attempt = 1; attempt <= 64; attempt++) {
    const extraEntropy = sha256(
      concatBytes(digest, Uint8Array.from([attempt & 0xff])),
    );
    const sig = secp256k1.sign(digest, privateKey, {
      prehash: false,
      lowS: true,
      format: 'recovered',
      extraEntropy,
    });
    // recovered format = [recovery, r(32), s(32)]
    if (isCanonical(sig.subarray(1))) {
      const out = new Uint8Array(65);
      out.set(sig);
      out[0] = sig[0] + 31;
      return bytesToHex(out);
    }
  }
  throw new Error('unable to produce canonical signature');
}

/** Derive the compressed public key (33 bytes) from a 32-byte private key. */
export function derivePublicKey(privateKey: Uint8Array): Uint8Array {
  if (privateKey.length !== 32) throw new Error('private key must be 32 bytes');
  if (!secp256k1.utils.isValidSecretKey(privateKey)) {
    throw new Error('invalid private key');
  }
  return secp256k1.getPublicKey(privateKey, true);
}

/** Public key string (STM...) for a WIF private key. */
export function wifToPublicKey(wif: string, prefix = ADDRESS_PREFIX): string {
  return encodePublicKey(derivePublicKey(decodeWif(wif)), prefix);
}

/**
 * Derive a key from username + master password, like dsteem's
 * PrivateKey.fromLogin(username, password, role): sha256(username+role+password).
 */
export function deriveFromMasterPassword(
  username: string,
  password: string,
  role: 'posting' | 'active' | 'memo' | 'owner',
): string {
  const seed = `${username}${role}${password}`;
  return encodeWif(sha256(utf8Bytes(seed)));
}

export function utf8Bytes(str: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    else if (c >= 0xd800 && c <= 0xdbff) {
      const c2 = str.charCodeAt(++i);
      const cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
      out.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      );
    } else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
  }
  return Uint8Array.from(out);
}

/**
 * Sign an arbitrary text message the way the ecosystem does for off-chain
 * proofs: sha256(message) then canonical compact signature.
 */
export function signMessage(message: string, wif: string): string {
  return signDigest(sha256(utf8Bytes(message)), decodeWif(wif));
}

/** Verify a Steem compact signature over a 32-byte digest. */
export function verifyDigest(
  digest: Uint8Array,
  signatureHex: string,
  publicKey: Uint8Array,
): boolean {
  try {
    const bytes = hexToBytes(signatureHex);
    if (bytes.length !== 65) return false;
    const compact = bytes.slice(1); // r || s
    return secp256k1.verify(compact, digest, publicKey, { prehash: false, lowS: true });
  } catch {
    return false;
  }
}
