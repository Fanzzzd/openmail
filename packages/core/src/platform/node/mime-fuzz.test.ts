import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { nodeMailCodec } from "./mail-codec.js";
import { parseMobileMime } from "../react-native/mail-codec.js";
import { hostileMime } from "../../reader/parser-fuzz-corpus.js";
import { PermanentError } from "../../domain/errors.js";
import { scaledMs } from "../../../test-support/test-time.js";

const options = {
  seed: 0x520047,
  numRuns: process.env.OPENMAIL_LOW_MEMORY_TESTS === "1" ? 20 : 100,
};
const codecs = [
  ["node", nodeMailCodec.parse],
  ["portable", parseMobileMime],
] as const;
const raw = (value: string) => new TextEncoder().encode(value);

for (const [name, parse] of codecs) {
  describe(`${name} MIME fuzz`, () => {
    it("rejects MIME over the platform cap before decoding or copying it", async () => {
      const limit = (name === "node" ? 64 : 25) * 1024 * 1024;
      await expect(parse(new Uint8Array(limit + 1))).rejects.toBeInstanceOf(PermanentError);
    });
    it("arbitrary bytes and mutated MIME reject only with a typed parse error", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.uint8Array({ maxLength: 4096 }),
          fc.constantFrom(...hostileMime),
          async (bytes, fixture) => {
            for (const input of [bytes, raw(fixture + new TextDecoder().decode(bytes))]) {
              try {
                const mail = await parse(input);
                const size = mail.attachments.reduce((sum, part) => sum + part.content.length, 0);
                expect(size).toBeLessThanOrEqual(input.length * 4 + 1024);
                expect(mail.attachments.length).toBeLessThanOrEqual(256);
                expect((mail.text?.length ?? 0) + (mail.html || "").length).toBeLessThanOrEqual(
                  input.length * 16 + 1024,
                );
              } catch (error) {
                if (error instanceof PermanentError) continue;
                throw error;
              }
            }
          },
        ),
        { ...options, timeout: scaledMs(5000) },
      );
    });

    it.each(hostileMime)("hostile MIME corpus: %s", async (fixture) => {
      const mail = await parse(raw(fixture));
      expect(mail.attachments.length).toBeLessThanOrEqual(256);
    });

    it("RFC 2231 UTF-8 filename continuations decode without losing the extension", async () => {
      await fc.assert(
        fc.asyncProperty(fc.string({ unit: "grapheme", maxLength: 40 }), async (stem) => {
          const filename = `${stem.replace(/[\r\n\0]/g, "_")}.txt`;
          const encoded = encodeURIComponent(filename);
          // Split at a complete %HH triplet, including inside a UTF-8 code point.
          const middle =
            encoded.indexOf("%") >= 0 ? encoded.indexOf("%") + 3 : Math.floor(encoded.length / 2);
          const mime = `Content-Type: application/octet-stream\r\nContent-Disposition: attachment;\r\n filename*0*=utf-8''${encoded.slice(0, middle)};\r\n filename*1*=${encoded.slice(middle)}\r\n\r\nbody`;
          expect((await parse(raw(mime))).attachments[0]?.filename).toBe(filename);
        }),
        options,
      );
    });

    it("one MiB base64 is decoded once, and huge headers are bounded", async () => {
      const started = performance.now();
      const before = process.memoryUsage().heapUsed;
      const input = raw(
        `Content-Type: application/zip\r\nContent-Transfer-Encoding: base64\r\n\r\n${"A".repeat(1024 * 1024)}`,
      );
      const mail = await parse(input);
      expect(mail.attachments[0]?.content.length).toBe(786432);
      const header = raw(`Subject: ${"a".repeat(1024 * 1024)}\r\n\r\nbody`);
      try {
        await parse(header);
      } catch (error) {
        expect(error).toBeInstanceOf(PermanentError);
      }
      expect(performance.now() - started).toBeLessThan(scaledMs(10_000));
      expect(process.memoryUsage().heapUsed - before).toBeLessThan(128 * 1024 * 1024);
    });

    it("deep MIME nesting rejects only with a typed error", async () => {
      const depth = 100;
      const mime = `${Array.from({ length: depth }, (_, i) => `Content-Type: multipart/mixed; boundary=b${i}\r\n\r\n--b${i}\r\n`).join("")}Content-Type: text/plain\r\n\r\nbody\r\n${Array.from({ length: depth }, (_, i) => `--b${depth - i - 1}--\r\n`).join("")}`;
      try {
        await parse(raw(mime));
      } catch (error) {
        expect(error).toBeInstanceOf(PermanentError);
      }
    });
  });
}
