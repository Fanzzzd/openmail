import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { Store } from "./services.js";
import { StoreLive } from "./store.js";
import { MemoryPlatform } from "./platform/node/platform-memory.js";
import { Mailbox } from "./mailbox.js";
import { TestMailbox, fakeServer } from "./platform/node/testing.js";
import type { IncomingMessage } from "./domain.js";
import {
  graphSearch,
  matchesSearch,
  parseSearchExpression,
  serverSearchIgnored,
} from "./search.js";
import { imapSearch } from "./platform/node/imap-search.js";
import { parseAppLink, privateMailLink, messageLink } from "./system.js";

const message: IncomingMessage = {
  providerId: "m",
  threadId: "t",
  subject: "Review",
  from: { name: "Bob", address: "bob@example.com" },
  to: [],
  cc: [],
  date: 1,
  snippet: "",
  bodyText: "请查收附件中的季度报告 budget",
  bodyHtml: "",
  labels: ["INBOX"],
  attachments: [],
  isUnread: true,
  isStarred: false,
};
const withStore = <A, E>(program: Effect.Effect<A, E, Store>) =>
  program.pipe(Effect.provide(StoreLive.pipe(Layer.provide(MemoryPlatform()))));
import { InvalidInput } from "./errors.js";

it.effect("Chinese substrings and mixed Chinese/Latin search preserve the original behavior", () =>
  withStore(
    Effect.gen(function* () {
      const store = yield* Store;
      const account = yield* store.upsertAccount("gmail", "me@example.com");
      yield* store.upsertMessage(account.id, message);
      for (const search of ["报告", "季度报告", "季度报告 budget", "报告 budget"]) {
        assert.strictEqual((yield* store.listThreads({ search })).length, 1, search);
        assert.ok(matchesSearch(message, { search }), search);
      }
    }),
  ),
);

it("negation of an inexact AND never narrows the server query", () => {
  assert.strictEqual(graphSearch({ search: "-(from:bob has:pdf)" }), "");
  assert.deepStrictEqual(imapSearch({ search: "-(from:bob has:pdf)" }), { all: true });
});
it("oversized queries fail with InvalidInput before building SQL", () => {
  assert.throws(
    () => parseSearchExpression(Array.from({ length: 1000 }, () => "from:bob").join(" OR ")),
    InvalidInput,
  );
});
it.effect("unknown size predicates and punctuation do not remove matches", () =>
  withStore(
    Effect.gen(function* () {
      const store = yield* Store;
      const account = yield* store.upsertAccount("outlook", "me@example.com");
      yield* store.upsertMessage(account.id, message);
      for (const search of [
        "larger:1M",
        "smaller:1",
        "-larger:1M",
        "-(from:bob larger:1M)",
        "!!!",
        "-!!!",
        "budget !!!",
      ]) {
        assert.strictEqual((yield* store.listThreads({ search })).length, 1, search);
        assert.ok(matchesSearch(message, { search }), search);
      }
    }),
  ),
);
it("new single-message links without Message-ID have an explicit marker, legacy links keep their meaning", () => {
  const target = { id: "gmail:me@example.com/m", accountId: "gmail:me@example.com" };
  const link = parseAppLink(privateMailLink(target, "message"));
  assert.ok(link?.kind === "message" && link.single === true);
  assert.deepStrictEqual(parseAppLink(messageLink(target.id)), { kind: "message", id: target.id });
});
it.effect(
  "disabled accounts reject cached stable and local deep links before any provider search",
  () => {
    const server = fakeServer("me@example.com", [{ ...message, rfcMessageId: "<m@example.com>" }]);
    return Effect.gen(function* () {
      const mailbox = yield* Mailbox;
      const account = yield* mailbox.connect({ provider: "gmail" });
      yield* mailbox.sync();
      const id = `${account.id}/m`;
      const link = parseAppLink(yield* mailbox.privateMailLink(id, "message"));
      assert.ok(link?.kind === "message");
      yield* mailbox.setAccountSettings(account.id, {
        enabled: false,
        description: "",
        color: null,
      });
      for (const reference of [link.id, id]) {
        const result = yield* mailbox.resolveMailLink(reference).pipe(Effect.result);
        assert.strictEqual(result._tag, "Failure");
      }
      assert.strictEqual(server.searched.length, 0);
    }).pipe(Effect.provide(TestMailbox({ gmail: server })));
  },
);

it.effect("1000-term public searches return a typed failure instead of a SQL defect", () =>
  withStore(
    Effect.gen(function* () {
      const store = yield* Store;
      const search = Array.from({ length: 1000 }, (_, index) => `term${index}`).join(" OR ");
      const listed = yield* store.listThreads({ search }).pipe(Effect.result);
      const counted = yield* store.countThreads({ search }).pipe(Effect.result);
      assert.strictEqual(listed._tag, "Failure");
      assert.strictEqual(counted._tag, "Failure");
      if (listed._tag === "Failure") assert.strictEqual(listed.failure._tag, "InvalidInput");
      if (counted._tag === "Failure") assert.strictEqual(counted.failure._tag, "InvalidInput");
    }),
  ),
);

it.effect("structured criteria also return InvalidInput before oversized SQL is constructed", () =>
  withStore(
    Effect.gen(function* () {
      const store = yield* Store;
      const result = yield* store
        .listThreads({
          criteria: { excluded: Array.from({ length: 1000 }, () => ({ subject: "budget" })) },
        })
        .pipe(Effect.result);
      assert.strictEqual(result._tag, "Failure");
      if (result._tag === "Failure") assert.strictEqual(result.failure._tag, "InvalidInput");
    }),
  ),
);

it("ignored search notices include supported operators dropped with an inexact negation", () => {
  for (const provider of ["imap", "outlook"] as const) {
    assert.deepStrictEqual(serverSearchIgnored({ search: "-(from:bob has:pdf)" }, provider), [
      "from:bob",
      "has:pdf",
    ]);
    assert.deepStrictEqual(serverSearchIgnored({ search: "from:bob has:pdf" }, provider), [
      "has:pdf",
    ]);
    assert.deepStrictEqual(
      serverSearchIgnored({ search: "-(from:bob OR to:alice)" }, provider),
      [],
    );
    assert.deepStrictEqual(
      serverSearchIgnored({ search: "subject:budget -(from:bob has:pdf)" }, provider),
      ["from:bob", "has:pdf"],
    );
  }
});
