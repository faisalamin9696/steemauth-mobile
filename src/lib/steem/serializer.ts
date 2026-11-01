/**
 * Steem binary protocol serializer — a faithful port of
 * @steempro/dsteem lib/chain/serializer.js (operations 0..49).
 *
 * Only pure JS + Uint8Array: runs in Hermes with no polyfills.
 */
import { ByteWriter } from './bytes';
import { decodePublicKey } from './keys';

type Serializer = (buffer: ByteWriter, data: any) => void;

const StringSerializer: Serializer = (b, d) => b.writeVString(d);
const Int16Serializer: Serializer = (b, d) => b.writeInt16(d);
const Int64Serializer: Serializer = (b, d) => b.writeInt64(d);
const UInt16Serializer: Serializer = (b, d) => b.writeUint16(d);
const UInt32Serializer: Serializer = (b, d) => b.writeUint32(d);
const UInt64Serializer: Serializer = (b, d) => b.writeUint64(d);
const BooleanSerializer: Serializer = (b, d) => b.writeUint8(d ? 1 : 0);
const VoidSerializer: Serializer = () => {
  throw new Error('Void can not be serialized');
};

const StaticVariantSerializer =
  (itemSerializers: Serializer[]): Serializer =>
  (b, data) => {
    const [id, item] = data as [number, any];
    b.writeVarint32(id);
    itemSerializers[id](b, item);
  };

const AssetSerializer: Serializer = (b, data) => {
  const str = String(data).trim();
  const [amountStr, symbol] = str.split(/\s+/);
  const amount = Number.parseFloat(amountStr);
  if (!Number.isFinite(amount)) throw new Error(`Invalid asset amount: ${amountStr}`);
  if (!['STEEM', 'VESTS', 'TESTS', 'TBD', 'SBD'].includes(symbol)) {
    throw new Error(`Invalid asset symbol: ${symbol}`);
  }
  const dot = amountStr.indexOf('.');
  const precision = dot === -1 ? 0 : amountStr.length - dot - 1;
  b.writeInt64(Math.round(amount * Math.pow(10, precision)));
  b.writeUint8(precision);
  for (let i = 0; i < 7; i++) b.writeUint8(symbol.charCodeAt(i) || 0);
};

const DateSerializer: Serializer = (b, data) => {
  b.writeUint32(Math.floor(new Date(`${data}Z`).getTime() / 1000));
};

const NULL_PUBKEY = 'STM1111111111111111111111111111111114T1Anm';

const PublicKeySerializer: Serializer = (b, data) => {
  if (data === null || data === undefined || data === NULL_PUBKEY) {
    b.append(new Uint8Array(33));
  } else {
    b.append(decodePublicKey(data));
  }
};

const BinarySerializer =
  (size?: number): Serializer =>
  (b, data) => {
    const bytes: Uint8Array =
      typeof data === 'string' ? hexToBytesLocal(data) : (data as Uint8Array);
    if (size !== undefined && bytes.length !== size) {
      throw new Error(`Expected ${size} bytes, got ${bytes.length}`);
    }
    if (size === undefined) b.writeVarint32(bytes.length);
    b.append(bytes);
  };

const VariableBinarySerializer = BinarySerializer();

function hexToBytesLocal(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) throw new Error('odd-length hex');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.substr(i * 2, 2), 16);
  }
  return out;
}

const FlatMapSerializer =
  (keySerializer: Serializer, valueSerializer: Serializer): Serializer =>
  (b, data) => {
    b.writeVarint32(data.length);
    for (const [key, value] of data) {
      keySerializer(b, key);
      valueSerializer(b, value);
    }
  };

const ArraySerializer =
  (itemSerializer: Serializer): Serializer =>
  (b, data) => {
    b.writeVarint32(data.length);
    for (const item of data) itemSerializer(b, item);
  };

const ObjectSerializer =
  (keySerializers: [string, Serializer][]): Serializer =>
  (b, data) => {
    for (const [key, serializer] of keySerializers) {
      try {
        serializer(b, data[key]);
      } catch (error: any) {
        error.message = `${key}: ${error.message}`;
        throw error;
      }
    }
  };

