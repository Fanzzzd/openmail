import { Effect, ManagedRuntime } from "effect";
import { expect, it } from "vitest";
import { Mailbox } from "./mailbox.js";
import { splitWriteBatch } from "./mailbox-sync.js";
import { fakeServer } from "./platform/node/fake-provider.js";
import { incoming, TestMailbox } from "./platform/node/testing.js";
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

// IMAP renewed it already; its connect also needs server settings.
for (const provider of ["gmail", "outlook"] as const)
  it(`${provider}: a full sync renews the inbox cursor, so inbox polls never start from an expired one`, async () => {
    const server = fakeServer("me@example.com", [incoming("one")]);
    const runtime = ManagedRuntime.make(TestMailbox({ [provider]: server }));
    try {
      await runtime.runPromise(
        Effect.gen(function* () {
          const m = yield* Mailbox;
          yield* m.connect({ provider });
          yield* m.sync(); // cursor "1"
          yield* m.pollInbox(); // inbox cursor "2"
          // Full syncs keep going (on a phone: in the foreground) while polls stop for a while.
          yield* m.sync(); // cursor "2"
          yield* m.sync(); // cursor "3"
          yield* m.pollInbox();
          // The poll starts from the newest full-sync cursor, not the one its last poll left.
          expect(server.pulls).toEqual([null, "1", "1", "2", "3"]);
        }),
      );
    } finally {
      await runtime.dispose();
    }
  });
