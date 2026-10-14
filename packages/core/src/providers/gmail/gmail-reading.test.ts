import { fakeHttp } from "../../platform/node/fake-http.js";
import { MailCodec } from "../../platform/mail-codec.js";
import { nodeMailCodec } from "../../platform/node/mail-codec.js";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option, Stream } from "effect";
import { makeGmail } from "./gmail.js";
import { parseGmailMessage } from "./parse.js";
import {
  account,
  platform,
  run,
  b64,
  message,
  labels,
} from "../../../test-support/gmail-fixtures.js";
it.effect("raw messages come back as bytes", () =>
  Effect.gen(function* () {
    const http = fakeHttp({
      "GET /messages/m1": (url) => {
        assert.strictEqual(url.searchParams.get("format"), "raw");
        return { json: { raw: b64("Subject: hi\r\n\r\nbody") } };
      },
    });
    const raw = yield* run(http, (a) => a.fetchRaw(account, "m1"));
    assert.strictEqual(Buffer.from(raw).toString(), "Subject: hi\r\n\r\nbody");
  }),
);

it.effect(
  "attachments come inline or through the attachments endpoint, by name and occurrence",
  () =>
    Effect.gen(function* () {
      const part = (filename: string, body: Record<string, unknown>) => ({
        mimeType: "application/pdf",
        filename,
        body,
      });
      const http = fakeHttp({
        "GET /messages/m1": (url) => {
          assert.strictEqual(url.searchParams.get("format"), "full");
          return {
            json: {
              ...message("m1", ["INBOX"]),
              payload: {
                mimeType: "multipart/mixed",
                body: { size: 0 },
                parts: [
                  { mimeType: "text/plain", body: { size: 2, data: b64("hi") } },
                  part("a.pdf", { size: 3, data: b64("one") }),
                  part("a.pdf", { size: 9, attachmentId: "ATT2" }),
                ],
              },
            },
          };
        },
        "GET /messages/m1/attachments/ATT2": { json: { size: 3, data: b64("two") } },
      });
      const [first, second] = yield* run(http, (a) =>
        Effect.all([
          a.fetchAttachment(account, "m1", { index: 0, filename: "a.pdf", occurrence: 0 }),
          a.fetchAttachment(account, "m1", { index: 1, filename: "a.pdf", occurrence: 1 }),
        ]),
      );
      assert.strictEqual(Buffer.from(first).toString(), "one");
      assert.strictEqual(Buffer.from(second).toString(), "two");
    }),
);

it.effect("server search sends q and folder scope, fetches uncached messages across pages", () =>
  Effect.gen(function* () {
    const http = fakeHttp({
      "GET /labels": { json: labels },
      "GET /messages": (url) => {
        assert.strictEqual(url.searchParams.get("q"), 'from:ann filename:pdf label:"Clients"');
        return {
          json: url.searchParams.get("pageToken")
            ? { messages: [{ id: "m2" }] }
            : { messages: [{ id: "m1" }], nextPageToken: "next" },
        };
      },
      "GET /messages/m1": { json: message("m1", ["Label_1"]) },
      "GET /messages/m2": { json: message("m2", ["Label_1"]) },
    });
    const page = yield* run(http, (a) =>
      a.search(account, {
        search: "from:ann filename:pdf",
        searchScope: "folder",
        label: "Label_1",
      }),
    );
    assert.strictEqual(page.messages.length, 2);
    assert.strictEqual(page.truncated, false);
  }),
);

it.effect("Gmail explicit spam search includes messages normally excluded from all mail", () => {
  const http = fakeHttp({
    "GET /labels": { json: labels },
    "GET /messages": (url) => {
      assert.strictEqual(url.searchParams.get("q"), "in:spam from:ann");
      assert.strictEqual(url.searchParams.get("includeSpamTrash"), "true");
      return { json: { messages: [{ id: "spam" }] } };
    },
    "GET /messages/spam": { json: message("spam", ["SPAM"]) },
  });
  return run(http, (a) => a.search(account, { search: "in:spam from:ann" })).pipe(
    Effect.tap((page) =>
      Effect.sync(() => assert.strictEqual(page.messages[0]?.labels[0], "SPAM")),
    ),
  );
});

