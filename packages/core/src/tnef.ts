import { InvalidInput } from "./errors.js";

/** MS-OXTNEF attachment extraction. No decompression, network, or filesystem access.
 * Spec: https://learn.microsoft.com/en-us/openspecs/exchange_server_protocols/ms-oxtnef/
 * Views share the bounded input; untrusted counts never allocate arrays. */
export const MAX_ATTACHMENT_CONTAINER_BYTES = 32 * 1024 * 1024;
export const MAX_CONTAINER_PARTS = 256;
const MAX_FIELDS = 4096;

export interface ContainerFile {
  readonly filename: string;
  readonly mimeType: string;
  readonly data: Uint8Array;
}

class Cursor {
  private offset = 0;
  constructor(private readonly bytes: Uint8Array) {}
  get remaining() {
    return this.bytes.length - this.offset;
  }
  take(length: number): Uint8Array {
    if (!Number.isSafeInteger(length) || length < 0 || length > this.remaining)
      throw new InvalidInput({ message: "Truncated TNEF data" });
    const value = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }
  u8() {
    return this.take(1)[0]!;
  }
  u16() {
    const value = this.take(2);
    return new DataView(value.buffer, value.byteOffset, 2).getUint16(0, true);
  }
  u32() {
    const value = this.take(4);
    return new DataView(value.buffer, value.byteOffset, 4).getUint32(0, true);
  }
  variable() {
    const size = this.u32();
    const value = this.take(size);
    this.take((4 - (size % 4)) % 4);
    return value;
  }
  count() {
    const count = this.u32();
    if (count > MAX_FIELDS) throw new InvalidInput({ message: "Too many TNEF properties" });
    return count;
  }
}

const text = (bytes: Uint8Array, unicode = false) => {
  if (bytes.length > 8192)
    throw new InvalidInput({ message: "TNEF filename or MIME type is too long" });
  let decoded = "";
  // Preserve raw UTF-16 code units, including BOM/lone surrogates; ignore an odd trailing byte.
  const stride = unicode ? 2 : 1;
  for (let index = 0; index + stride <= bytes.length; index += stride) {
    const low = bytes[index]!;
    decoded += String.fromCharCode(unicode ? low | (bytes[index + 1]! << 8) : low);
  }
  return decoded.replace(/\0.*$/s, "");
};

type Pending = { filename: string; mimeType: string; data: Uint8Array | null; longName: boolean };
function properties(bytes: Uint8Array, file: Pending) {
  const cursor = new Cursor(bytes);
  const count = cursor.count();
  let remainingValues = MAX_FIELDS;
  for (let index = 0; index < count; index++) {
    const encodedType = cursor.u16();
    const id = cursor.u16();
    const type = encodedType & ~0x1000;
    if (id >= 0x8000) {
      cursor.take(16);
      const kind = cursor.u32();
      if (kind === 0) cursor.take(4);
      else if (kind === 1) cursor.variable();
      else throw new InvalidInput({ message: "Invalid named TNEF property" });
    }
    const variable = type === 0x1e || type === 0x1f || type === 0x102 || type === 0x0d;
    const multi = (encodedType & 0x1000) !== 0;
    const values = variable || multi ? cursor.count() : 1;
    remainingValues -= values;
    if (remainingValues < 0) throw new InvalidInput({ message: "Too many TNEF property values" });
    for (let valueIndex = 0; valueIndex < values; valueIndex++) {
      if (variable) {
        const value = cursor.variable();
        if (valueIndex !== 0 || multi) continue;
        if ((id === 0x3707 || id === 0x3704) && (type === 0x1e || type === 0x1f)) {
          if (id === 0x3707 || !file.longName) file.filename = text(value, type === 0x1f);
          if (id === 0x3707) file.longName = true;
        } else if (id === 0x370e && (type === 0x1e || type === 0x1f)) {
          const mime = text(value, type === 0x1f);
          if (/^[\w.+-]+\/[\w.+-]+$/.test(mime)) file.mimeType = mime;
        } else if (id === 0x3701 && type === 0x102) file.data = value;
      } else {
        switch (type) {
          case 0:
          case 1:
            break;
          case 2:
          case 3:
          case 4:
          case 0x0a:
          case 0x0b:
            cursor.take(4);
            break;
          case 5:
          case 6:
          case 7:
          case 0x14:
          case 0x40:
            cursor.take(8);
            break;
          case 0x48:
            cursor.take(16);
            break;
          default:
            throw new InvalidInput({ message: "Unsupported TNEF property type" });
        }
      }
    }
  }
  if (cursor.remaining) throw new InvalidInput({ message: "Trailing TNEF property data" });
}

export function decodeTnef(raw: Uint8Array): ContainerFile[] {
  if (raw.byteLength > MAX_ATTACHMENT_CONTAINER_BYTES)
    throw new InvalidInput({ message: "TNEF exceeds 32 MB" });
  const cursor = new Cursor(raw);
  if (cursor.u32() !== 0x223e9f78) throw new InvalidInput({ message: "Invalid TNEF signature" });
  cursor.u16(); // legacy key
  const files: ContainerFile[] = [];
  let current: Pending | null = null;
  const finish = () => {
    if (current?.data) {
      if (files.length >= MAX_CONTAINER_PARTS)
        throw new InvalidInput({ message: "Too many TNEF attachments" });
      files.push({
        filename: current.filename || `attachment-${files.length + 1}`,
        mimeType: current.mimeType,
        data: current.data,
      });
    }
  };
  let fields = 0;
  while (cursor.remaining) {
    if (++fields > MAX_FIELDS) throw new InvalidInput({ message: "Too many TNEF attributes" });
    const level = cursor.u8();
    const attribute = cursor.u32() & 0xffff;
    const data = cursor.take(cursor.u32());
    const checksum = cursor.u16();
    let sum = 0;
    for (const byte of data) sum = (sum + byte) & 0xffff;
    if (sum !== checksum) throw new InvalidInput({ message: "Invalid TNEF checksum" });
    if (level !== 1 && level !== 2)
      throw new InvalidInput({ message: "Invalid TNEF attribute level" });
    if (level !== 2) continue;
    if (attribute === 0x9002) {
      finish();
      current = { filename: "", mimeType: "application/octet-stream", data: null, longName: false };
    } else if (current) {
      if ((attribute === 0x8010 || attribute === 0x9001) && !current.longName)
        current.filename = text(data);
      else if (attribute === 0x800f) current.data = data;
      else if (attribute === 0x9005) properties(data, current);
    }
  }
  finish();
  return files;
}

export const isTnef = (file: { filename: string; mimeType: string }) =>
  /^(application\/(ms-tnef|vnd\.ms-tnef))$/i.test(file.mimeType) ||
  /(^|[\\/])winmail\.dat$/i.test(file.filename);
export const isEmbeddedMessage = (file: { filename: string; mimeType: string }) =>
  /^message\/rfc822$/i.test(file.mimeType) || /\.eml$/i.test(file.filename);
