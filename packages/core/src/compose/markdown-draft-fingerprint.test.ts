import { preservedComposeHtml } from "./compose-body.js";
import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { simpleParser } from "mailparser";

import { buildMime } from "../platform/node/compose.js";
import {
  importedMessage,
  parseRawDraft,
  withDraftMarkdownSource,
} from "../platform/node/portable-helpers.js";
import {
  draftBodyFingerprint,
  draftTextFingerprint,
  markdownDraftSource,
  type MarkdownDraftSource,
} from "./markdown-draft.js";
import { renderMarkdown } from "./markdown.js";
import { htmlDocument } from "../mime/mime.js";

const source = "**original**\n\n[details](https://example.com)";
const message = {
  to: [{ name: "", address: "bob@example.com" }],
  cc: [],
  bcc: [],
  subject: "Draft",
  text: source,
  html: renderMarkdown(source),
  markdown: true,
  attachments: [],
};

function markedRaw(text: string, html: string): Uint8Array {
  const info = markdownDraftSource(source);
  return Buffer.from(
    [
      "To: bob@example.com",
      "MIME-Version: 1.0",
      "X-Openmail-Markdown: 1",
      `X-Openmail-Markdown-Body-SHA256: ${info.bodyFingerprint}`,
      `X-Openmail-Markdown-Source-SHA256: ${draftTextFingerprint(source)}`,
      "Content-Type: multipart/alternative; boundary=marker",
      "",
      "--marker",
      "Content-Type: text/plain; charset=utf-8",
      "",
      text,
      "--marker",
      "Content-Type: text/html; charset=utf-8",
      "",
      html,
      "--marker--",
      "",
    ].join("\r\n"),
  );
}

describe("Markdown source freshness", () => {
  it("ignores generated document wrappers and attribute order while retaining formatting edits", () => {
    const html = renderMarkdown(source);
    assert.strictEqual(draftBodyFingerprint(html), draftBodyFingerprint(htmlDocument(html)));
    assert.strictEqual(
      draftBodyFingerprint(renderMarkdown("")),
      draftBodyFingerprint(`${htmlDocument(renderMarkdown(""))}\n`),
    );
    assert.strictEqual(
      draftBodyFingerprint('<p class="a" title="b">x</p>'),
      draftBodyFingerprint('<p title="b" class="a">x</p>'),
    );
    assert.notStrictEqual(
      draftBodyFingerprint(html),
      draftBodyFingerprint(html.replace("strong", "em")),
    );
    assert.notStrictEqual(
      draftBodyFingerprint(htmlDocument(html)),
      draftBodyFingerprint(
        htmlDocument(html).replace("</head>", "<style>div { color:red }</style></head>"),
      ),
    );
  });

  it.effect(
    "the MIME marker restores source only while both HTML and text alternatives still match",
    () =>
      Effect.gen(function* () {
        const unchanged = yield* parseRawDraft(markedRaw(source, renderMarkdown(source)));
        assert.strictEqual(unchanged.markdown, true);
        assert.strictEqual(unchanged.text, source);
        for (const html of [
          renderMarkdown("_edited elsewhere_"),
          renderMarkdown(source).replace("<strong>", '<strong style="color:red">'),
        ]) {
          const current = yield* parseRawDraft(markedRaw(source, html));
          assert.strictEqual(current.markdown, undefined);
          assert.strictEqual(current.originalHtml, preservedComposeHtml(html));
          assert.strictEqual(importedMessage(current, []).markdown, undefined);
        }
        const changedText = yield* parseRawDraft(
          markedRaw("Changed plain alternative", renderMarkdown(source)),
        );
        assert.strictEqual(changedText.markdown, undefined);
      }),
  );

  it.effect(
    "stale Graph metadata keeps the remotely edited body and legacy unverifiable markers do not override it",
    () =>
      Effect.gen(function* () {
        const info = markdownDraftSource(source);
        const unmarked = yield* buildMime({ name: "", address: "me@example.com" }, message);
        const parsed = yield* parseRawDraft(unmarked);
        assert.strictEqual(withDraftMarkdownSource(parsed, info).text, source);
        for (const html of [
          renderMarkdown("_changed_"),
          renderMarkdown(source).replace("<strong>", '<strong style="color:red">'),
        ]) {
          const current = yield* parseRawDraft(markedRaw(source, html));
          assert.strictEqual(withDraftMarkdownSource(current, info), current);
          assert.strictEqual(current.markdown, undefined);
          assert.strictEqual(current.originalHtml, preservedComposeHtml(html));
        }
        const legacy = Buffer.from(
          "X-Openmail-Markdown: 1\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<b>Current remote body</b>",
        );
        const current = yield* parseRawDraft(legacy);
        assert.strictEqual(current.markdown, undefined);
        assert.strictEqual(current.text, "Current remote body");
      }),
  );

  it.effect(
    "draft saves carry markers; actual MIME sends never expose Markdown implementation headers",
    () =>
      Effect.gen(function* () {
        const draft = yield* buildMime(
          { name: "", address: "me@example.com" },
          message,
          {},
          { draft: true },
        );
        const draftParsed = yield* Effect.promise(() => simpleParser(draft));
        assert.strictEqual(draftParsed.headers.get("x-openmail-markdown"), "1");
        assert.strictEqual(
          draftParsed.headers.get("x-openmail-markdown-body-sha256"),
          markdownDraftSource(source).bodyFingerprint,
        );
        const sent = yield* buildMime({ name: "", address: "me@example.com" }, message);
        const sentParsed = yield* Effect.promise(() => simpleParser(sent));
        assert.strictEqual(sentParsed.headers.get("x-openmail-markdown"), undefined);
        assert.strictEqual(sentParsed.headers.get("x-openmail-markdown-body-sha256"), undefined);
        assert.strictEqual(sentParsed.headers.get("x-openmail-markdown-source-sha256"), undefined);
        assert.include(sentParsed.html || "", "<strong>original</strong>");
      }),
  );
});

it.effect(
  "styled Markdown quote drafts retain their source and legacy quote fingerprints stay valid",
  () =>
    Effect.gen(function* () {
      const quoted = "> quoted\n>\n> > nested\n";
      const html = renderMarkdown(quoted);
      const raw = yield* buildMime(
        { name: "", address: "me@example.com" },
        { ...message, text: quoted, html },
        {},
        { draft: true },
      );
      const current = yield* parseRawDraft(raw);
      assert.strictEqual(current.markdown, true);
      assert.strictEqual(current.text, quoted);
      const legacy = {
        version: 1,
        text: quoted,
        bodyFingerprint: draftBodyFingerprint(html),
      } satisfies MarkdownDraftSource;
      const legacyRaw = yield* parseRawDraft(
        Buffer.from(`MIME-Version: 1.0\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${html}`),
      );
      assert.strictEqual(withDraftMarkdownSource(legacyRaw, legacy).markdown, true);
      const editedHtml = html.replace("color:#555", "color:red");
      assert.notStrictEqual(editedHtml, html);
      const edited = yield* parseRawDraft(
        Buffer.from(
          `MIME-Version: 1.0\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${editedHtml}`,
        ),
      );
      assert.strictEqual(withDraftMarkdownSource(edited, legacy), edited);
    }),
);
