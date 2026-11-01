/**
 * Transaction construction, signing and broadcasting.
 */
import {
  buildExpiration,
  buildRefBlock,
  steemRpc,
  TransactionConfirmation,
} from './api';
import { sha256 } from '@noble/hashes/sha2.js';
import {
  CHAIN_ID_HEX,
  decodeWif,
  fromHex,
  signDigest,
} from './keys';
import {
  Operation,
  serializeTransaction,
  UnsignedTransaction,
} from './serializer';

/**
 * Required key authority per operation — moved to the PURE ./authority
 * module (no RPC/store imports) and re-exported here for compatibility.
 */
export {
  authoritySatisfies,
  batchAuthority,
  getRequiredAuthority,
  type KeyAuthority,
} from './authority';

/** Create the unsigned transaction skeleton from chain head data. */
export async function buildTransaction(
  operations: Operation[],
): Promise<UnsignedTransaction> {
  const props = await steemRpc.getDynamicGlobalProperties();
  const { ref_block_num, ref_block_prefix } = buildRefBlock(props);
  return {
    ref_block_num,
    ref_block_prefix,
    expiration: buildExpiration(props),
    operations,
    extensions: [],
  };
}

/** Sign an unsigned transaction with a WIF — returns the signed tx. */
export function signTransaction(
  tx: UnsignedTransaction,
  wif: string,
): UnsignedTransaction & { signatures: string[] } {
  const txBytes = serializeTransaction(tx);
  const chainId = fromHex(CHAIN_ID_HEX);
  const combined = new Uint8Array(chainId.length + txBytes.length);
  combined.set(chainId, 0);
  combined.set(txBytes, chainId.length);
  const digest = sha256(combined);
  const signature = signDigest(digest, decodeWif(wif));
  return { ...tx, signatures: [signature] };
}

/** sha256 of the serialized (unsigned) transaction — the transaction id. */
export function transactionId(tx: UnsignedTransaction): string {
  const bytes = serializeTransaction(tx);
  const hex: string[] = [];
  for (const b of sha256(bytes)) hex.push(b.toString(16).padStart(2, '0'));
  return hex.join('').slice(0, 40);
}

/**
 * Build + sign + broadcast a batch of operations with a single key.
 * Mirrors SteemApi.broadcast() from steempro-next.
 */
export async function broadcastOperations(
  operations: Operation[],
  wif: string,
): Promise<TransactionConfirmation> {
  if (!operations.length) throw new Error('No operations to broadcast');
  const unsigned = await buildTransaction(operations);
  const signed = signTransaction(unsigned, wif);
  const localId = transactionId(unsigned);
  // Preferred: the CONFIRMATION variant blocks until the transaction is in a
  // block and returns the real { id, block_num } — that is what the receipt
  // shows ("Included in block N"). A node without the method falls back to
  // the fire-and-forget broadcast (the receipt then has no block number).
  try {
    const conf = await steemRpc.broadcastTransactionConfirmation(signed);
    return { ...conf, id: conf?.id ?? localId };
  } catch (error: any) {
    // `error.message` is the node's FORMATTED text; `stack[0].format` is the
    // raw FC template (it reads "... Could not find method ${method}" with the
    // variable still in it), so prefer the message for display.
    const message: string =
      error?.message ?? error?.data?.stack?.[0]?.format ?? String(error);
    // ONLY a missing method falls back: consensus errors (duplicate tx,
    // missing authority, expired) must surface exactly as before. Modern
    // Steem nodes report a missing method as -32002 with
    // "method_itr != api_itr->second.end(): Could not find method X" (spec-
    // style ones use -32601 "Method not found") - both must fall back.
    const missingMethod =
      error?.code === -32601 ||
      /method not found|could not find method|method_itr|-32601/i.test(message);
    if (!missingMethod) throw new Error(`Steem broadcast failed: ${message}`);
    try {
      const result = await steemRpc.broadcastTransaction(signed);
      return { ...result, id: result?.id ?? localId };
    } catch (fallbackError: any) {
      const fallbackMessage =
        fallbackError?.message ?? fallbackError?.data?.stack?.[0]?.format;
      throw new Error(`Steem broadcast failed: ${fallbackMessage || fallbackError}`);
    }
  }
}