const OptionalSerializer =
  (valueSerializer: Serializer): Serializer =>
  (b, data) => {
    if (data) {
      b.writeUint8(1);
      valueSerializer(b, data);
    } else {
      b.writeUint8(0);
    }
  };

const AuthoritySerializer = ObjectSerializer([
  ['weight_threshold', UInt32Serializer],
  ['account_auths', FlatMapSerializer(StringSerializer, UInt16Serializer)],
  ['key_auths', FlatMapSerializer(PublicKeySerializer, UInt16Serializer)],
]);

const BeneficiarySerializer = ObjectSerializer([
  ['account', StringSerializer],
  ['weight', UInt16Serializer],
]);

const PriceSerializer = ObjectSerializer([
  ['base', AssetSerializer],
  ['quote', AssetSerializer],
]);

const ProposalUpdateSerializer = ObjectSerializer([['end_date', DateSerializer]]);

const SignedBlockHeaderSerializer = ObjectSerializer([
  ['previous', BinarySerializer(20)],
  ['timestamp', DateSerializer],
  ['witness', StringSerializer],
  ['transaction_merkle_root', BinarySerializer(20)],
  ['extensions', ArraySerializer(VoidSerializer)],
  ['witness_signature', BinarySerializer(65)],
]);

const ChainPropertiesSerializer = ObjectSerializer([
  ['account_creation_fee', AssetSerializer],
  ['maximum_block_size', UInt32Serializer],
  ['sbd_interest_rate', UInt16Serializer],
]);

const OperationDataSerializer =
  (operationId: number, definitions: [string, Serializer][]): Serializer => {
    const objectSerializer = ObjectSerializer(definitions);
    return (b, data) => {
      b.writeVarint32(operationId);
      objectSerializer(b, data);
    };
  };

const OperationSerializers: Record<string, Serializer> = {};

