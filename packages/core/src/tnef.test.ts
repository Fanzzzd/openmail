import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decodeTnef, MAX_ATTACHMENT_CONTAINER_BYTES } from "./tnef.js";

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}-winmail.dat`, import.meta.url));
describe("bounded MS-OXTNEF parser", () => {
  it("extracts real legacy attributes, preserving duplicates and untrusted names", () => {
    const files = decodeTnef(fixture("legacy"));
    expect(files.map((file) => [file.filename, Buffer.from(file.data).toString()])).toEqual([
      ["same.txt", "first"],
      ["same.txt", "second"],
      ["../../run.command", "echo unsafe"],
    ]);
  });
  it("extracts MAPI Unicode long filenames, MIME and binary data", () => {
    const [file] = decodeTnef(fixture("mapi"));
    expect(file?.filename).toBe("邮件.txt");
    expect(file?.mimeType).toBe("text/plain");
    expect(Buffer.from(file?.data ?? []).toString()).toBe("unicode file");
  });
  it("rejects every truncated prefix, checksum corruption and oversized input", () => {
    const raw = fixture("mapi");
    for (let size = 0; size < raw.length; size++) {
      // A complete header or attribute boundary is a valid stream without attachments.
      let files: ReturnType<typeof decodeTnef> = [];
      try {
        files = decodeTnef(raw.subarray(0, size));
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
      }
      expect(files).toEqual([]);
    }
    const corrupt = Buffer.from(raw);
    corrupt.writeUInt8(corrupt.readUInt8(corrupt.length - 1) ^ 1, corrupt.length - 1);
    expect(() => decodeTnef(corrupt)).toThrow("checksum");
    expect(() => decodeTnef(Buffer.alloc(MAX_ATTACHMENT_CONTAINER_BYTES + 1))).toThrow("32 MB");
  });
  it("bounds valid-checksum MAPI counts and attachment counts", () => {
    const raw = fixture("mapi");
    let offset = 6;
    while (raw.readUInt32LE(offset + 1) !== 0x00069005) offset += 11 + raw.readUInt32LE(offset + 5);
    const size = raw.readUInt32LE(offset + 5);
    raw.writeUInt32LE(0xffffffff, offset + 9);
    const checksum = raw
      .subarray(offset + 9, offset + 9 + size)
      .reduce((sum, byte) => (sum + byte) & 0xffff, 0);
    raw.writeUInt16LE(checksum, offset + 9 + size);
    expect(() => decodeTnef(raw)).toThrow("Too many TNEF properties");
    const legacy = fixture("legacy");
    // The first file begins after the stream version and codepage attributes.
    const begin = 6 + 15 + 19;
    const end = begin + 25 + 11 + 9 + 11 + 5;
    const repeated = Buffer.concat([
      legacy.subarray(0, begin),
      ...Array.from({ length: 257 }, () => legacy.subarray(begin, end)),
    ]);
    expect(() => decodeTnef(repeated)).toThrow("Too many TNEF attachments");
  });
  it("handles deterministic malformed sizes/counts without allocating from attacker counts", () => {
    const original = fixture("mapi");
    for (let n = 0; n < 600; n++) {
      const raw = Buffer.from(original);
      const offset = (n * 37) % (raw.length - 4);
      raw.writeUInt32LE(n % 2 ? 0xffffffff : n * 0x10000, offset);
      let count = 0;
      try {
        count = decodeTnef(raw).length;
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
      }
      expect(count).toBeLessThanOrEqual(256);
    }
  });
});

it("preserves native UTF-16LE filenames including BOMs, lone surrogates and odd tails", () => {
  const u32 = (value: number) => {
    const bytes = Buffer.alloc(4);
    bytes.writeUInt32LE(value);
    return bytes;
  };
  const attribute = (tag: number, data: Buffer) => {
    const checksum = Buffer.alloc(2);
    checksum.writeUInt16LE(data.reduce((sum, byte) => (sum + byte) & 0xffff, 0));
    return Buffer.concat([Buffer.from([2]), u32(tag), u32(data.length), data, checksum]);
  };
  for (const bytes of [
    Buffer.from([0xff, 0xfe, 0x61, 0]),
    Buffer.from([0, 0xd8, 0x61, 0]),
    Buffer.from([0, 0xdc]),
    Buffer.from([0x61, 0, 0xff]),
    Buffer.from([0x61, 0, 0, 0, 0x62, 0]),
  ]) {
    const property = Buffer.concat([
      u32(1),
      Buffer.from([0x1f, 0, 7, 0x37]),
      u32(1),
      u32(bytes.length),
      bytes,
      Buffer.alloc((4 - (bytes.length % 4)) % 4),
    ]);
    const raw = Buffer.concat([
      u32(0x223e9f78),
      Buffer.alloc(2),
      attribute(0x9002, Buffer.alloc(0)),
      attribute(0x800f, Buffer.from([1])),
      attribute(0x9005, property),
    ]);
    expect(decodeTnef(raw)[0]?.filename).toBe(bytes.toString("utf16le").replace(/\0.*$/s, ""));
  }
});
