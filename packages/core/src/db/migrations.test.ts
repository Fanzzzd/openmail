import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { MIGRATIONS } from "./migrations.js";

// MIGRATIONS is append-only: a database at user_version n has already run entries 0..n-1,
// so editing one of them would leave existing databases on a schema no fresh one gets.
// PINNED holds the first 16 hex digits of sha256(JSON.stringify(entry)), one line per
// migration in order. To append a migration, add it to MIGRATIONS and run this test: it
// fails and prints the line to append below. Never change an existing line.
const PINNED = [
  "ffaef753aa445f97",
  "a3e0aa00e89a071a",
  "d6c325341e408c74",
  "7ff697fe9cc322e3",
  "8036424bf1ed37b9",
  "137d9a15b203ee84",
  "7f5820b382241219",
  "d1fb726175acf440",
  "7a67b46c82057bb8",
  "4a94dd42cfe646e7",
  "2f953db58ecc2478",
  "0bdb30e1be8089e5",
  "6885631c70579e0e",
  "2b87ca3f7b33f597",
  "8190ddf386b786fa",
  "0b145eac9007d443",
  "a1744f2a9c6c002f",
  "e2e28d8ddb371d49",
  "f01e3028aeba1d6b",
  "287502e246fed570",
  "0c8595ee203fea60",
  "6619df59ebbf9003",
  "436f059260055829",
  "6f8991214ce1fc74",
  "c4865e16b237ed9b",
  "cfafae648b09c4c4",
  "783267e0476e1605",
  "eeeaf0112aeb1251",
  "47e7179eb18aee90",
  "047b79450660f831",
  "7a34a528ce12db05",
  "174eca578ea3b194",
  "203fbab8f9a1d9d1",
  "64d9b72cf15307b0",
  "e96304af9a9e2799",
  "7cbd27b9ee9c745c",
  "2f7271c9d6239083",
  "aee7dcff3c1eeef0",
  "4690a0403f8e4834",
  "88afebef450912ab",
  "1b7becf7efab2cc7",
  "fcbefb746c3b50b0",
  "7956fa00f62a80fd",
  "a4682e6c5f03ca09",
  "13104613b2531609",
  "508601196c55c4a8",
  "36a604fe9d5be2c4",
  "38745b9043ffdacf",
  "d24779e48baf9a3e",
  "88a48b7ad821a905",
  "665c0f69b913699c",
  "0bcb2ed7e5bf3896",
  "da0d7fc13c1d5aa3",
];
const pin = (migration: unknown) =>
  createHash("sha256").update(JSON.stringify(migration)).digest("hex").slice(0, 16);

it("never edits, removes or reorders an existing migration", () => {
  expect(MIGRATIONS.length).toBeGreaterThanOrEqual(PINNED.length);
  for (const [index, pinned] of PINNED.entries())
    expect(
      pin(MIGRATIONS[index]),
      `MIGRATIONS[${index}] changed. Existing migrations are append-only: restore it and append a new migration instead.`,
    ).toBe(pinned);
});

it("pins every migration", () => {
  const unpinned = MIGRATIONS.slice(PINNED.length).map(pin);
  expect(
    unpinned,
    `New migrations are not pinned. Append these lines to PINNED in migrations.test.ts:\n${unpinned.map((hash) => `  "${hash}",`).join("\n")}`,
  ).toEqual([]);
});
