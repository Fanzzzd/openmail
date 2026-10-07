import { readFileSync } from "node:fs";
import { expect } from "vitest";

/** Native byte equality avoids enumerating every Buffer index in Vitest's deep comparator. */
export function expectFileBytes(file: string, expected: Uint8Array): void {
  const actual = readFileSync(file);
  expect(
    actual.equals(expected),
    `${file}: actual ${actual.byteLength} bytes, expected ${expected.byteLength} bytes`,
  ).toBe(true);
}
