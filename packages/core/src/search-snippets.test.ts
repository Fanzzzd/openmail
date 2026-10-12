import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/sql";
import { searchHighlightTerms, searchSnippet } from "./search-snippets.js";
import type { IncomingMessage, SearchMatch } from "./domain.js";
import { Store } from "./services.js";
import { StoreLive } from "./store.js";
import { MemoryPlatform } from "./platform/node/platform-memory.js";

it("highlights Unicode, prefixes, phrases and positive boolean terms as plain text", () => {
  assert.deepStrictEqual(
    searchHighlightTerms({ search: "from:alice (amount OR subject:invoice) -secret" }),
    ["amount", "invoice"],
  );
  assert.deepStrictEqual(searchHighlightTerms({ search: "subject:..." }), []);
  const hit = searchSnippet("<script>alert(1)</script> Café total amount due", [
    "cafe",
    '"total amount"',
    "du*",
  ]);
  assert.deepStrictEqual(
    hit.highlights.map(({ start, end }) => hit.snippet.slice(start, end)),
    ["Café", "total amount", "due"],
  );
  const long = searchSnippet(`${"prefix ".repeat(90)}预算批准 ${"tail ".repeat(100)}`, ["预算"]);
  assert.isBelow(long.snippet.length, 245);
  assert.strictEqual(
    long.snippet.slice(long.highlights[0]?.start, long.highlights[0]?.end),
    "预算",
  );
});

const fixture = (id: string, bodyText: string, date: number): IncomingMessage => ({
  providerId: id,
  threadId: id,
  subject: "Receipt",
  from: { name: "Alice", address: "a@example.com" },
  to: [],
  cc: [],
  date,
  snippet: "unsafe provider preview",
  bodyText,
  bodyHtml: "",
  labels: ["INBOX"],
  isUnread: false,
  isStarred: false,
  attachments: [{ filename: "invoice.pdf", mimeType: "application/pdf", size: 10 }],
});

