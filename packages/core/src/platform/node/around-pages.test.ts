import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import {
  type ThreadQuery,
  type ThreadSummary,
  type IncomingMessage,
  type SearchCondition,
} from "../../domain/domain.js";
import {
  parseSearchQuery,
  parseSearchExpression,
  hasSearchExpression,
  searchWords,
  wordTokens,
  unquoteSearchValue,
  matchesSearchCondition,
  searchIncludesSpecialFolders,
  type SearchExpression,
} from "../../search.js";
import { MAILBOX_LABEL } from "../../domain/mailbox-labels.js";
import { Store } from "../../services.js";
import { StoreLive } from "../../store/store.js";
import { incoming } from "./testing.js";
import { MemoryPlatform } from "./platform-memory.js";
import { traceQueries } from "./fixtures/performance-mailbox.js";

const head = (row: ThreadSummary) => ({
  id: row.id,
  date: row.date,
  unread: Number(row.isUnread),
  starred: Number(row.isStarred),
  count: row.threadCount,
});

type FixtureMail = { id: string; accountId: string; message: IncomingMessage; chunks: string[] };
type Readiness = { messages: boolean; derived: boolean };

const binaryCompare = (a: string, b: string) => {
  const left = new TextEncoder().encode(a),
    right = new TextEncoder().encode(b);
  for (const [index, byte] of left.entries()) {
    const other = right[index];
    if (other === undefined) return 1;
    if (byte !== other) return byte - other;
  }
  return left.length - right.length;
};

const phraseStarts = (words: readonly string[], phrase: readonly string[]) =>
  Array.from(words.keys()).filter((i) => phrase.every((word, j) => words[i + j] === word));

// Read fixture text directly. No store SQL or listFilter participates in this oracle.
const referenceProximity = (
  columns: readonly string[],
  p: NonNullable<SearchCondition["proximity"]>,
  ready: boolean,
) => {
  if (!ready)
    return [p.left, p.right].every((operand) =>
      columns.some((text) => text.toLowerCase().includes(operand.toLowerCase())),
    );
  const left = wordTokens(p.left),
    right = wordTokens(p.right);
  if (!left.length || !right.length) return false;
  return columns.some((text) => {
    const words = wordTokens(text);
    return phraseStarts(words, left).some((a) =>
      phraseStarts(words, right).some((b) => {
        const forward = b - a - left.length,
          reverse = a - b - right.length;
        return (
          (forward >= 0 && forward <= p.distance) ||
          (!p.ordered && reverse >= 0 && reverse <= p.distance)
        );
      }),
    );
  });
};

const mailColumns = (message: IncomingMessage) => [
  message.subject,
  message.from.name,
  message.from.address,
  message.bodyText,
];

const referenceCondition = (mail: FixtureMail, condition: SearchCondition, ready: boolean) => {
  const { proximity, attachmentText, ...other } = condition;
  return (
    matchesSearchCondition(mail.message, other) &&
    (!attachmentText || mail.chunks.length > 0) &&
    (!proximity || referenceProximity(mailColumns(mail.message), proximity, ready))
  );
};

const referenceExpression = (
  node: SearchExpression,
  mail: FixtureMail,
  readiness: Readiness,
  media: boolean,
  attachmentOnly: boolean,
): boolean => {
  switch (node.kind) {
    case "and": {
      const scoped =
        attachmentOnly ||
        node.children.some(
          (child) =>
            child.kind === "term" &&
            parseSearchQuery({ search: child.value }).criteria?.attachmentText === true,
        );
      return node.children.every((child) =>
        referenceExpression(child, mail, readiness, media, scoped),
      );
    }
    case "or":
      return node.children.some((child) =>
        referenceExpression(child, mail, readiness, media, attachmentOnly),
      );
    case "not":
      return !referenceExpression(node.child, mail, readiness, media, attachmentOnly);
    case "term": {
      const q = parseSearchQuery({ search: node.value });
      const condition = q.criteria ?? {};
      let match = referenceCondition(mail, condition, readiness.messages);
      if (condition.proximity) {
        const p = condition.proximity;
        const derived = mail.chunks.some((text) =>
          referenceProximity([text], p, readiness.derived),
        );
        match = attachmentOnly ? derived : media ? match || derived : match;
      }
      if (
        !match ||
        (q.unreadOnly && !mail.message.isUnread) ||
        (q.starredOnly && !mail.message.isStarred)
      )
        return false;
      if (!q.search) return true;
      const term = q.search;
      const textMatch = (text: string, ready: boolean) =>
        ready
          ? phraseStarts(wordTokens(text), wordTokens(unquoteSearchValue(term))).length > 0
          : text.toLowerCase().includes(unquoteSearchValue(term).toLowerCase());
      const body = mailColumns(mail.message).some((text) => textMatch(text, readiness.messages));
      const derived = mail.chunks.some((text) => textMatch(text, readiness.derived));
      return attachmentOnly ? derived : media ? body || derived : body;
    }
    default: {
      const exhaustive: never = node;
      return exhaustive;
    }
  }
};

