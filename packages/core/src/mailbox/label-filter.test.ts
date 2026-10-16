import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import type { IncomingMessage, ThreadQuery } from "../domain/message.js";
import { MemoryPlatform } from "../platform/node/platform-memory.js";
import { Store } from "../store/service.js";
import { StoreLive } from "../store/store.js";
import { threadsWithLabel } from "./label-filter.js";

const mail = (providerId: string, labels: string[], date: number): IncomingMessage => ({
  providerId,
  threadId: providerId,
  subject: providerId,
  from: { name: "Alice", address: "alice@example.com" },
  to: [],
  cc: [],
  date,
  snippet: "",
  bodyText: "hello",
  bodyHtml: "",
  labels,
  attachments: [],
  isUnread: false,
  isStarred: false,
});

const seeded = Effect.gen(function* () {
  const store = yield* Store;
  const work = yield* store.upsertAccount("gmail", "work@example.com");
  const home = yield* store.upsertAccount("gmail", "home@example.com");
  yield* store.replaceLabels(work.id, [{ id: "Label_1", name: "Projects", color: null }]);
  yield* store.replaceLabels(home.id, [{ id: "Label_9", name: "projects", color: null }]);
  yield* store.upsertMessage(work.id, mail("w1", ["INBOX", "Label_1"], 3000));
  yield* store.upsertMessage(work.id, mail("w2", ["INBOX"], 2000));
  yield* store.upsertMessage(home.id, mail("h1", ["INBOX", "Label_9"], 1000));
  return { store, accountIds: [work.id, home.id] };
});

const withStore = <A, E>(body: Effect.Effect<A, E, Store>) =>
  body.pipe(Effect.provide(StoreLive.pipe(Layer.provideMerge(MemoryPlatform()))));

it.effect("label: search matches label names without regard to case, like Gmail", () =>
  withStore(
    Effect.gen(function* () {
      const { store } = yield* seeded;
      for (const search of ["label:Projects", "label:projects", "label:PROJECTS"])
        assert.deepStrictEqual(
          (yield* store.listThreads({ search })).map((row) => row.subject),
          ["w1", "h1"],
          search,
        );
      assert.strictEqual((yield* store.listThreads({ search: "-label:projects" })).length, 1);
    }),
  ),
);

it.effect("a list label filter takes an id, a system label or a name, and rejects a typo", () =>
  withStore(
    Effect.gen(function* () {
      const { store, accountIds } = yield* seeded;
      const reading = {
        threads: (q: ThreadQuery) => store.listThreads(q),
        labels: (ids?: readonly string[]) => store.listLabels(ids),
      };
      const subjects = (label: string, limit?: number) =>
        threadsWithLabel(reading, {
          mailbox: "all",
          accountIds,
          label,
          ...(limit === undefined ? {} : { limit }),
        }).pipe(Effect.map((rows) => (rows === null ? null : rows.map((row) => row.subject))));
      assert.deepStrictEqual(yield* subjects("Label_1"), ["w1"]);
      // One name, a different id in each account: both accounts' threads, newest first.
      assert.deepStrictEqual(yield* subjects("Projects"), ["w1", "h1"]);
      assert.deepStrictEqual(yield* subjects("PROJECTS", 1), ["w1"]);
      assert.deepStrictEqual(yield* subjects("inbox"), ["w1", "w2", "h1"]);
      assert.deepStrictEqual(yield* subjects("category_updates"), []);
      assert.isNull(yield* subjects("nope"));
      // A name only counts in the accounts the caller selected.
      assert.isNull(
        yield* threadsWithLabel(reading, {
          mailbox: "all",
          accountIds: [accountIds[1] ?? ""],
          label: "Label_1",
        }),
      );
    }),
  ),
);