OperationSerializers.vote = OperationDataSerializer(0, [
  ['voter', StringSerializer],
  ['author', StringSerializer],
  ['permlink', StringSerializer],
  ['weight', Int16Serializer],
]);
OperationSerializers.comment = OperationDataSerializer(1, [
  ['parent_author', StringSerializer],
  ['parent_permlink', StringSerializer],
  ['author', StringSerializer],
  ['permlink', StringSerializer],
  ['title', StringSerializer],
  ['body', StringSerializer],
  ['json_metadata', StringSerializer],
]);
OperationSerializers.transfer = OperationDataSerializer(2, [
  ['from', StringSerializer],
  ['to', StringSerializer],
  ['amount', AssetSerializer],
  ['memo', StringSerializer],
]);
OperationSerializers.transfer_to_vesting = OperationDataSerializer(3, [
  ['from', StringSerializer],
  ['to', StringSerializer],
  ['amount', AssetSerializer],
]);
OperationSerializers.withdraw_vesting = OperationDataSerializer(4, [
  ['account', StringSerializer],
  ['vesting_shares', AssetSerializer],
]);
OperationSerializers.limit_order_create = OperationDataSerializer(5, [
  ['owner', StringSerializer],
  ['orderid', UInt32Serializer],
  ['amount_to_sell', AssetSerializer],
  ['min_to_receive', AssetSerializer],
  ['fill_or_kill', BooleanSerializer],
  ['expiration', DateSerializer],
]);
OperationSerializers.limit_order_cancel = OperationDataSerializer(6, [
  ['owner', StringSerializer],
  ['orderid', UInt32Serializer],
]);
OperationSerializers.feed_publish = OperationDataSerializer(7, [
  ['publisher', StringSerializer],
  ['exchange_rate', PriceSerializer],
]);
OperationSerializers.convert = OperationDataSerializer(8, [
  ['owner', StringSerializer],
  ['requestid', UInt32Serializer],
  ['amount', AssetSerializer],
]);
OperationSerializers.account_create = OperationDataSerializer(9, [
  ['fee', AssetSerializer],
  ['creator', StringSerializer],
  ['new_account_name', StringSerializer],
  ['owner', AuthoritySerializer],
  ['active', AuthoritySerializer],
  ['posting', AuthoritySerializer],
  ['memo_key', PublicKeySerializer],
  ['json_metadata', StringSerializer],
]);
OperationSerializers.account_update = OperationDataSerializer(10, [
  ['account', StringSerializer],
  ['owner', OptionalSerializer(AuthoritySerializer)],
  ['active', OptionalSerializer(AuthoritySerializer)],
  ['posting', OptionalSerializer(AuthoritySerializer)],
  ['memo_key', PublicKeySerializer],
  ['json_metadata', StringSerializer],
]);
OperationSerializers.witness_update = OperationDataSerializer(11, [
  ['owner', StringSerializer],
  ['url', StringSerializer],
  ['block_signing_key', PublicKeySerializer],
  ['props', ChainPropertiesSerializer],
  ['fee', AssetSerializer],
]);
OperationSerializers.account_witness_vote = OperationDataSerializer(12, [
  ['account', StringSerializer],
  ['witness', StringSerializer],
  ['approve', BooleanSerializer],
]);
OperationSerializers.account_witness_proxy = OperationDataSerializer(13, [
  ['account', StringSerializer],
  ['proxy', StringSerializer],
]);
OperationSerializers.custom = OperationDataSerializer(15, [
  ['required_auths', ArraySerializer(StringSerializer)],
  ['id', UInt16Serializer],
  ['data', VariableBinarySerializer],
]);
OperationSerializers.report_over_production = OperationDataSerializer(16, [
  ['reporter', StringSerializer],
  ['first_block', SignedBlockHeaderSerializer],
  ['second_block', SignedBlockHeaderSerializer],
]);
OperationSerializers.delete_comment = OperationDataSerializer(17, [
  ['author', StringSerializer],
  ['permlink', StringSerializer],
]);
OperationSerializers.custom_json = OperationDataSerializer(18, [
  ['required_auths', ArraySerializer(StringSerializer)],
  ['required_posting_auths', ArraySerializer(StringSerializer)],
  ['id', StringSerializer],
  ['json', StringSerializer],
]);
OperationSerializers.comment_options = OperationDataSerializer(19, [
  ['author', StringSerializer],
  ['permlink', StringSerializer],
  ['max_accepted_payout', AssetSerializer],
  ['percent_steem_dollars', UInt16Serializer],
  ['allow_votes', BooleanSerializer],
  ['allow_curation_rewards', BooleanSerializer],
  [
    'extensions',
    ArraySerializer(
      StaticVariantSerializer([
        ObjectSerializer([['beneficiaries', ArraySerializer(BeneficiarySerializer)]]),
      ]),
    ),
  ],
]);
OperationSerializers.set_withdraw_vesting_route = OperationDataSerializer(20, [
  ['from_account', StringSerializer],
  ['to_account', StringSerializer],
  ['percent', UInt16Serializer],
  ['auto_vest', BooleanSerializer],
]);
OperationSerializers.limit_order_create2 = OperationDataSerializer(21, [
  ['owner', StringSerializer],
  ['orderid', UInt32Serializer],
  ['amount_to_sell', AssetSerializer],
  ['exchange_rate', PriceSerializer],
  ['fill_or_kill', BooleanSerializer],
  ['expiration', DateSerializer],
]);
OperationSerializers.claim_account = OperationDataSerializer(22, [
  ['creator', StringSerializer],
  ['fee', AssetSerializer],
  ['extensions', ArraySerializer(VoidSerializer)],
]);
OperationSerializers.create_claimed_account = OperationDataSerializer(23, [
  ['creator', StringSerializer],
  ['new_account_name', StringSerializer],
  ['owner', AuthoritySerializer],
  ['active', AuthoritySerializer],
  ['posting', AuthoritySerializer],
  ['memo_key', PublicKeySerializer],
  ['json_metadata', StringSerializer],
  ['extensions', ArraySerializer(VoidSerializer)],
]);
OperationSerializers.request_account_recovery = OperationDataSerializer(24, [
  ['recovery_account', StringSerializer],
  ['account_to_recover', StringSerializer],
  ['new_owner_authority', AuthoritySerializer],
  ['extensions', ArraySerializer(VoidSerializer)],
]);
OperationSerializers.recover_account = OperationDataSerializer(25, [
  ['account_to_recover', StringSerializer],
  ['new_owner_authority', AuthoritySerializer],
  ['recent_owner_authority', AuthoritySerializer],
  ['extensions', ArraySerializer(VoidSerializer)],
]);
OperationSerializers.change_recovery_account = OperationDataSerializer(26, [
  ['account_to_recover', StringSerializer],
  ['new_recovery_account', StringSerializer],
  ['extensions', ArraySerializer(VoidSerializer)],
]);
OperationSerializers.escrow_transfer = OperationDataSerializer(27, [
  ['from', StringSerializer],
  ['to', StringSerializer],
  ['sbd_amount', AssetSerializer],
  ['steem_amount', AssetSerializer],
  ['escrow_id', UInt32Serializer],
  ['agent', StringSerializer],
  ['fee', AssetSerializer],
  ['json_meta', StringSerializer],
  ['ratification_deadline', DateSerializer],
  ['escrow_expiration', DateSerializer],
]);
OperationSerializers.escrow_dispute = OperationDataSerializer(28, [
  ['from', StringSerializer],
  ['to', StringSerializer],
  ['agent', StringSerializer],
  ['who', StringSerializer],
  ['escrow_id', UInt32Serializer],
]);
OperationSerializers.escrow_release = OperationDataSerializer(29, [
  ['from', StringSerializer],
  ['to', StringSerializer],
  ['agent', StringSerializer],
  ['who', StringSerializer],
  ['receiver', StringSerializer],
  ['escrow_id', UInt32Serializer],
  ['sbd_amount', AssetSerializer],
  ['steem_amount', AssetSerializer],
]);
OperationSerializers.escrow_approve = OperationDataSerializer(31, [
  ['from', StringSerializer],
  ['to', StringSerializer],
  ['agent', StringSerializer],
  ['who', StringSerializer],
  ['escrow_id', UInt32Serializer],
  ['approve', BooleanSerializer],
]);
OperationSerializers.transfer_to_savings = OperationDataSerializer(32, [
  ['from', StringSerializer],
  ['to', StringSerializer],
  ['amount', AssetSerializer],
  ['memo', StringSerializer],
]);
OperationSerializers.transfer_from_savings = OperationDataSerializer(33, [
  ['from', StringSerializer],
  ['request_id', UInt32Serializer],
  ['to', StringSerializer],
  ['amount', AssetSerializer],
  ['memo', StringSerializer],
]);
OperationSerializers.cancel_transfer_from_savings = OperationDataSerializer(34, [
  ['from', StringSerializer],
  ['request_id', UInt32Serializer],
]);
OperationSerializers.custom_binary = OperationDataSerializer(35, [
  ['required_owner_auths', ArraySerializer(StringSerializer)],
  ['required_active_auths', ArraySerializer(StringSerializer)],
  ['required_posting_auths', ArraySerializer(StringSerializer)],
  ['required_auths', ArraySerializer(AuthoritySerializer)],
  ['id', StringSerializer],
  ['data', VariableBinarySerializer],
]);
OperationSerializers.decline_voting_rights = OperationDataSerializer(36, [
  ['account', StringSerializer],
  ['decline', BooleanSerializer],
]);
OperationSerializers.reset_account = OperationDataSerializer(37, [
  ['reset_account', StringSerializer],
  ['account_to_reset', StringSerializer],
  ['new_owner_authority', AuthoritySerializer],
]);
OperationSerializers.set_reset_account = OperationDataSerializer(38, [
  ['account', StringSerializer],
  ['current_reset_account', StringSerializer],
  ['reset_account', StringSerializer],
]);
OperationSerializers.claim_reward_balance = OperationDataSerializer(39, [
  ['account', StringSerializer],
  ['reward_steem', AssetSerializer],
  ['reward_sbd', AssetSerializer],
  ['reward_vests', AssetSerializer],
]);
OperationSerializers.delegate_vesting_shares = OperationDataSerializer(40, [
  ['delegator', StringSerializer],
  ['delegatee', StringSerializer],
  ['vesting_shares', AssetSerializer],
]);
OperationSerializers.account_create_with_delegation = OperationDataSerializer(41, [
  ['fee', AssetSerializer],
  ['delegation', AssetSerializer],
  ['creator', StringSerializer],
  ['new_account_name', StringSerializer],
  ['owner', AuthoritySerializer],
  ['active', AuthoritySerializer],
  ['posting', AuthoritySerializer],
  ['memo_key', PublicKeySerializer],
  ['json_metadata', StringSerializer],
  ['extensions', ArraySerializer(VoidSerializer)],
]);
OperationSerializers.witness_set_properties = OperationDataSerializer(42, [
  ['owner', StringSerializer],
  ['props', FlatMapSerializer(StringSerializer, VariableBinarySerializer)],
  ['extensions', ArraySerializer(VoidSerializer)],
]);
OperationSerializers.account_update2 = OperationDataSerializer(43, [
  ['account', StringSerializer],
  ['owner', OptionalSerializer(AuthoritySerializer)],
  ['active', OptionalSerializer(AuthoritySerializer)],
  ['posting', OptionalSerializer(AuthoritySerializer)],
  ['memo_key', OptionalSerializer(PublicKeySerializer)],
  ['json_metadata', StringSerializer],
  ['posting_json_metadata', StringSerializer],
  ['extensions', ArraySerializer(VoidSerializer)],
]);
OperationSerializers.create_proposal = OperationDataSerializer(44, [
  ['creator', StringSerializer],
  ['receiver', StringSerializer],
  ['start_date', DateSerializer],
  ['end_date', DateSerializer],
  ['daily_pay', AssetSerializer],
  ['subject', StringSerializer],
  ['permlink', StringSerializer],
  ['extensions', ArraySerializer(VoidSerializer)],
]);
OperationSerializers.update_proposal_votes = OperationDataSerializer(45, [
  ['voter', StringSerializer],
  ['proposal_ids', ArraySerializer(Int64Serializer)],
  ['approve', BooleanSerializer],
  ['extensions', ArraySerializer(VoidSerializer)],
]);
OperationSerializers.remove_proposal = OperationDataSerializer(46, [
  ['proposal_owner', StringSerializer],
  ['proposal_ids', ArraySerializer(Int64Serializer)],
  ['extensions', ArraySerializer(VoidSerializer)],
]);
OperationSerializers.update_proposal = OperationDataSerializer(47, [
  ['proposal_id', UInt64Serializer],
  ['creator', StringSerializer],
  ['daily_pay', AssetSerializer],
  ['subject', StringSerializer],
  ['permlink', StringSerializer],
  [
    'extensions',
    ArraySerializer(StaticVariantSerializer([VoidSerializer, ProposalUpdateSerializer])),
  ],
]);
OperationSerializers.collateralized_convert = OperationDataSerializer(48, [
  ['owner', StringSerializer],
  ['requestid', UInt32Serializer],
  ['amount', AssetSerializer],
]);
OperationSerializers.recurrent_transfer = OperationDataSerializer(49, [
  ['from', StringSerializer],
  ['to', StringSerializer],
  ['amount', AssetSerializer],
  ['memo', StringSerializer],
  ['recurrence', UInt16Serializer],
  ['executions', UInt16Serializer],
  ['extensions', ArraySerializer(VoidSerializer)],
]);

