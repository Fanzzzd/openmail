import { assert, it } from "@effect/vitest";
import { draftCreation } from "../../platform/node/draft-create-fixture.js";
import { fakeHttp } from "../../platform/node/fake-http.js";
import { Effect, Option, Schema } from "effect";
import { simpleParser } from "mailparser";
import type { OutgoingMessage } from "../../domain/changes.js";
import { markdownDraftSource } from "../../compose/markdown-draft.js";
import { renderMarkdown } from "../../compose/markdown.js";
import { MARKDOWN_DRAFT_PROPERTY } from "./graph-message.js";
import { parseGraphMessage } from "./parse.js";
import {
  importedMessage,
  parseRawDraft,
  withDraftMarkdownSource,
} from "../../platform/node/portable-helpers.js";
import { replyRecipients } from "../../compose/recipients.js";
import {
  account,
  run,
  raw,
  draftMessage,
  paths,
  chineseOriginal,
} from "../../../test-support/outlook-fixtures.js";
for (const includeOriginalAttachments of [true, false, undefined]) {
  it.effect(
    `Graph forward attachment choice ${includeOriginalAttachments} replaces inherited parts only when explicit`,
    () =>
      Effect.gen(function* () {
        const http = fakeHttp({
          "POST /me/messages/orig/createForward": { json: { id: "draft" } },
          "PATCH /me/messages/draft": { json: {} },
          "GET /me/messages/draft/attachments": {
            json: {
              value: [{ id: "copied" }, { id: "inline", isInline: true, contentId: "logo" }],
            },
          },
          "DELETE /me/messages/draft/attachments/copied": { status: 204 },
          "DELETE /me/messages/draft/attachments/inline": { status: 204 },
          "POST /me/messages/draft/attachments": { json: {} },
          "POST /me/messages/draft/send": { status: 202 },
        });
        const parts = includeOriginalAttachments
          ? [
              { filename: "original.txt", mimeType: "text/plain", content: "aGk=" },
              { filename: "logo.png", mimeType: "image/png", content: "aGk=", contentId: "logo" },
            ]
          : [];
        yield* run(http, (adapter) =>
          adapter.send(
            account,
            {
              to: [{ name: "Bob", address: "bob@example.com" }],
              cc: [],
              bcc: [],
              subject: "Forward",
              text: "Body",
              attachments: parts,
              mode: "forward",
              ...(includeOriginalAttachments === undefined ? {} : { includeOriginalAttachments }),
            },
            Option.some({ providerId: "orig", threadId: "thread" }),
          ),
        );
        const calls = http.calls.map(
          (call) => `${call.method} ${call.url.pathname.replace("/v1.0", "")}`,
        );
        assert.strictEqual(
          calls.filter((call) => call.startsWith("DELETE")).length,
          includeOriginalAttachments === undefined ? 0 : 2,
        );
        assert.strictEqual(
          calls.filter((call) => call === "POST /me/messages/draft/attachments").length,
          parts.length,
        );
        assert.strictEqual(calls.at(-1), "POST /me/messages/draft/send");
      }),
  );
}

it.effect(
  "default forward autosave uses createForward and never uploads inherited large attachments",
  () =>
    Effect.gen(function* () {
      const http = fakeHttp({
        "POST /me/messages/orig/createForward": { json: { id: "d1" } },
        "PATCH /me/messages/d1": { json: {} },
      });
      yield* run(http, (adapter) =>
        adapter.saveDraft(account, {
          creation: draftCreation(),
          remote: null,
          original: Option.some({ providerId: "orig", threadId: "thread" }),
          message: { ...draftMessage, mode: "forward", attachments: [] },
          replaceAttachments: true,
        }),
      );
      assert.deepStrictEqual(paths(http.calls), [
        "POST /me/messages/orig/createForward",
        "PATCH /me/messages/d1",
      ]);
    }),
);

