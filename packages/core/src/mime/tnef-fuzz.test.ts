import * as fc from "fast-check";
import { expect, it } from "vitest";
import { decodeTnef } from "./tnef.js";
import { InvalidInput } from "../domain/errors.js";

const options = {
  seed: 0x520054,
  numRuns: process.env.OPENMAIL_LOW_MEMORY_TESTS === "1" ? 40 : 200,
};
const header = new Uint8Array([0x78, 0x9f, 0x3e, 0x22, 0, 0]);
const attribute = (id: number, data: Uint8Array) => {
  const bytes = new Uint8Array(data.length + 11);
  const view = new DataView(bytes.buffer);
  bytes[0] = 2;
  view.setUint32(1, id, true);
  view.setUint32(5, data.length, true);
  bytes.set(data, 9);
  view.setUint16(
    bytes.length - 2,
    data.reduce((sum, value) => (sum + value) & 0xffff, 0),
    true,
  );
  return bytes;
};
const concat = (...parts: Uint8Array[]) => {
  const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
};

it("TNEF arbitrary/truncated data rejects only with InvalidInput", () => {
  fc.assert(
    fc.property(fc.uint8Array({ maxLength: 4096 }), (data) => {
      for (const raw of [data, concat(header, data)]) {
        try {
          const files = decodeTnef(raw);
          expect(files.length).toBeLessThanOrEqual(256);
          expect(files.reduce((sum, file) => sum + file.data.length, 0)).toBeLessThanOrEqual(
            raw.length,
          );
        } catch (error) {
          expect(error).toBeInstanceOf(InvalidInput);
        }
      }
    }),
    options,
  );
});

it("TNEF declared sizes/counts cannot allocate from hostile uint32 values", () => {
  const huge = new Uint8Array([255, 255, 255, 255]);
  for (const raw of [
    concat(header, new Uint8Array([2, 15, 128, 0, 0]), huge),
    concat(header, attribute(0x9002, new Uint8Array()), attribute(0x9005, huge)),
  ]) {
    expect(() => decodeTnef(raw)).toThrow(InvalidInput);
  }
});

it("TNEF valid attachments share bounded input and detect corrupt checksums", () => {
  fc.assert(
    fc.property(fc.uint8Array({ maxLength: 4096 }), (data) => {
      const raw = concat(
        header,
        attribute(0x9002, new Uint8Array()),
        attribute(0x8010, new TextEncoder().encode("a.txt\0")),
        attribute(0x800f, data),
      );
      const file = decodeTnef(raw)[0];
      expect(file?.data).toEqual(data);
      expect(file?.data.buffer).toBe(raw.buffer);
      expect(file?.filename).toBe("a.txt");
      raw[raw.length - 1] = (raw[raw.length - 1] ?? 0) ^ 1;
      expect(() => decodeTnef(raw)).toThrow(InvalidInput);
    }),
    options,
  );
});

it("TNEF scans one MiB attachments within time and memory budgets", () => {
  const input = concat(
    header,
    attribute(0x9002, new Uint8Array()),
    attribute(0x800f, new Uint8Array(1024 * 1024)),
  );
  const started = performance.now();
  expect(decodeTnef(input)[0]?.data.length).toBe(1024 * 1024);
  expect(performance.now() - started).toBeLessThan(5000);
});