const referenceHeads = (
  raw: ThreadQuery,
  fixture: readonly FixtureMail[],
  readiness: Readiness,
) => {
  const q = parseSearchQuery(raw);
  const mailbox =
    q.search !== undefined && q.searchScope !== "folder" ? "all" : (q.mailbox ?? "inbox");
  const expression = parseSearchExpression(q.search ?? "");
  const media =
    hasSearchExpression(q.search ?? "") ||
    searchWords(q.search ?? "").some((term) => term.startsWith("-"));
  const matches = fixture.filter((mail) => {
    const m = mail.message;
    if (
      (q.accountIds && !q.accountIds.includes(mail.accountId)) ||
      (q.messageIds && !q.messageIds.includes(mail.id))
    )
      return false;
    if (mailbox === "all") {
      if (
        !q.messageIds &&
        !searchIncludesSpecialFolders(q) &&
        m.labels.some((label) => label === "SPAM" || label === "TRASH")
      )
        return false;
    } else if (!m.labels.includes(MAILBOX_LABEL[mailbox])) return false;
    if (
      q.label &&
      (q.search === undefined || q.searchScope === "folder") &&
      !m.labels.includes(q.label)
    )
      return false;
    if ((q.unreadOnly && !m.isUnread) || (q.starredOnly && !m.isStarred)) return false;
    const filters = q.listFilters;
    if (filters?.enabled) {
      if (filters.inInbox && !m.labels.includes("INBOX")) return false;
      if (
        (filters.unread || filters.starred || filters.important) &&
        !(
          (filters.unread && m.isUnread) ||
          (filters.starred && m.isStarred) ||
          (filters.important && m.labels.includes("IMPORTANT"))
        )
      )
        return false;
    }
    if (!referenceCondition(mail, q.criteria ?? {}, readiness.messages)) return false;
    if (
      q.criteria?.excluded?.some((condition) =>
        referenceCondition(mail, condition, readiness.messages),
      )
    )
      return false;
    return referenceExpression(
      expression,
      mail,
      readiness,
      media,
      q.criteria?.attachmentText ?? false,
    );
  });
  const heads = new Map<string, ReturnType<typeof head>>();
  for (const mail of matches) {
    const key = q.flat ? mail.id : `${mail.accountId}/${mail.message.threadId}`;
    const previous = heads.get(key);
    const newer =
      !previous ||
      mail.message.date > previous.date ||
      (mail.message.date === previous.date && binaryCompare(mail.id, previous.id) > 0);
    heads.set(key, {
      id: newer ? mail.id : previous.id,
      date: newer ? mail.message.date : previous.date,
      unread: Number(mail.message.isUnread || !!previous?.unread),
      starred: Number(mail.message.isStarred || !!previous?.starred),
      count: q.flat
        ? 1
        : fixture.filter(
            (row) =>
              row.accountId === mail.accountId && row.message.threadId === mail.message.threadId,
          ).length,
    });
  }
  return [...heads.values()]
    .filter(
      (row) =>
        q.before === undefined ||
        row.date < q.before ||
        (row.date === q.before &&
          q.beforeId !== undefined &&
          binaryCompare(row.id, q.beforeId) < 0),
    )
    .toSorted((a, b) => b.date - a.date || binaryCompare(b.id, a.id))
    .slice(0, q.limit ?? 50);
};

