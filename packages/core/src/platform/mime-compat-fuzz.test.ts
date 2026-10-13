import * as fc from "fast-check";
import { expect, it } from "vitest";
import { Buffer } from "./bytes.js";
import {
  signedMime,
  signedRoot,
  uuAttachments,
  normalizeMimeCharsets,
  compatibleMime,
  MAX_UU_BODY,
} from "./mime-compat.js";
import type { MimeMessage } from "./mail-codec.js";
import { scaledMs } from "../../test-support/test-time.js";

const options = {
  seed: 0x520049,
  numRuns: process.env.OPENMAIL_LOW_MEMORY_TESTS === "1" ? 30 : 150,
};
const tlv = (tag: number, content: Uint8Array): Uint8Array => {
  const length: number[] = [];
  let remaining = content.length;
  do {
    length.unshift(remaining & 255);
    remaining = Math.floor(remaining / 256);
  } while (remaining);
  const header =
    content.length < 128 ? [tag, content.length] : [tag, 128 + length.length, ...length];
  const bytes = new Uint8Array(header.length + content.length);
  bytes.set(header);
  bytes.set(content, header.length);
  return bytes;
};
const join = (...parts: Uint8Array[]) => Buffer.concat(parts);
const signed = (inner: Uint8Array) =>
  tlv(
    48,
    join(
      tlv(6, Buffer.from("2a864886f70d010702", "hex")),
      tlv(
        160,
        tlv(
          48,
          join(
            tlv(2, new Uint8Array([1])),
            tlv(49, new Uint8Array()),
            tlv(
              48,
              join(tlv(6, Buffer.from("2a864886f70d010701", "hex")), tlv(160, tlv(4, inner))),
            ),
            tlv(49, new Uint8Array()),
          ),
        ),
      ),
    ),
  );
function uu(data: Uint8Array): string {
  const character = (value: number) => String.fromCharCode((value & 63) + 32);
  const lines: string[] = [];
  for (let offset = 0; offset < data.length; offset += 45) {
    const row = data.subarray(offset, offset + 45);
    let line = character(row.length);
    for (let i = 0; i < row.length; i += 3) {
      const a = row[i] ?? 0,
        b = row[i + 1] ?? 0,
        c = row[i + 2] ?? 0;
      line +=
        character(a >> 2) +
        character((a << 4) | (b >> 4)) +
        character((b << 2) | (c >> 6)) +
        character(c);
    }
    lines.push(line);
  }
  return `begin 644 fuzz.bin\n${lines.length ? `${lines.join("\n")}\n` : ""}\`\nend\n`;
}

it("DER/pkcs7 arbitrary, truncated and overlong lengths are total and bounded", () => {
  fc.assert(
    fc.property(fc.uint8Array({ maxLength: 4096 }), (bytes) => {
      for (const input of [
        bytes,
        join(new Uint8Array([48, 0x80]), bytes),
        join(new Uint8Array([48, 0x85, 255, 255, 255, 255, 255]), bytes),
      ]) {
        const result = signedMime(input);
        if (result) {
          expect(result.byteLength).toBeLessThanOrEqual(input.byteLength);
          expect(result.buffer).toBe(input.buffer);
        }
      }
      const encoded = signed(bytes);
      expect(signedMime(encoded)).toEqual(bytes);
      expect(signedMime(encoded.subarray(0, encoded.length - 1))).toBeUndefined();
    }),
    options,
  );
});

it("uuencode generated binaries round-trip and malformed/incomplete blocks remain text", () => {
  fc.assert(
    fc.property(fc.uint8Array({ maxLength: 1024 }), (bytes) => {
      const block = uu(bytes);
      const result = uuAttachments(`before\n${block}after\n`);
      expect(result.text).toBe("before\nafter\n");
      expect(result.attachments[0]?.content).toEqual(bytes);
      expect(result.attachments[0]?.filename).toBe("fuzz.bin");
      expect(result.attachments[0]?.size).toBe(bytes.length);
      for (const broken of [
        block.replace("end\n", "end \n"),
        block.replace(/end\n$/, ""),
        "begin 644 broken\nM!\nend\n",
      ]) {
        expect(uuAttachments(broken)).toEqual({ text: broken, attachments: [] });
      }
    }),
    options,
  );
});