it.effect("media raw size is checked before downloading Gmail MIME", () =>
  Effect.gen(function* () {
    let rawCalls = 0;
    const http = fakeHttp({
      "GET /messages/m1": (url) => {
        if (url.searchParams.get("format") === "minimal")
          return { json: { sizeEstimate: 20_000_000 } };
        rawCalls++;
        return { json: { raw: b64("body") } };
      },
    });
    const result = yield* run(http, (adapter) =>
      adapter.fetchRaw(account, "m1", 8 * 1024 * 1024),
    ).pipe(Effect.result);
    assert.strictEqual(result._tag, "Failure");
    assert.strictEqual(rawCalls, 0);
  }),
);

it.effect("Gmail fetch parses a folded, encoded, multi-address Reply-To header", () =>
  Effect.gen(function* () {
    const raw = message("reply", ["INBOX"]);
    raw.payload.headers.push({
      name: "rEpLy-To",
      value: '=?UTF-8?B?UmVwbHksIFRlYW0=?= <reply@example.com>,\r\n "Doe, Jane" <jane@example.com>',
    });
    const http = fakeHttp({ "GET /messages/reply": { json: raw } });
    const parsed = yield* run(http, (adapter) => adapter.fetchMessage(account, "reply"));
    assert.deepStrictEqual(parsed.replyTo, [
      { name: "Reply, Team", address: "reply@example.com" },
      { name: "Doe, Jane", address: "jane@example.com" },
    ]);
    assert.deepStrictEqual(parseGmailMessage(message("no-reply-to", [])).replyTo, []);
    assert.deepStrictEqual(
      parseGmailMessage({
        ...raw,
        payload: { ...raw.payload, headers: [{ name: "Reply-To", value: "" }] },
      }).replyTo,
      [],
    );
  }),
);

it.effect(
  "Gmail attachment type tokens constrain the server page before fetching older mail",
  () => {
    const older = message("older-pdf", ["INBOX"]);
    const http = fakeHttp({
      "GET /labels": { json: labels },
      "GET /messages": (url) => {
        assert.strictEqual(url.searchParams.get("q"), "has:attachment {filename:pdf}");
        assert.strictEqual(url.searchParams.get("maxResults"), "200");
        return { json: { messages: [{ id: "older-pdf" }] } };
      },
      "GET /messages/older-pdf": {
        json: {
          ...older,
          payload: {
            ...older.payload,
            mimeType: "multipart/mixed",
            parts: [
              older.payload,
              {
                mimeType: "application/pdf",
                filename: "older.pdf",
                body: { size: 12, attachmentId: "pdf" },
              },
            ],
          },
        },
      },
    });
    return run(http, (adapter) => adapter.search(account, { search: "has:pdf" })).pipe(
      Effect.map((page) =>
        assert.deepStrictEqual(
          page.messages.map((item) => item.providerId),
          ["older-pdf"],
        ),
      ),
    );
  },
);

it.effect("Gmail JSON signed containers use raw MIME for the body", () =>
  Effect.gen(function* () {
    const signedRaw =
      "Content-Type: application/pkcs7-mime; smime-type=signed-data; name=smime.p7m\r\nContent-Transfer-Encoding: base64\r\n\r\nMFEGCSqGSIb3DQEHAqBEMEICAQExADA7BgkqhkiG9w0BBwGgLgQsQ29udGVudC1UeXBlOiB0ZXh0L3BsYWluDQoNCnNpZ25lZCBKU09OIGJvZHk=";
    const http = fakeHttp({
      "GET /messages/signed": (url) =>
        url.searchParams.get("format") === "raw"
          ? { json: { raw: b64(signedRaw) } }
          : {
              json: {
                ...message("signed", ["INBOX"]),
                payload: {
                  mimeType: "application/pkcs7-mime",
                  filename: "smime.p7m",
                  body: { size: 100 },
                },
              },
            },
    });
    const m = yield* run(http, (a) => a.fetchMessage(account, "signed"));
    assert.strictEqual(m.bodyText.trim(), "signed JSON body");
    assert.deepStrictEqual(
      m.attachments.map((part) => part.filename),
      ["smime.p7m"],
    );
  }),
);