it.effect(
  "BM25 and weighted fusion rank mail above OCR, allow exact phrases, and retain safe provenance",
  () =>
    Effect.gen(function* () {
      const store = yield* Store;
      const account = yield* store.upsertAccount("gmail", "ranking@example.com");
      for (const message of [
        fixture("body", "total other words amount", 1),
        { ...fixture("subject", "", 2), subject: "total details amount" },
        fixture("ocr", "unrelated", 3000),
        fixture("phrase", "unrelated", 4000),
        fixture("ocr-strong", "unrelated", 3500),
        {
          ...fixture("hidden", "secret amount", 5000),
          bodyHtml: "<p>Visible text</p><span hidden>secret amount</span>",
        },
      ])
        yield* store.upsertMessage(account.id, message);
      for (let i = 0; i < 6; i++) {
        const job = yield* store.media.claim("test", i, true);
        if (Option.isNone(job)) break;
        const text = job.value.message_id.endsWith("/ocr")
          ? "total widely separated amount"
          : job.value.message_id.endsWith("/ocr-strong")
            ? "total filler amount ".repeat(6)
            : job.value.message_id.endsWith("/phrase")
              ? "total amount"
              : job.value.message_id.endsWith("/hidden")
                ? "<span hidden>secret amount</span><p>visible</p>"
                : "unrelated";
        yield* store.media.complete(
          job.value,
          [
            {
              messageId: job.value.message_id,
              text,
              source: {
                kind: "attachment",
                index: 0,
                name: "invoice.pdf",
                mimeType: "application/pdf",
              },
              page: 1,
              region: null,
              pipelineVersion: "test",
              visionRevision: null,
            },
          ],
          null,
        );
      }
      while (!(yield* store.backfillWordIndex(500)).ready) {
        /* finish actual indexes */
      }
      const rows = yield* store.listThreads({ search: "total amount", flat: true });
      assert.deepStrictEqual(
        rows.map((row) => row.id.split("/").at(-1)),
        ["phrase", "subject", "body", "ocr-strong", "ocr"],
      );
      const hit = rows[0]?.searchMatches?.[0];
      assert.strictEqual(hit?.source, "attachment");
      if (hit?.source === "attachment") {
        assert.strictEqual(hit.attachmentName, "invoice.pdf");
        assert.strictEqual(hit.attachmentIndex, 0);
        assert.deepStrictEqual(
          hit.highlights.map(({ start, end }) => hit.snippet.slice(start, end)),
          ["total", "amount"],
        );
      }
      const boolean = yield* store.listThreads({ search: "(total OR amount) -absent", flat: true });
      assert.ok(
        boolean
          .find((row) => row.id.endsWith("/ocr"))
          ?.searchMatches?.some((match) => match.source === "attachment"),
      );
      const hidden = yield* store.listThreads({ search: "secret", flat: true });
      assert.ok(
        hidden.every(
          (row) => row.snippet === "" && !row.searchMatches?.length && !row.derivedMatches?.length,
        ),
      );
      assert.notInclude(JSON.stringify(hidden), "secret amount");
      const scoped = yield* store.listThreads({ search: "in:attachment total", flat: true });
      assert.ok(
        scoped.every((row) => row.searchMatches?.every((match) => match.source === "attachment")),
      );
      yield* store.upsertMessage(account.id, {
        ...fixture("older-ocr", "unrelated", 6000),
        threadId: "mixed",
        isUnread: true,
        isStarred: true,
      });
      yield* store.upsertMessage(account.id, {
        ...fixture("later-ocr", "unrelated", 6500),
        threadId: "mixed",
      });
      yield* store.upsertMessage(account.id, {
        ...fixture("newer-body", "total outstanding amount", 7000),
        threadId: "mixed",
        attachments: [],
      });
      for (let i = 0; i < 2; i++) {
        const conversationJob = yield* store.media.claim("test", 0, true);
        if (Option.isNone(conversationJob)) throw new Error("Missing conversation fixture job");
        yield* store.media.complete(
          conversationJob.value,
          [
            {
              messageId: conversationJob.value.message_id,
              text: "total widely separated amount",
              source: {
                kind: "attachment",
                index: 0,
                name: "invoice.pdf",
                mimeType: "application/pdf",
              },
              page: 1,
              region: null,
              pipelineVersion: "test",
              visionRevision: null,
            },
          ],
          null,
        );
      }
      const grouped = (yield* store.listThreads({ search: "total amount" })).find(
        (row) => row.threadId === "mixed",
      );
      assert.strictEqual(grouped?.isUnread, true);
      assert.strictEqual(grouped?.isStarred, true);
      assert.ok(
        grouped?.searchMatches?.some(
          (match) => match.source === "body" && match.messageId === `${account.id}/newer-body`,
        ),
      );
      assert.ok(
        grouped?.searchMatches?.some(
          (match) => match.source === "attachment" && match.messageId === `${account.id}/older-ocr`,
        ),
      );
      for (const id of ["unicode-\uE000", "unicode-😀"])
        yield* store.upsertMessage(account.id, {
          ...fixture(id, "unrelated", 10000),
          threadId: "unicode",
        });
      for (let i = 0; i < 2; i++) {
        const job = yield* store.media.claim("test", 0, true);
        if (Option.isNone(job)) throw new Error("Missing Unicode fixture job");
        yield* store.media.complete(
          job.value,
          [
            {
              messageId: job.value.message_id,
              text: "Receipt total details amount",
              source: {
                kind: "attachment",
                index: 0,
                name: "invoice.pdf",
                mimeType: "application/pdf",
              },
              page: 1,
              region: null,
              pipelineVersion: "test",
              visionRevision: null,
            },
          ],
          null,
        );
      }
      const tied = (yield* store.listThreads({ search: "total amount" })).find(
        (row) => row.threadId === "unicode",
      );
      assert.strictEqual(tied?.id, `${account.id}/unicode-😀`);
      const fullMail = yield* store.listThreads({ search: "total", limit: 2 });
      assert.strictEqual(fullMail.length, 2);
      assert.ok(
        fullMail.every((row) => row.searchMatches?.some((match) => match.source !== "attachment")),
      );
      const subjects = yield* store.listThreads({ search: "Receipt", limit: 2 });
      assert.strictEqual(subjects.length, 2);
      assert.ok(
        subjects.some((row) => row.searchMatches?.some((match) => match.source === "attachment")),
      );
      yield* store.upsertMessage(account.id, fixture("safe-secret", "unrelated", 11000));
      const secretJob = yield* store.media.claim("test", 0, true);
      if (Option.isNone(secretJob)) throw new Error("Missing visible OCR fixture job");
      yield* store.media.complete(
        secretJob.value,
        [
          {
            messageId: secretJob.value.message_id,
            text: "secret token",
            source: {
              kind: "attachment",
              index: 0,
              name: "invoice.pdf",
              mimeType: "application/pdf",
            },
            page: 1,
            region: null,
            pipelineVersion: "test",
            visionRevision: null,
          },
        ],
        null,
      );
      const safeSecret = yield* store.listThreads({ search: "secret", limit: 1 });
      assert.strictEqual(safeSecret[0]?.id, `${account.id}/safe-secret`);
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE search_word_index SET ready=0`;
      const fallback = yield* store.listThreads({ search: "tal", flat: true });
      assert.ok(
        fallback.some((row) =>
          row.searchMatches?.some(
            (match) =>
              match.source === "attachment" &&
              match.highlights.some(({ start, end }) => match.snippet.slice(start, end) === "tal"),
          ),
        ),
      );
    }).pipe(Effect.provide(StoreLive.pipe(Layer.provideMerge(MemoryPlatform())))),
);

it("snippet windows keep complete code points at both edges", () => {
  const start = searchSnippet(`${"x".repeat(10)}😀${"x".repeat(58)} amount`, ["amount"]);
  const end = searchSnippet(`amount ${"x".repeat(232)}😀 tail`, ["amount"]);
  for (const snippet of [start, end]) {
    assert.strictEqual(
      new TextDecoder().decode(new TextEncoder().encode(snippet.snippet)),
      snippet.snippet,
    );
    assert.strictEqual(
      snippet.snippet.slice(snippet.highlights[0]?.start, snippet.highlights[0]?.end),
      "amount",
    );
  }
  assert.include(start.snippet, "😀");
  assert.include(end.snippet, "😀");
});

it.effect(
  "exact phrases in each mail field outrank exact OCR phrases for words and quoted queries",
  () =>
    Effect.gen(function* () {
      const store = yield* Store;
      const account = yield* store.upsertAccount("gmail", "exact@example.com");
      for (const message of [
        {
          ...fixture("exact-subject", "", 1),
          subject: "total amount report",
          bodyHtml: "<p>Visible preview for the report.</p><span hidden>hidden preview</span>",
          bodyText: "conflicting hidden preview",
        },
        {
          ...fixture("exact-body", "Payment: total amount due.", 2),
          bodyHtml: "<p>Payment: total amount due.</p>",
        },
        { ...fixture("split-fields", "amount", 3), subject: "total" },
        {
          ...fixture("hidden-phrase", "total amount", 4),
          bodyHtml: "<p>total scattered amount</p><span hidden>total amount</span>",
        },
        fixture("ocr-exact", "unrelated", 5000),
      ])
        yield* store.upsertMessage(account.id, message);
      for (let i = 0; i < 5; i++) {
        const job = yield* store.media.claim("test", 0, true);
        if (Option.isNone(job)) throw new Error("Missing phrase fixture job");
        const text = job.value.message_id.endsWith("/ocr-exact") ? "total amount" : "unrelated";
        yield* store.media.complete(
          job.value,
          [
            {
              messageId: job.value.message_id,
              text,
              source: {
                kind: "attachment",
                index: 0,
                name: "invoice.pdf",
                mimeType: "application/pdf",
              },
              page: 1,
              region: null,
              pipelineVersion: "test",
              visionRevision: null,
            },
          ],
          null,
        );
      }
      while (!(yield* store.backfillWordIndex(500)).ready) {
        /* finish actual indexes */
      }
      for (const search of ["total amount", '"total amount"']) {
        const rows = yield* store.listThreads({ search, flat: true });
        const ids = rows.map((row) => row.id);
        const ocrRank = ids.indexOf(`${account.id}/ocr-exact`);
        assert.ok(ocrRank >= 0);
        for (const id of ["exact-subject", "exact-body"])
          assert.ok(
            ids.indexOf(`${account.id}/${id}`) >= 0 && ids.indexOf(`${account.id}/${id}`) < ocrRank,
            `${search}: ${id}`,
          );
        if (search === "total amount")
          assert.ok(ids.indexOf(`${account.id}/split-fields`) > ocrRank);
        assert.ok(ids.indexOf(`${account.id}/hidden-phrase`) > ocrRank);
        const subject = rows.find((row) => row.id.endsWith("/exact-subject"));
        assert.strictEqual(subject?.snippet, "Visible preview for the report.");
        assert.notInclude(JSON.stringify(subject), "hidden preview");
      }
    }).pipe(Effect.provide(StoreLive.pipe(Layer.provideMerge(MemoryPlatform())))),
);

it.effect("results say whether the sender or an attachment file name matched", () =>
  Effect.gen(function* () {
    const store = yield* Store;
    const account = yield* store.upsertAccount("gmail", "fields@example.com");
    yield* store.upsertMessage(account.id, {
      ...fixture("sender", "Lunch plans", 1),
      from: { name: "Zebulon Quayle", address: "zq@example.com" },
      snippet: "Lunch plans",
    });
    yield* store.upsertMessage(account.id, {
      ...fixture("named", "Quarterly numbers attached", 2),
      attachments: [
        { filename: "notes.txt", mimeType: "text/plain", size: 1 },
        { filename: "quarterly-report.pdf", mimeType: "application/pdf", size: 1 },
      ],
    });
    const [sender] = yield* store.listThreads({ search: "zebulon" });
    assert.deepStrictEqual(
      sender?.searchMatches?.map((match) => [
        match.source,
        match.snippet.slice(match.highlights[0]?.start, match.highlights[0]?.end),
      ]),
      [["sender", "Zebulon"]],
    );
    assert.strictEqual(sender?.snippet, "Lunch plans");
    const [named] = yield* store.listThreads({ search: "quarterly" });
    const filename = named?.searchMatches?.find(
      (match): match is Extract<SearchMatch, { source: "filename" }> => match.source === "filename",
    );
    assert.deepStrictEqual(
      filename && {
        name: filename.attachmentName,
        index: filename.attachmentIndex,
        hit: filename.snippet.slice(filename.highlights[0]?.start, filename.highlights[0]?.end),
      },
      { name: "quarterly-report.pdf", index: 1, hit: "quarterly" },
    );
    assert.ok(named?.searchMatches?.some((match) => match.source === "body"));
  }).pipe(Effect.provide(StoreLive.pipe(Layer.provideMerge(MemoryPlatform())))),
);

it.effect("from: lights up the sender without marking any message text", () =>
  Effect.gen(function* () {
    const store = yield* Store;
    const account = yield* store.upsertAccount("gmail", "from@example.com");
    yield* store.upsertMessage(account.id, {
      ...fixture("from", "Dinner on Friday", 1),
      from: { name: "Alice Smith", address: "alice@example.com" },
      snippet: "Dinner on Friday",
    });
    const [row] = yield* store.listThreads({ search: "from:alice" });
    assert.deepStrictEqual(
      row?.searchMatches?.map((match) => [
        match.source,
        match.highlights.map(({ start, end }) => match.snippet.slice(start, end)),
      ]),
      [["sender", ["Alice", "alice"]]],
    );
    assert.strictEqual(row?.snippet, "Dinner on Friday");
  }).pipe(Effect.provide(StoreLive.pipe(Layer.provideMerge(MemoryPlatform())))),
);