for (const fixtureSeed of [90, 900, 9000]) {
  it.effect(
    `nonzero AROUND pages agree with the text reference on randomized mailbox ${fixtureSeed}`,
    () =>
      Effect.gen(function* () {
        const store = yield* Store;
        const sql = yield* SqlClient.SqlClient;
        const accounts = [
          yield* store.upsertAccount("gmail", "around-one@example.com"),
          yield* store.upsertAccount("gmail", "around-two@example.com"),
        ];
        let seed = fixtureSeed;
        const random = (max: number) => {
          seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
          return seed % max;
        };
        const pick = <A>(values: readonly [A, ...A[]]): A =>
          values[random(values.length)] ?? values[0];
        const texts = [
          "alpha beta",
          "beta alpha",
          "alpha one beta",
          "beta one two alpha",
          "alpha one two three four beta",
          "alpha alpha",
          "red fox near blue bird",
          "blue bird near red fox",
          "red fox blue bird",
          "red fox fox blue",
          "RÉD, fox near blue-bird",
          "nothing",
          "alpha",
          "beta",
        ] as const;
        const ids: string[] = [];
        const fixture: FixtureMail[] = [];
        for (let i = 0; i < 144; i++) {
          const account = accounts[i % 2];
          assert.ok(account);
          const providerId = `${i % 7 === 0 ? "\ue000" : i % 11 === 0 ? "😀" : "m"}${i.toString().padStart(3, "0")}`;
          const id = `${account.id}/${providerId}`;
          ids.push(id);
          const message = incoming(providerId, {
            threadId: `t${random(24)}`,
            date: random(12),
            subject: pick(texts),
            from: { name: pick(texts), address: "sender@example.com" },
            bodyText: pick(texts),
            bodyHtml: "",
            labels: [i % 13 === 0 ? "SPAM" : i % 17 === 0 ? "TRASH" : "INBOX"],
            isUnread: random(2) === 1,
            isStarred: random(2) === 1,
            attachments: [],
          });
          yield* store.upsertMessage(account.id, message);
          const chunks: string[] = [];
          fixture.push({ id, accountId: account.id, message, chunks });
          if (i % 3 === 0) {
            // Different phrases in separate chunks must never combine.
            for (const text of [pick(texts), "red fox", "blue bird"]) {
              chunks.push(text);
              yield* sql`INSERT INTO derived_chunks(message_id,text,provenance_json) VALUES(${id},${text},${JSON.stringify({ messageId: id, text, source: { kind: "body", name: "Body", start: 0, end: text.length }, page: null, region: null, pipelineVersion: "test", visionRevision: null })})`;
            }
          }
        }
        while (!(yield* store.backfillWordIndex(500)).ready) {
          /* complete both indexes */
        }
        const subsetIds = ids.filter((_, i) => i % 4 === 0);
        const searches = [
          "alpha AROUND 3 beta",
          '"alpha AROUND 3 beta"',
          '"alpha AROUND 003 beta"',
          '"red fox" AROUND 2 "blue bird"',
          '"red fox AROUND 2 blue bird"',
          '"red fox" AROUND 1 "fox blue"',
          "alpha AROUND 1 alpha",
          "(alpha AROUND 3 beta) OR nothing",
          "(alpha AROUND 3 beta) AND is:unread",
          "-(alpha AROUND 3 beta)",
          "-((alpha AROUND 3 beta) OR nothing)",
          "(alpha AROUND 3 beta) OR -(red AROUND 2 bird)",
          'in:attachment "red fox" AROUND 2 "blue bird"',
        ];
        for (const [messagesReady, derivedReady] of [
          [0, 0],
          [1, 0],
          [0, 1],
          [1, 1],
        ]) {
          yield* sql`UPDATE search_word_index SET ready=${messagesReady} WHERE kind='messages'`;
          yield* sql`UPDATE search_word_index SET ready=${derivedReady} WHERE kind='derived'`;
          const readiness = { messages: messagesReady === 1, derived: derivedReady === 1 };
          const changes = yield* sql`SELECT total_changes() AS n`;
          for (const [index, search] of searches.entries()) {
            const query: ThreadQuery = {
              search,
              limit: 3 + (index % 3),
              ...(index % 3 === 0 ? { accountIds: [accounts[0]?.id ?? ""] } : {}),
              ...(index % 4 === 0 ? { searchScope: "folder", mailbox: "inbox" } : {}),
              ...(index % 5 === 0
                ? {
                    listFilters: {
                      enabled: true,
                      unread: false,
                      starred: true,
                      important: false,
                      inInbox: false,
                    },
                  }
                : {}),
            };
            let cursor: Pick<ThreadQuery, "before" | "beforeId"> = {};
            for (let page = 0; page < 3; page++) {
              const expected = referenceHeads({ ...query, ...cursor }, fixture, readiness);
              const actual = yield* store.listThreads({ ...query, ...cursor });
              assert.deepStrictEqual(
                actual.map(head),
                expected,
                `${messagesReady}/${derivedReady}: ${search}, page ${page}`,
              );
              const tail = expected.at(-1);
              if (!tail) break;
              cursor = { before: tail.date, beforeId: tail.id };
            }
            const flat = { ...query, flat: true, messageIds: subsetIds };
            assert.deepStrictEqual(
              (yield* store.listThreads(flat)).map(head),
              referenceHeads(flat, fixture, readiness),
              search,
            );
            const subset = { ...query, messageIds: subsetIds };
            assert.deepStrictEqual(
              (yield* store.listThreads(subset)).map(head),
              referenceHeads(subset, fixture, readiness),
              search,
            );
          }
          const excluded: ThreadQuery = {
            search: "nothing OR alpha OR beta OR red",
            criteria: {
              excluded: [
                { proximity: { left: "alpha", right: "beta", distance: 3, ordered: true } },
              ],
            },
            limit: 5,
          };

          assert.deepStrictEqual(
            (yield* store.listThreads(excluded)).map(head),
            referenceHeads(excluded, fixture, readiness),
          );
          assert.deepStrictEqual(
            yield* sql`SELECT total_changes() AS n`,
            changes,
            "search must not write during indexing",
          );
        }
      }).pipe(Effect.provide(StoreLive.pipe(Layer.provideMerge(MemoryPlatform())))),
    { timeout: 120_000 },
  );
}