it.effect(
  "changing uploaded parts of an inherited forward recreates its server copy and preserves originals",
  () =>
    Effect.gen(function* () {
      const http = fakeHttp({
        "POST /me/messages/orig/createForward": { json: { id: "fresh" } },
        "PATCH /me/messages/fresh": { json: {} },
        "GET /me/messages/old": {
          json: { categories: ["External"], flag: { flagStatus: "flagged" } },
        },
        "DELETE /me/messages/old": { status: 204 },
        "POST /me/messages/fresh/attachments": { json: {} },
        "POST /me/messages/fresh/send": { status: 202 },
      });
      const message = { ...draftMessage, mode: "forward" } satisfies OutgoingMessage;
      yield* run(http, (adapter) =>
        Effect.gen(function* () {
          yield* adapter.saveDraft(account, {
            creation: draftCreation(),
            remote: { draftId: "old", messageId: "old" },
            original: Option.some({ providerId: "orig", threadId: "thread" }),
            message,
            replaceAttachments: true,
          });
          yield* adapter.send(
            account,
            message,
            Option.some({ providerId: "orig", threadId: "thread" }),
          );
        }),
      );
      const fields = Schema.decodeUnknownSync(
        Schema.Struct({
          categories: Schema.Array(Schema.String),
          flag: Schema.Struct({ flagStatus: Schema.String }),
        }),
      )(http.calls.find((call) => call.method === "PATCH")?.body);
      assert.deepStrictEqual(fields.categories, ["External"]);
      assert.strictEqual(fields.flag.flagStatus, "flagged");
      assert.deepStrictEqual(paths(http.calls), [
        "GET /me/messages/old",
        "POST /me/messages/orig/createForward",
        "PATCH /me/messages/fresh",
        "POST /me/messages/fresh/attachments",
        "DELETE /me/messages/old",
        "POST /me/messages/orig/createForward",
        "PATCH /me/messages/fresh",
        "POST /me/messages/fresh/attachments",
        "POST /me/messages/fresh/send",
      ]);
    }),
);

it.effect(
  "drafts are messages in Drafts: created, patched, attachments replaced only when changed",
  () =>
    Effect.gen(function* () {
      const http = fakeHttp({
        "POST /me/messages": { status: 201, json: { id: "d1" } },
        "PATCH /me/messages/d1": { json: {} },
        "GET /me/messages/d1/attachments": {
          json: { value: [{ id: "a1" }, { id: "logo", isInline: true }] },
        },
        "DELETE /me/messages/d1/attachments/a1": { status: 204 },
        "POST /me/messages/d1/attachments": { status: 201, json: {} },
        "PATCH /me/messages/gone": { status: 404, json: { error: { code: "ErrorItemNotFound" } } },
      });
      const push = (remote: { draftId: string; messageId: string } | null, replace: boolean) => ({
        creation: draftCreation(),
        remote,
        message: draftMessage,
        original: Option.none(),
        replaceAttachments: replace,
      });
      const ids = yield* run(http, (a) =>
        Effect.all([
          a.saveDraft(account, push(null, true)),
          a.saveDraft(account, push({ draftId: "d1", messageId: "d1" }, false)),
          a.saveDraft(account, push({ draftId: "d1", messageId: "d1" }, true)),
          // Deleted in Outlook meanwhile: created again.
          a.saveDraft(account, push({ draftId: "gone", messageId: "gone" }, false)),
        ]),
      );
      assert.deepStrictEqual(
        ids.map((r) => r.messageId),
        ["d1", "d1", "d1", "d1"],
      );
      assert.deepStrictEqual(paths(http.calls), [
        "POST /me/messages",
        "PATCH /me/messages/d1",
        "PATCH /me/messages/d1",
        "GET /me/messages/d1/attachments",
        "DELETE /me/messages/d1/attachments/a1",
        "POST /me/messages/d1/attachments",
        "PATCH /me/messages/gone",
        "POST /me/messages",
      ]);
      const created = Schema.decodeUnknownSync(
        Schema.Struct({
          subject: Schema.String,
          bccRecipients: Schema.Array(Schema.Unknown),
          attachments: Schema.Array(Schema.Unknown),
        }),
      )(http.calls[0]?.body);
      assert.strictEqual(created.subject, "报价");
      assert.deepStrictEqual(created.attachments, [
        {
          "@odata.type": "#microsoft.graph.fileAttachment",
          name: "a.txt",
          contentType: "text/plain",
          contentBytes: "aGk=",
        },
      ]);
    }),
);

it.effect("reply drafts start from createReply so Outlook threads them", () =>
  Effect.gen(function* () {
    const http = fakeHttp({
      "POST /me/messages/orig/createReplyAll": { status: 201, json: { id: "d2" } },
      "PATCH /me/messages/d2": { json: {} },
      "POST /me/messages/d2/attachments": { status: 201, json: {} },
    });
    const remote = yield* run(http, (a) =>
      a.saveDraft(account, {
        creation: draftCreation(),
        remote: null,
        message: { ...draftMessage, mode: "replyAll" },
        original: Option.some({ providerId: "orig", threadId: "conv-1" }),
        replaceAttachments: true,
      }),
    );
    assert.deepStrictEqual(remote, { draftId: "d2", messageId: "d2" });
    assert.deepStrictEqual(paths(http.calls), [
      "POST /me/messages/orig/createReplyAll",
      "PATCH /me/messages/d2",
      "POST /me/messages/d2/attachments",
    ]);
  }),
);