/** Steem operation: [name, params] */
export type Operation = [string, Record<string, any>];

export function serializeOperation(buffer: ByteWriter, operation: Operation) {
  const serializer = OperationSerializers[operation[0]];
  if (!serializer) throw new Error(`No serializer for operation: ${operation[0]}`);
  try {
    serializer(buffer, operation[1]);
  } catch (error: any) {
    error.message = `${operation[0]}: ${error.message}`;
    throw error;
  }
}

/** Operations this build can serialize (used for whitelist validation). */
export const SUPPORTED_OPERATIONS = Object.freeze(
  Object.keys(OperationSerializers).sort(),
);

export interface UnsignedTransaction {
  ref_block_num: number;
  ref_block_prefix: number;
  expiration: string; // "YYYY-MM-DDTHH:MM:SS"
  operations: Operation[];
  extensions: any[];
}

export function serializeTransaction(tx: UnsignedTransaction): Uint8Array {
  const b = new ByteWriter(512);
  b.writeUint16(tx.ref_block_num);
  b.writeUint32(tx.ref_block_prefix);
  DateSerializer(b, tx.expiration);
  b.writeVarint32(tx.operations.length);
  for (const op of tx.operations) serializeOperation(b, op);
  b.writeVarint32((tx.extensions ?? []).length);
  for (const ext of tx.extensions ?? []) StringSerializer(b, ext);
  return b.toBytes();
}
