import { expect, it } from "vitest";
import { splitWriteBatch } from "./mailbox-sync.js";
import { incoming } from "./platform/node/testing.js";
import { type Change } from "./services.js";

const upsert = (id: string, htmlLength: number): Change => ({
  _tag: "Upsert",
  message: incoming(id, { bodyHtml: "x".repeat(htmlLength), bodyText: "" }),
});
const tags = (parts: Change[][]) =>
  parts.map((part) =>
    part.map((change) => (change._tag === "Upsert" ? change.message.providerId : change._tag)),
  );

it("cuts a write batch by body size and keeps each message's Progress with it", () => {
  const progress: Change = { _tag: "Progress", fetched: 1, total: 4 };
  const batch = [
    upsert("a", 105_000),
    progress,
    upsert("b", 105_000),
    progress,
    upsert("c", 50_000),
    upsert("d", 20_000),
    { _tag: "Cursor", cursor: "end" } satisfies Change,
  ];
  expect(tags(splitWriteBatch(batch, 200_000))).toEqual([
    ["a", "Progress"],
    ["b", "Progress", "c", "d", "Cursor"],
  ]);
  // A message over the budget gets its own transaction; small batches stay whole.
  expect(tags(splitWriteBatch([upsert("big", 500_000), upsert("e", 10)], 200_000))).toEqual([
    ["big"],
    ["e"],
  ]);
  expect(splitWriteBatch([progress, progress], 200_000)).toEqual([[progress, progress]]);
  expect(splitWriteBatch([])).toEqual([]);
});