it.effect(
  "Graph reuses Content-ID inline images without duplicating managed parts on replacement",
  () =>
    Effect.gen(function* () {
      const http = fakeHttp({
        "PATCH /me/messages/d1": { json: {} },
        "GET /me/messages/d1/attachments": {
          json: {
            value: [
              { id: "copied-logo", isInline: true, contentId: "logo@example.com" },
              { id: "server-only", isInline: true, contentId: "unknown@example.com" },
            ],
          },
        },
        "DELETE /me/messages/d1/attachments/copied-logo": { status: 204 },
        "POST /me/messages/d1/attachments": { status: 201, json: {} },
      });
      yield* run(http, (adapter) =>
        adapter.saveDraft(account, {
          creation: draftCreation(),
          remote: { draftId: "d1", messageId: "d1" },
          message: {
            ...draftMessage,
            html: '<img src="cid:logo@example.com">',
            attachments: [
              {
                filename: "logo.png",
                mimeType: "image/png",
                content: "aGk=",
                contentId: "logo@example.com",
              },
            ],
          },
          original: Option.none(),
          replaceAttachments: true,
        }),
      );
      assert.deepStrictEqual(paths(http.calls), [
        "PATCH /me/messages/d1",
        "GET /me/messages/d1/attachments",
        "DELETE /me/messages/d1/attachments/copied-logo",
        "POST /me/messages/d1/attachments",
      ]);
      const uploaded = Schema.decodeUnknownSync(
        Schema.Struct({
          contentId: Schema.String,
          isInline: Schema.Boolean,
          contentBytes: Schema.String,
        }),
      )(http.calls.at(-1)?.body);
      assert.deepStrictEqual(uploaded, {
        contentId: "logo@example.com",
        isInline: true,
        contentBytes: "aGk=",
      });
    }),
);

it.effect("Graph draft source properties survive create, update, import and removal", () =>
  Effect.gen(function* () {
    const source = "**bold**\n\n- first\n- second\n";
    const propertySchema = Schema.Struct({
      singleValueExtendedProperties: Schema.Array(
        Schema.Struct({ id: Schema.String, value: Schema.String }),
      ),
    });
    let externalBody: string | undefined;
    const writtenBody = () => {
      const write = http.calls
        .filter((call) => call.method === "POST" || call.method === "PATCH")
        .at(-1);
      return Schema.decodeUnknownSync(
        Schema.Struct({ body: Schema.Struct({ content: Schema.String }) }),
      )(write?.body).body.content;
    };
    const http = fakeHttp({
      "POST /me/messages": { status: 201, json: { id: "markdown-draft" } },
      "PATCH /me/messages/markdown-draft": { json: {} },
      "GET /me/messages/markdown-draft": (url) => {
        assert.include(url.searchParams.get("$expand") ?? "", MARKDOWN_DRAFT_PROPERTY);
        const lastWrite = http.calls
          .filter((call) => call.method === "POST" || call.method === "PATCH")
          .at(-1);
        const fields = Schema.decodeUnknownSync(propertySchema)(lastWrite?.body);
        assert.strictEqual(fields.singleValueExtendedProperties[0]?.id, MARKDOWN_DRAFT_PROPERTY);
        return { json: fields };
      },
      "GET /me/messages/markdown-draft/$value": () => ({
        text: `To: bob@example.com\r\nMIME-Version: 1.0\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${externalBody ?? writtenBody()}`,
      }),
    });
    yield* run(http, (adapter) =>
      Effect.gen(function* () {
        if (!adapter.draftMarkdownSource) throw new Error("Graph draft source API is missing");
        const remote = yield* adapter.saveDraft(account, {
          creation: draftCreation(),
          remote: null,
          message: {
            ...draftMessage,
            attachments: [],
            text: source,
            html: renderMarkdown(source),
            markdown: true,
          },
          original: Option.none(),
          replaceAttachments: false,
        });
        assert.deepStrictEqual(
          yield* adapter.draftMarkdownSource(account, "markdown-draft"),
          markdownDraftSource(source),
        );
        const raw = yield* adapter.fetchRaw(account, "markdown-draft");
        const parsed = withDraftMarkdownSource(
          yield* parseRawDraft(raw),
          yield* adapter.draftMarkdownSource(account, "markdown-draft"),
        );
        const imported = importedMessage(parsed, []);
        assert.strictEqual(imported.markdown, true);
        assert.strictEqual(imported.text, source);
        assert.strictEqual(imported.html, undefined);
        assert.strictEqual(imported.originalHtml, undefined);
        externalBody = '<p style="color:red">Edited in another client</p>';
        const external = withDraftMarkdownSource(
          yield* parseRawDraft(yield* adapter.fetchRaw(account, "markdown-draft")),
          yield* adapter.draftMarkdownSource(account, "markdown-draft"),
        );
        assert.strictEqual(external.markdown, undefined);
        assert.strictEqual(external.text, "Edited in another client");
        assert.strictEqual(
          external.originalHtml,
          '<p style="color:rgb(255,0,0)">Edited in another client</p>',
        );
        externalBody = undefined;
        const edited = "_edited_\n";
        yield* adapter.saveDraft(account, {
          creation: draftCreation(),
          remote,
          message: { ...imported, text: edited, html: renderMarkdown(edited) },
          original: Option.none(),
          replaceAttachments: false,
        });
        assert.deepStrictEqual(
          yield* adapter.draftMarkdownSource(account, "markdown-draft"),
          markdownDraftSource(edited),
        );
        yield* adapter.saveDraft(account, {
          creation: draftCreation(),
          remote,
          message: { ...imported, text: "", html: renderMarkdown(""), markdown: true },
          original: Option.none(),
          replaceAttachments: false,
        });
        assert.deepStrictEqual(
          yield* adapter.draftMarkdownSource(account, "markdown-draft"),
          markdownDraftSource(""),
        );
        yield* adapter.saveDraft(account, {
          creation: draftCreation(),
          remote,
          message: { ...imported, text: "plain", markdown: false },
          original: Option.none(),
          replaceAttachments: false,
        });
        assert.strictEqual(
          yield* adapter.draftMarkdownSource(account, "markdown-draft"),
          undefined,
        );
      }),
    );
    // internetMessageHeaders cannot be patched; only the updateable property is sent.
    assert.ok(
      http.calls
        .filter((call) => call.method === "PATCH")
        .every(
          (call) =>
            !Object.hasOwn(
              Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(call.body),
              "internetMessageHeaders",
            ),
        ),
    );
  }),
);

