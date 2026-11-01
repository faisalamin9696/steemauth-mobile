/**
 * Little-endian binary byte writer used by the Steem transaction serializer.
 * Ported from the semantics of bytebuffer as used by dsteem.
 */

export function utf8Encode(str: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i);
    if (c < 0x80) {
      out.push(c);
    } else if (c < 0x800) {
      out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    } else if (c >= 0xd800 && c <= 0xdbff) {
      const c2 = str.charCodeAt(++i);
      const cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
      out.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      );
    } else {
      out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
  }
  return Uint8Array.from(out);
}

export class ByteWriter {
  private buf: Uint8Array;
  private view: DataView;
  private len = 0;

  constructor(initialCapacity = 1024) {
    this.buf = new Uint8Array(initialCapacity);
    this.view = new DataView(this.buf.buffer);
  }

  private ensure(extra: number) {
    if (this.len + extra <= this.buf.length) return;
    let cap = this.buf.length;
    while (cap < this.len + extra) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
    this.view = new DataView(next.buffer);
  }

  writeUint8(value: number) {
    this.ensure(1);
    this.view.setUint8(this.len, value);
    this.len += 1;
  }

  writeInt8(value: number) {
    this.ensure(1);
    this.view.setInt8(this.len, value);
    this.len += 1;
  }

  writeUint16(value: number) {
    this.ensure(2);
    this.view.setUint16(this.len, value, true);
    this.len += 2;
  }

  writeInt16(value: number) {
    this.ensure(2);
    this.view.setInt16(this.len, value, true);
    this.len += 2;
  }

  writeUint32(value: number) {
    this.ensure(4);
    this.view.setUint32(this.len, value, true);
    this.len += 4;
  }

  writeInt32(value: number) {
    this.ensure(4);
    this.view.setInt32(this.len, value, true);
    this.len += 4;
  }

  /** 64-bit little-endian write accepting number or bigint. */
  writeUint64(value: number | bigint) {
    let v = typeof value === 'bigint' ? value : BigInt(Math.trunc(value));
    if (v < 0n) v += 1n << 64n;
    this.ensure(8);
    for (let i = 0; i < 8; i++) {
      this.view.setUint8(this.len + i, Number(v & 0xffn));
      v >>= 8n;
    }
    this.len += 8;
  }

  writeInt64(value: number | bigint) {
    this.writeUint64(value);
  }

  /** Protobuf-style unsigned LEB128 varint (bytebuffer writeVarint32). */
  writeVarint32(value: number) {
    let v = value >>> 0;
    this.ensure(5);
    while (v >= 0x80) {
      this.view.setUint8(this.len++, (v & 0x7f) | 0x80);
      v >>>= 7;
    }
    this.view.setUint8(this.len++, v);
  }

  /** Length-prefixed UTF-8 string (bytebuffer writeVString). */
  writeVString(value: string) {
    const bytes = utf8Encode(value);
    this.writeVarint32(bytes.length);
    this.append(bytes);
  }

  append(data: Uint8Array) {
    this.ensure(data.length);
    this.buf.set(data, this.len);
    this.len += data.length;
  }

  toBytes(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}