it("uuencode arbitrary text is bounded, and one MiB inputs meet time/memory budgets", () => {
  fc.assert(
    fc.property(fc.string({ unit: "binary", maxLength: 4096 }), (text) => {
      const result = uuAttachments(text);
      expect(result.text.length).toBeLessThanOrEqual(text.length);
      expect(
        result.attachments.reduce((sum, part) => sum + part.content.length, 0),
      ).toBeLessThanOrEqual(text.length);
    }),
    options,
  );
  const started = performance.now();
  const before = process.memoryUsage().heapUsed;
  const encoded = signed(new Uint8Array(1024 * 1024));
  expect(signedMime(encoded)?.length).toBe(1024 * 1024);
  const text = "begin 644 incomplete\n".repeat(40_000);
  expect(uuAttachments(text)).toEqual({ text, attachments: [] });
  const oversized = `${uu(new Uint8Array([1]))}${"x".repeat(MAX_UU_BODY)}`;
  expect(uuAttachments(oversized)).toEqual({ text: oversized, attachments: [] });
  expect(performance.now() - started).toBeLessThan(scaledMs(5000));
  expect(process.memoryUsage().heapUsed - before).toBeLessThan(128 * 1024 * 1024);
});

it("charset normalization is total for malformed input and preserves binary attachment bytes", () => {
  fc.assert(
    fc.property(fc.uint8Array({ maxLength: 4096 }), (bytes) => {
      expect(normalizeMimeCharsets(bytes)).toBeInstanceOf(Uint8Array);
      const attachment = join(
        Buffer.from(
          'Content-Type: text/csv; charset=windows-1252\r\nContent-Disposition: attachment; filename="data.csv"\r\n\r\n',
        ),
        bytes,
      );
      expect(normalizeMimeCharsets(attachment)).toEqual(attachment);
    }),
    options,
  );
});

it("SignedData compatibility decoding preserves the outer envelope and parses only a signed root", async () => {
  await fc.assert(
    fc.asyncProperty(fc.string({ unit: "grapheme", maxLength: 100 }), async (body) => {
      const inner = Buffer.from(`Content-Type: text/plain\r\n\r\n${body}`);
      const outer: MimeMessage = {
        subject: "Outer subject",
        from: { value: [{ name: "Outer", address: "outer@example.test" }], text: "Outer" },
        text: "Outer body",
        html: false,
        headers: new Map([["authentication-results", "trusted"]]),
        attachments: [
          {
            filename: "smime.p7m",
            contentType: "application/pkcs7-mime",
            content: signed(inner),
            size: signed(inner).length,
            related: false,
            headers: new Map(),
          },
        ],
      };
      const parse = async (bytes: Uint8Array): Promise<MimeMessage> => {
        expect(bytes).toEqual(new Uint8Array(inner));
        return {
          subject: "Inner subject",
          text: body,
          html: false,
          attachments: [],
          headers: new Map(),
        };
      };
      const root = Buffer.from(
        "Content-Type: application/pkcs7-mime; smime-type=signed-data\r\n\r\nopaque",
      );
      const result = await compatibleMime(outer, parse, root);
      expect(result.text).toBe(body);
      expect(result.subject).toBe(outer.subject);
      expect(result.from).toBe(outer.from);
      expect(result.headers).toBe(outer.headers);
      const encrypted = Buffer.from(
        "Content-Type: application/pkcs7-mime; smime-type=enveloped-data\r\n\r\nopaque",
      );
      expect(signedRoot(encrypted)).toBe(false);
      expect(await compatibleMime(outer, parse, encrypted)).toBe(outer);
    }),
    options,
  );
});