it.effect("deleting a draft that is already gone succeeds; raw MIME comes from $value", () =>
  Effect.gen(function* () {
    const http = fakeHttp({
      "DELETE /me/messages/d1": { status: 204 },
      "DELETE /me/messages/gone": { status: 404, json: { error: { code: "ErrorItemNotFound" } } },
      "GET /me/messages/m1/$value": { text: "Subject: hi\r\n\r\nbody" },
    });
    const raw = yield* run(http, (a) =>
      Effect.gen(function* () {
        yield* a.deleteDraft(account, { draftId: "d1", messageId: "d1" });
        yield* a.deleteDraft(account, { draftId: null, messageId: "gone" });
        return yield* a.fetchRaw(account, "m1");
      }),
    );
    assert.strictEqual(Buffer.from(raw).toString(), "Subject: hi\r\n\r\nbody");
  }),
);

it.effect("attachments download from $value, skipping inline parts", () =>
  Effect.gen(function* () {
    const http = fakeHttp({
      "GET /me/messages/m1/attachments": {
        json: {
          value: [
            { id: "logo", name: "logo.png", isInline: true },
            { id: "A1", name: "报价.xlsx", isInline: false },
          ],
        },
      },
      "GET /me/messages/m1/attachments/A1/$value": { text: "xlsx-bytes" },
    });
    const bytes = yield* run(http, (a) =>
      a.fetchAttachment(account, "m1", { index: 0, filename: "报价.xlsx", occurrence: 0 }),
    );
    assert.strictEqual(Buffer.from(bytes).toString(), "xlsx-bytes");
  }),
);

