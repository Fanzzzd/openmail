import { assert, it } from "@effect/vitest";
import { graphTimestamp } from "./graph-time.js";

it("Graph automatic reply times handle Windows zones, IANA zones and daylight saving", () => {
  assert.strictEqual(
    graphTimestamp({ dateTime: "2026-09-30T09:00:00", timeZone: "Pacific Standard Time" }),
    Date.parse("2026-09-30T16:00:00Z"),
  );
  assert.strictEqual(
    graphTimestamp({ dateTime: "2026-01-30T09:00:00", timeZone: "Pacific Standard Time" }),
    Date.parse("2026-01-30T17:00:00Z"),
  );
  assert.strictEqual(
    graphTimestamp({ dateTime: "2026-09-30T09:00:00", timeZone: "Asia/Singapore" }),
    Date.parse("2026-09-30T01:00:00Z"),
  );
  assert.strictEqual(
    graphTimestamp({ dateTime: "2026-09-30T09:00:00Z", timeZone: "Pacific Standard Time" }),
    Date.parse("2026-09-30T09:00:00Z"),
  );
  assert.throws(
    () => graphTimestamp({ dateTime: "2026-03-08T02:30:00", timeZone: "Pacific Standard Time" }),
    RangeError,
  );
});