it.effect("Gmail JSON uuencode attachments are listed and fetched from raw MIME", () =>
  Effect.gen(function* () {
    const text = "hello\r\nbegin 644 file.txt\r\n#0V%T\r\n`\r\nend\r\n";
    const http = fakeHttp({
      "GET /messages/uu": (url) =>
        url.searchParams.get("format") === "raw"
          ? { json: { raw: b64(`Content-Type: text/plain\r\n\r\n${text}`) } }
          : {
              json: {
                ...message("uu", ["INBOX"]),
                payload: { mimeType: "text/plain", body: { size: text.length, data: b64(text) } },
              },
            },
    });
    yield* run(http, (a) =>
      Effect.gen(function* () {
        const m = yield* a.fetchMessage(account, "uu");
        assert.strictEqual(m.attachments[0]?.filename, "file.txt");
        assert.strictEqual(
          Buffer.from(
            yield* a.fetchAttachment(account, "uu", {
              index: 0,
              filename: "file.txt",
              occurrence: 0,
            }),
          ).toString(),
          "Cat",
        );
      }),
    );
  }),
);

it.effect("MIME parse failures preserve opaque mail and advance history", () =>
  Effect.gen(function* () {
    const http = fakeHttp({
      "GET /labels": { json: { labels: [] } },
      "GET /profile": { json: { emailAddress: account.email, historyId: "safe-cursor" } },
      "GET /messages": { json: { messages: [{ id: "opaque" }] } },
      "GET /messages/opaque": (url) =>
        url.searchParams.get("format") === "raw"
          ? { json: { raw: b64("malformed MIME") } }
          : {
              json: {
                ...message("opaque", ["INBOX"]),
                payload: {
                  mimeType: "application/pkcs7-mime",
                  filename: "smime.p7m",
                  body: { size: 100 },
                },
              },
            },
    });
    const broken = {
      ...nodeMailCodec,
      parse: async () => {
        throw new Error("malformed MIME");
      },
    };
    const changes = yield* makeGmail.pipe(
      Effect.provideService(MailCodec, broken),
      Effect.flatMap((a) => Stream.runCollect(a.pull(account, Option.none()))),
      Effect.provide(Layer.mergeAll(http.layer, platform)),
    );
    const upsert = changes.find((change) => change._tag === "Upsert");
    assert.ok(upsert?._tag === "Upsert");
    assert.strictEqual(upsert.message.attachments[0]?.filename, "smime.p7m");
    assert.deepStrictEqual(changes.at(-1), { _tag: "Cursor", cursor: "safe-cursor" });
  }),
);

it.effect("signed attachments do not trigger Gmail body replacement", () =>
  Effect.gen(function* () {
    const http = fakeHttp({
      "GET /messages/invoice": (url) => {
        assert.strictEqual(url.searchParams.get("format"), "full");
        return {
          json: {
            ...message("invoice", ["INBOX"]),
            payload: {
              mimeType: "multipart/mixed",
              body: { size: 0 },
              parts: [
                { mimeType: "text/plain", body: { size: 16, data: b64("Invoice enclosed") } },
                {
                  mimeType: "application/pkcs7-mime",
                  filename: "invoice.pdf.p7m",
                  body: { size: 100 },
                },
              ],
            },
          },
        };
      },
    });
    const m = yield* run(http, (a) => a.fetchMessage(account, "invoice"));
    assert.strictEqual(m.bodyText, "Invoice enclosed");
    assert.strictEqual(m.attachments[0]?.filename, "invoice.pdf.p7m");
    assert.strictEqual(http.calls.length, 1);
  }),
);