it.effect("a forwarded original goes out as raw MIME with a message/rfc822 part", () =>
  Effect.gen(function* () {
    const http = fakeHttp({ "POST /me/sendMail": { status: 202 } });
    const eml = {
      filename: "报价.eml",
      mimeType: "message/rfc822",
      content: chineseOriginal.toString("base64"),
    };
    yield* run(http, (a) =>
      a.send(
        account,
        { ...draftMessage, bcc: [{ name: "", address: "hidden@x.com" }], attachments: [eml] },
        Option.none(),
      ),
    );
    const [call] = http.calls;
    assert.strictEqual(call?.contentType, "text/plain");
    assert.strictEqual(typeof call?.body, "string");
    const parsed = yield* Effect.promise(() =>
      simpleParser(Buffer.from(String(call?.body), "base64")),
    );
    assert.strictEqual(parsed.subject, "报价");
    assert.strictEqual(parsed.text?.trim(), "草稿");
    // Graph reads Bcc from the MIME headers and strips it.
    assert.match(Buffer.from(String(call?.body), "base64").toString(), /^Bcc: hidden@x\.com/m);
    const forwarded = parsed.attachments.find((a) => a.contentType === "message/rfc822");
    assert.strictEqual(forwarded?.filename, "报价.eml");
    assert.isTrue(forwarded?.content.equals(chineseOriginal));
    const inner = yield* Effect.promise(() => simpleParser(forwarded.content));
    assert.strictEqual(inner.subject, "原邮件");
    assert.strictEqual(inner.text?.trim(), "你好，这是原来的邮件。");
  }),
);

it.effect("Graph fetch selects and decodes the full Reply-To recipient collection", () =>
  Effect.gen(function* () {
    const http = fakeHttp({
      "GET /me/messages/reply": {
        json: {
          ...raw,
          id: "reply",
          hasAttachments: false,
          parentFolderId: "inbox",
          replyTo: [
            { emailAddress: { name: "Reply, Team", address: "reply@example.com" } },
            { emailAddress: { address: "other@example.com" } },
          ],
        },
      },
    });
    const parsed = yield* run(http, (adapter) => adapter.fetchMessage(account, "reply"));
    assert.deepStrictEqual(parsed.replyTo, [
      { name: "Reply, Team", address: "reply@example.com" },
      { name: "", address: "other@example.com" },
    ]);
    const request = http.calls.find((call) => call.url.pathname.endsWith("/messages/reply"));
    assert.ok(request);
    assert.ok(request.url.searchParams.get("$select")?.split(",").includes("replyTo"));
    assert.deepStrictEqual(parseGraphMessage(raw, "INBOX", []).replyTo, []);
    assert.deepStrictEqual(parseGraphMessage({ ...raw, replyTo: [] }, "INBOX", []).replyTo, []);
  }),
);

it.effect("Graph reply drafts replace server defaults with the selected Reply-To targets", () =>
  Effect.gen(function* () {
    const incoming = parseGraphMessage(
      {
        ...raw,
        replyTo: [
          { emailAddress: { name: "Reply", address: "reply@example.com" } },
          { emailAddress: { address: "ALIAS@outlook.com" } },
        ],
        toRecipients: [
          ...raw.toRecipients,
          { emailAddress: { name: "Other", address: "other@example.com" } },
        ],
        ccRecipients: [{ emailAddress: { name: "Duplicate", address: "OTHER@example.com" } }],
      },
      "INBOX",
      [],
    );
    const graphRecipient = Schema.Struct({
      emailAddress: Schema.Struct({ name: Schema.String, address: Schema.String }),
    });
    const decodeTargets = Schema.decodeUnknownSync(
      Schema.Struct({
        toRecipients: Schema.Array(graphRecipient),
        ccRecipients: Schema.Array(graphRecipient),
        bccRecipients: Schema.Array(graphRecipient),
      }),
    );
    for (const mode of ["reply", "replyAll"] as const) {
      const action = mode === "reply" ? "createReply" : "createReplyAll";
      const http = fakeHttp({
        [`POST /me/messages/orig/${action}`]: { json: { id: "draft" } },
        "PATCH /me/messages/draft": { json: {} },
        "POST /me/messages/draft/send": { status: 202 },
      });
      yield* run(http, (adapter) =>
        adapter.send(
          account,
          {
            ...replyRecipients(incoming, [account.email, "alias@outlook.com"], mode === "replyAll"),
            bcc: [],
            subject: "Re: Question",
            text: "Answer",
            attachments: [],
            mode,
          },
          Option.some({ providerId: "orig", threadId: "conv-1" }),
        ),
      );
      const patch = http.calls.find((call) => call.method === "PATCH");
      assert.ok(patch);
      assert.deepStrictEqual(decodeTargets(patch.body), {
        toRecipients: [{ emailAddress: { name: "Reply", address: "reply@example.com" } }],
        ccRecipients:
          mode === "replyAll"
            ? [{ emailAddress: { name: "Other", address: "other@example.com" } }]
            : [],
        bccRecipients: [],
      });
    }
  }),
);
