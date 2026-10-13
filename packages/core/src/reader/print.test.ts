import { assert, it } from "@effect/vitest";

import type { Message } from "../domain/domain.js";
import { printableThread, stripActiveContent } from "./print.js";

function message(overrides: Partial<Message>): Message {
  return {
    id: "a/m1",
    accountId: "a",
    threadId: "t1",
    subject: "报价",
    from: { name: "Alice", address: "alice@example.com" },
    to: [{ name: "", address: "me@example.com" }],
    cc: [],
    date: 0,
    snippet: "",
    labels: [],
    isUnread: false,
    isStarred: false,
    hasAttachments: false,
    bodyText: "",
    bodyHtml: "",
    attachments: [],
    ...overrides,
  };
}

const headings = { from: "发件人", to: "收件人", cc: "抄送", date: "日期" };

it("prints every message with headers, escapes text and blocks remote loads", () => {
  const html = printableThread({
    subject: "Q3 <报价>",
    headings,
    formatDate: () => "2026-09-30",
    messages: [
      message({ bodyText: "见附件 <1>" }),
      message({
        id: "a/m2",
        cc: [{ name: "Bob", address: "bob@example.com" }],
        bodyHtml: `<p onclick="x()">Hi</p><script>alert(1)</script><img src="cid:logo">
<img src="https://u1.ct.sendgrid.net/wf/open?upn=a"><a href="javascript:alert(1)">x</a>`,
      }),
    ],
    inline: { "a/m2": { logo: "data:image/png;base64,AAAA" } },
  });
  assert.include(html, "<title>Q3 &lt;报价&gt;</title>");
  assert.include(html, "<pre>见附件 &lt;1&gt;</pre>");
  assert.include(html, "<b>抄送</b> Bob &lt;bob@example.com&gt;");
  assert.strictEqual(html.match(/<b>抄送<\/b>/g)?.length, 1);
  assert.include(html, "default-src 'none'; img-src data:");
  assert.include(html, 'src="data:image/png;base64,AAAA"');
  assert.notInclude(html, "<script>");
  assert.notInclude(html, "onclick");
  assert.notInclude(html, "sendgrid.net");
  assert.notInclude(html, "javascript:");
});

it("removes frames, plugins, base and meta refresh", () => {
  const out = stripActiveContent(
    `<iframe src="https://x"></iframe><object data="x"></object><embed src="x">` +
      `<base href="https://evil/"><meta http-equiv="refresh" content="0;url=https://x"><p>ok</p>`,
  );
  assert.strictEqual(out, "<p>ok</p>");
});

it("print/PDF HTML removes entity-obfuscated script URLs and blocked resource sources", () => {
  const bodyHtml =
    '<a href="java&#x09;script:alert(1)" onClick = "alert(1)">text</a><img src="https://evil.test/pixel">';
  const html = printableThread({
    subject: "Reproduction",
    headings,
    formatDate: () => "date",
    messages: [message({ bodyHtml })],
  });
  assert.include(html, '<div class="body"><a>text</a><img></div>');
  assert.notInclude(html, "evil.test");
  assert.notInclude(html, "alert(1)");
});
