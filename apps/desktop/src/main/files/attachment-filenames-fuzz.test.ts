import * as fc from "fast-check";
import path from "node:path";
import { expect, it } from "vitest";
import { safeFilename } from "./attachment-filenames";

it("whitespace cannot turn dot-only names into directory traversal", () => {
  for (const name of [" . ", " .. ", " ... ", "\t..\t", " .hidden", `${"a".repeat(198)}  x`]) {
    const safe = safeFilename(name);
    expect(safe).not.toMatch(/^\./);
    expect(safe.trim()).toBe(safe);
    expect(safeFilename(safe)).toBe(safe);
    expect(path.dirname(path.resolve("/tmp/openmail-filename-test", safe))).toBe(
      "/tmp/openmail-filename-test",
    );
  }
});

it("seeded filenames stay inside a destination directory and are idempotent", () => {
  fc.assert(
    fc.property(fc.string({ unit: "binary", maxLength: 1024 }), (input) => {
      const name = safeFilename(input);
      expect(name).not.toMatch(/[\\/:\p{Cc}\p{Cf}]/u);
      expect(name).not.toMatch(/^\./);
      expect(name.trim()).toBe(name);
      expect(name.length).toBeGreaterThan(0);
      expect(Buffer.byteLength(name)).toBeLessThanOrEqual(200);
      expect(safeFilename(name)).toBe(name);
      expect(path.dirname(path.resolve("/tmp/openmail-filename-test", name))).toBe(
        "/tmp/openmail-filename-test",
      );
    }),
    { seed: 0x520059, numRuns: process.env.OPENMAIL_LOW_MEMORY_TESTS === "1" ? 40 : 200 },
  );
});
