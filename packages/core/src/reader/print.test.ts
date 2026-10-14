import { assert, it } from "@effect/vitest";

import type { Message } from "../domain/message.js";
import { printableThread, stripActiveContent } from "./print.js";
import { scopePrintCss } from "./print-css.js";

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
  assert.include(html, '<div class="om-print-body" id="m-0" data-om-scope><a>text</a><img></div>');
  assert.notInclude(html, "evil.test");
  assert.notInclude(html, "alert(1)");
});

const scope = "#m-1[data-om-scope]";
/** The rules in a sanitized `<style>` of the printed document, one per entry. */
const styleRules = (html: string) =>
  [...html.matchAll(/<style>([^<]*)<\/style>/g)]
    .slice(1)
    .flatMap((match) => (match[1] ?? "").split("}").filter((rule) => rule.trim()));

it("print scopes one message's CSS to its own box, so it cannot hide or rewrite another message", () => {
  // The panel's repro: the second mail hides the first message's text, writes a fake
  // account number after it and hides its own sender header.
  const attacker =
    "<style>h1 + .message .body p{display:none}" +
    'h1 + .message .body::after{content:"Our account number has changed to 999-000."}' +
    ".message:last-child .head{display:none}" +
    "h1 + .om-print-message .om-print-body p{display:none}" +
    ".om-print-message:last-child .om-print-head{display:none}" +
    "#m-0 p{display:none}</style><p>see above</p>";
  const html = printableThread({
    subject: "Re: wire",
    headings,
    formatDate: () => "d",
    messages: [
      message({ bodyHtml: "<p>Our account number is 111-222.</p>" }),
      message({
        id: "a/m2",
        from: { name: "", address: "attacker@evil.test" },
        bodyHtml: attacker,
      }),
    ],
  });
  const rules = styleRules(html);
  assert.isAbove(rules.length, 0);
  // Every remaining rule matches only inside the attacker's own box.
  for (const rule of rules) assert.match(rule, /^#m-1\[data-om-scope\] /, rule);
  // Selectors naming the print chrome or another box are gone.
  assert.notInclude(html, ".om-print-head{");
  assert.notInclude(html, "#m-0 p");
  // Each header sits outside the mail's box; each box contains its layout and paint.
  assert.include(
    html,
    '<section class="om-print-message"><div class="om-print-head"><div><b>发件人</b> attacker@evil.test</div>',
  );
  assert.include(html, '</div></div><div class="om-print-body" id="m-1" data-om-scope><style>');
  assert.include(html, "contain: layout paint; overflow: hidden");
});

it("print CSS scoping covers pseudo-elements, sibling combinators and nested at-rules", () => {
  assert.strictEqual(
    scopePrintCss('p::before{content:"x"}::after{content:"y"}h1+p{color:red}a~b{color:red}', scope),
    `${scope} p::before{content:"x"}${scope} ::after{content:"y"}${scope} h1+p{color:red}${scope} a~b{color:red}`,
  );
  assert.strictEqual(
    scopePrintCss(
      "@media print{p{color:red}body{color:red}}@supports (display:grid){@media screen{.a{color:red}}}",
      scope,
    ),
    `@media print{${scope} p{color:red}}@supports (display:grid){@media screen{${scope} .a{color:red}}}`,
  );
  // Nested rules stay nested inside their scoped parent; ones reaching the root are dropped.
  assert.strictEqual(
    scopePrintCss(".a{color:red;&+.b{color:blue}:root &{color:red}}", scope),
    `${scope} .a{color:red;&+.b{color:blue}}`,
  );
  assert.strictEqual(scopePrintCss("> p{color:red}", scope), `${scope}>p{color:red}`);
});

it("print CSS scoping drops selectors that reach the document, the chrome or another box", () => {
  for (const css of [
    "html p{color:red}",
    "body{color:red}",
    "\\68 tml p{color:red}",
    "svg|body{color:red}",
    ":root{color:red}",
    ":scope p{color:red}",
    ":is(html, p){color:red}",
    ":not(body) p{color:red}",
    "p:has(+ .x){color:red}",
    ".om-print-head{display:none}",
    ":where(.OM-PRINT-body) p{display:none}",
    "#m-0 p{display:none}",
    "[data-om-scope] p{display:none}",
    "& p{color:red}",
    "@page{margin:0}",
  ])
    assert.strictEqual(scopePrintCss(css, scope), "", css);
});

it("print keeps @import, :has() and other active CSS out after scoping", () => {
  const html = printableThread({
    subject: "s",
    headings,
    formatDate: () => "d",
    messages: [
      message({
        bodyHtml:
          '<style>@import url(https://evil.test/a.css);@media print{@import "x.css";p:has(a){color:red}.x{color:red}}</style>',
      }),
    ],
  });
  assert.notInclude(html, "@import");
  assert.notInclude(html, "evil.test");
  assert.notInclude(html, ":has(");
  assert.include(html, "@media print{#m-0[data-om-scope] .x{color:red}}");
});