it.effect(
  "dense NEAR with sparse exact matches caps candidate windows",
  () => {
    let windows = 0;
    const trace = traceQueries((query, phase) => () => {
      if (
        phase === "execute" &&
        !query.includes("positions AS") &&
        (query.includes("WITH candidates AS NOT MATERIALIZED") ||
          (query.startsWith("SELECT m.id") &&
            query.includes("messages m INDEXED BY messages_list_date_id")))
      )
        windows++;
    });
    return Effect.gen(function* () {
      const store = yield* Store;
      const account = yield* store.upsertAccount("gmail", "sparse@example.com");
      yield* store.transaction(
        Effect.gen(function* () {
          for (let i = 0; i < 5000; i++) {
            yield* store.upsertMessage(
              account.id,
              incoming(`m${i}`, {
                threadId: `t${i}`,
                date: i,
                subject: "Mail",
                bodyText: i < 3 ? "alpha one beta" : "beta one alpha",
                bodyHtml: "",
                from: { name: "Sender", address: "sender@example.com" },
                labels: ["INBOX"],
                attachments: [],
              }),
            );
          }
        }),
      );
      while (!(yield* store.backfillWordIndex(500)).ready) {
        /* finish indexes */
      }
      for (const flat of [false, true]) {
        for (const search of ['"alpha AROUND 2 beta"', '-("beta AROUND 2 alpha")']) {
          windows = 0;
          trace.start();
          const rows = yield* store.listThreads({ search, flat, limit: 50 });
          const queries = trace.stop();
          assert.deepStrictEqual(
            rows.map((row) => row.id),
            [2, 1, 0].map((i) => `${account.id}/m${i}`),
          );
          assert.isAtMost(
            windows,
            1,
            "candidate scans must fall back after the first empty window",
          );
          assert.ok(
            queries.some((query) => query.sql.includes("positions AS")),
            "exact positions must still be checked",
          );
        }
        windows = 0;
        const deep = yield* store.listThreads({
          search: '"beta AROUND 2 alpha"',
          flat,
          before: 3000,
          limit: 50,
        });
        assert.deepStrictEqual(
          deep.map((row) => row.id),
          Array.from({ length: 50 }, (_, i) => `${account.id}/m${2999 - i}`),
        );
        assert.isAtMost(windows, 1, "cursor replay must share the candidate budget");
      }
    }).pipe(
      Effect.provide(StoreLive.pipe(Layer.provideMerge(MemoryPlatform()))),
      Effect.ensuring(Effect.sync(trace.restore)),
    );
  },
  { timeout: 120_000 },
);
