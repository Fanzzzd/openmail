import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

import { buildMime } from "./platform/node/compose.js";
import type { OutgoingMessage } from "./domain.js";
import { originalAttachment, parseRawDraft } from "./platform/node/portable-helpers.js";
import { renderMarkdown } from "./markdown.js";
import { preservedComposeHtml } from "./compose-body.js";
import { simpleParser } from "mailparser";

const message: OutgoingMessage = {
  to: [{ name: "王工", address: "wang@contoso.com" }],
  cc: [{ name: "", address: "cc@x.com" }],
  bcc: [{ name: "", address: "hidden@x.com" }],
  subject: "报价确认",
  text: "收到",
  attachments: [{ filename: "a.txt", mimeType: "text/plain", content: "aGk=" }],
};

const threading = { messageId: "<orig@x.com>", references: "<root@x.com>" };
const from = { name: "", address: "me@gmail.com" };

const build = (m: OutgoingMessage) =>
  Effect.map(buildMime(from, m, threading), (b) => b.toString());

describe("buildMime", () => {
  it.effect("replies carry In-Reply-To and the extended References", () =>
    Effect.gen(function* () {
      const raw = yield* build({ ...message, mode: "replyAll" });
      assert.match(raw, /^In-Reply-To: <orig@x\.com>/m);
      assert.match(raw, /^References: <root@x\.com> <orig@x\.com>/m);
    }),
  );

  it.effect("forwards and new messages start a thread of their own", () =>
    Effect.gen(function* () {
      for (const mode of ["forward", "new"] as const) {
        const raw = yield* build({ ...message, mode });
        assert.notMatch(raw, /^In-Reply-To:/m);
        assert.notMatch(raw, /^References:/m);
      }
    }),
  );

  it.effect("keeps Bcc, encodes UTF-8 headers and attaches files", () =>
    Effect.gen(function* () {
      const raw = yield* build(message);
      assert.match(raw, /^Bcc: hidden@x\.com/m);
      assert.match(raw, /^Subject: =\?UTF-8\?/m);
      assert.match(raw, /filename=a\.txt/);
      assert.match(raw, /^aGk=/m);
    }),
  );
});

describe("forwarding as an attachment", () => {
  it.effect("attaches the original as a message/rfc822 file", () =>
    Effect.gen(function* () {
      const original = Buffer.from("From: a@x.com\r\nSubject: 报价\r\n\r\n正文\r\n");
      const eml = originalAttachment("报价: 第 3 版/终稿", original);
      assert.strictEqual(eml.filename, "报价 第 3 版 终稿.eml");
      const raw = yield* build({ ...message, attachments: [eml], mode: "new" });
      assert.match(raw, /^Content-Type: message\/rfc822/m);
      assert.match(raw, /^Content-Disposition: attachment/m);
      // message/rfc822 parts stay readable (8bit), so clients can open them.
      assert.match(raw, /^Subject: 报价$/m);
    }),
  );
});

/**
 * The original of a forward as attachment, as a provider hands it over: UTF-8
 * bytes, 8bit, with an encoded-word subject.
 */
const chineseOriginal = Buffer.from(
  [
    "From: =?UTF-8?B?5p2O6Zu3?= <li@x.com>",
    `Subject: =?UTF-8?B?${Buffer.from("原邮件：报价").toString("base64")}?=`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    "你好，这是原来的邮件。",
    "",
  ].join("\r\n"),
);

const parse = (raw: Buffer) => Effect.promise(() => simpleParser(raw));

describe("Chinese text survives the MIME round trip", () => {
  it.effect("subject, plain text, Markdown HTML and a forwarded .eml decode back", () =>
    Effect.gen(function* () {
      const text = "**粗体** 和 `code`";
      const raw = yield* buildMime(from, {
        ...message,
        subject: "粗体 和 code",
        text,
        html: renderMarkdown(text),
        attachments: [originalAttachment("原邮件：报价", chineseOriginal)],
        mode: "new",
      });
      const source = raw.toString("latin1");
      // Every non-ASCII header is an encoded-word; every text part names its charset.
      assert.match(source, /^Subject: =\?UTF-8\?[BQ]\?/m);
      assert.match(source, /^To: =\?UTF-8\?[BQ]\?/m);
      assert.match(source, /^Content-Type: text\/plain; charset=utf-8$/m);
      assert.match(source, /^Content-Type: text\/html; charset=utf-8$/m);

      const parsed = yield* parse(raw);
      assert.strictEqual(parsed.subject, "粗体 和 code");
      assert.strictEqual(parsed.text?.trim(), text);
      assert.include(parsed.html || "", "<strong>粗体</strong> 和");
      assert.include(parsed.html || "", 'content="text/html; charset=utf-8"');
      assert.deepStrictEqual(parsed.to && !Array.isArray(parsed.to) ? parsed.to.value : [], [
        { name: "王工", address: "wang@contoso.com" },
      ]);

      const [eml] = parsed.attachments;
      assert.strictEqual(eml?.contentType, "message/rfc822");
      assert.strictEqual(eml?.filename, "原邮件：报价.eml");
      // The attached original is the provider's bytes, unchanged.
      assert.isTrue(eml?.content.equals(chineseOriginal));
      const inner = yield* parse(eml.content);
      assert.strictEqual(inner.subject, "原邮件：报价");
      assert.strictEqual(inner.text?.trim(), "你好，这是原来的邮件。");
    }),
  );
});

describe("parseRawDraft", () => {
  it.effect(
    "retains inline image parts and Content-ID while rebuilding an untouched remote body",
    () =>
      Effect.gen(function* () {
        const html = '<p style="color:red">image <img src="cid:logo@example.com"></p>';
        const original = yield* buildMime(from, {
          ...message,
          html,
          attachments: [
            {
              filename: "logo.png",
              mimeType: "image/png",
              content: "aGk=",
              contentId: "logo@example.com",
            },
          ],
        });
        const imported = yield* parseRawDraft(original);
        assert.strictEqual(imported.attachments[0]?.contentId, "logo@example.com");
        assert.include(imported.originalHtml ?? "", "cid:logo@example.com");
        const rebuilt = yield* buildMime(from, {
          ...message,
          text: imported.text,
          html: preservedComposeHtml(imported.originalHtml ?? ""),
          attachments: imported.attachments,
        });
        const parsed = yield* Effect.promise(() => simpleParser(rebuilt, { skipImageLinks: true }));
        assert.strictEqual(parsed.attachments[0]?.contentId, "<logo@example.com>");
        assert.strictEqual(parsed.attachments[0]?.contentDisposition, "inline");
        assert.include(parsed.html || "", '<img src="cid:logo@example.com">');
        assert.strictEqual(parsed.attachments[0]?.content.toString(), "hi");
      }),
  );
  it.effect("reads recipients, Bcc, the body and attachment content back", () =>
    Effect.gen(function* () {
      const raw = yield* buildMime(from, { ...message, mode: "reply" }, threading);
      const parsed = yield* parseRawDraft(raw);
      assert.deepStrictEqual(parsed.to, [{ name: "王工", address: "wang@contoso.com" }]);
      assert.deepStrictEqual(parsed.bcc, [{ name: "", address: "hidden@x.com" }]);
      assert.strictEqual(parsed.subject, "报价确认");
      assert.strictEqual(parsed.text.trim(), "收到");
      assert.deepStrictEqual(parsed.attachments, [
        { filename: "a.txt", mimeType: "text/plain", content: "aGk=" },
      ]);
      assert.strictEqual(parsed.isReply, true);
    }),
  );
});
