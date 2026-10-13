import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { MIGRATIONS } from "./migrations.js";

// MIGRATIONS is append-only: a database at user_version n has already run entries 0..n-1,
// so editing one of them would leave existing databases on a schema no fresh one gets.
// When you append a migration, leave these two values alone.
const PINNED_COUNT = 48;
const PINNED_SHA256 = "f9f381665d790937dcf4e91523a8d2485ad4ac59af25c01f250841195253f0ef";

it("never edits, removes or reorders an existing migration", () => {
  expect(MIGRATIONS.length).toBeGreaterThanOrEqual(PINNED_COUNT);
  const digest = createHash("sha256")
    .update(JSON.stringify(MIGRATIONS.slice(0, PINNED_COUNT)))
    .digest("hex");
  expect(digest).toBe(PINNED_SHA256);
});
