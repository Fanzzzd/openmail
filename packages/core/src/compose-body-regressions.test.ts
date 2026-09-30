import { assert, describe, it } from "@effect/vitest";
import { performance } from "node:perf_hooks";

import {
  composeConversion,
  normalizeComposeMessage,
  outgoingComposeBody,
  remoteComposeBody,
  richComposeBody,
} from "./compose-body.js";

describe("compose sanitizer stability", () => {
  it("closes li exposed by discarded table wrappers without flattening genuine nested lists", () => {
    const input = "<ul><li>a</td><td><li>b";
    const body = remoteComposeBody(input);
    assert.strictEqual(body.html, "<ul><li>a</li><li>b</li></ul>");
    assert.strictEqual(body.text, "- a\n- b");
    assert.deepStrictEqual(richComposeBody(body.html), {
      kind: "rich",
      text: body.text,
      html: body.html,
    });
    const message = {
      to: [],
      cc: [],
      bcc: [],
      subject: "changed",
      text: body.text,
      html: body.html,
      originalHtml: input,
      attachments: [],
    };
    assert.strictEqual(normalizeComposeMessage(message).originalHtml, input);
    assert.deepStrictEqual(outgoingComposeBody(message), body);
    const nested = "<ul><li>a<ol><li>b</li></ol></li><li>c</li></ul>";
    assert.strictEqual(richComposeBody(nested).html, nested);
  });

  it("generated malformed input remains identical after a second sanitization", () => {
    const tokens = [
      "<ul>",
      "<ol>",
      "<li>",
      "</li>",
      "</ul>",
      "</ol>",
      "<td>",
      "</td>",
      "<tr>",
      "</tr>",
      "<table>",
      "</table>",
      "<p>",
      "</p>",
      "<div>",
      "</div>",
      "<b>",
      "</b>",
      "<i>",
      "</i>",
      "<u>",
      "</u>",
      '<span style="font-weight:700">',
      "</span>",
      "<pre>",
      "</pre>",
      "<br>",
      '<a href="https://example.com">',
      "</a>",
      '<a href="javascript:bad()">',
      "<script>bad()</script>",
      "<svg><script>bad()</script></svg>",
      "a",
      " b ",
      "\n",
      "&lt;tag&gt;",
      "&nbsp;",
    ];
    let seed = 0x11abcdef;
    const next = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed;
    };
    for (let sample = 0; sample < 1000; sample++) {
      let input = "";
      const size = 8 + (next() % 30);
      for (let index = 0; index < size; index++) input += tokens[next() % tokens.length];
      const body = richComposeBody(input);
      const repeated = richComposeBody(body.html);
      assert.deepStrictEqual(repeated, body, `sample ${sample}: ${input}`);
      assert.notMatch(body.html, /<(script|svg|table|td|tr)|href="javascript:/i);
    }
  });

  it("only an already-canonical unchanged html field can retain originalHtml", () => {
    const originalHtml = "<p><b>same</b></p>";
    const base = {
      to: [],
      cc: [],
      bcc: [],
      subject: "",
      text: "same",
      attachments: [],
      originalHtml,
    };
    assert.strictEqual(
      normalizeComposeMessage({ ...base, html: originalHtml }).originalHtml,
      undefined,
    );
    assert.strictEqual(
      normalizeComposeMessage({ ...base, html: richComposeBody(originalHtml).html }).originalHtml,
      originalHtml,
    );
  });
});

it("body edits remove inline image parts while retaining ordinary attachments", () => {
  const originalHtml = '<div><img src="cid:logo@example.com">before</div>';
  const body = remoteComposeBody(originalHtml);
  const normal = { filename: "a.txt", mimeType: "text/plain", content: "aGk=" };
  const inline = {
    filename: "logo.png",
    mimeType: "image/png",
    content: "aGk=",
    contentId: "logo@example.com",
  };
  const message = {
    to: [],
    cc: [],
    bcc: [],
    subject: "",
    text: body.text,
    html: body.html,
    originalHtml,
    attachments: [normal, inline],
  };
  assert.deepStrictEqual(normalizeComposeMessage(message).attachments, [normal, inline]);
  const edited = normalizeComposeMessage({ ...message, html: "<b>after</b>" });
  assert.strictEqual(edited.originalHtml, undefined);
  assert.deepStrictEqual(edited.attachments, [normal]);
  assert.deepStrictEqual(normalizeComposeMessage({ ...message, markdown: true }).attachments, [
    normal,
  ]);
  const { html: _html, originalHtml: _originalHtml, ...plain } = message;
  assert.deepStrictEqual(normalizeComposeMessage(plain).attachments, [normal]);
});

it("Markdown conversion scans long NBSP runs in marks and links in linear time", () => {
  const spaces = " ".repeat(40_000);
  for (const tag of ["b", 'a href="https://example.com"']) {
    const closing = tag.startsWith("a") ? "a" : "b";
    const body = richComposeBody(`<pre><${tag}> x${spaces}y </${closing}></pre>`);
    const started = performance.now();
    const converted = composeConversion(body, "markdown");
    assert.isBelow(performance.now() - started, 400);
    assert.include(converted.body.text, `x${spaces}y`);
  }
});
