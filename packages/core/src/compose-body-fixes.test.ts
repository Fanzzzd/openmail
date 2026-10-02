import { assert, describe, it } from "@effect/vitest";
import {
  composeConversion,
  composeEditorText,
  composeHtmlHasUnsupported,
  editedComposeBody,
  normalizeComposeMessage,
  outgoingComposeBody,
  preservedComposeHtml,
  remoteComposeBody,
  richComposeBody,
  textComposeHtml,
} from "./compose-body.js";
import { renderMarkdown } from "./markdown.js";

describe("rich compose whitespace", () => {
  it("drops pretty-print whitespace between blocks and collapses inline whitespace", () => {
    const html =
      "<html>\n<head><style>bad</style></head>\n<body>\n  <p>First   line</p>\n\n  <p>Second\n  <b> bold </b>   line</p>\n</body>\n</html>";
    const body = richComposeBody(html);
    assert.strictEqual(body.text, "First line\nSecond bold line");
    assert.notMatch(body.html, /\n| {2}/);
    assert.deepStrictEqual(richComposeBody(body.html), body);
    assert.strictEqual(richComposeBody("<b>one </b><i>  two</i>").text, "one two");
  });
  it("turns pre newlines into BR and pre alignment into nonbreaking spaces", () => {
    const body = richComposeBody("<pre>A   B\r\nC\tD\n</pre>");
    assert.strictEqual(body.text, "A   B\nC    D\n");
    assert.include(body.html, "<br>");
    assert.notMatch(body.html, /\r|\n/);
    assert.include(body.html, "\u00a0");
    assert.deepStrictEqual(richComposeBody(body.html), body);
  });
  it("plain-text insertion retains intentional line breaks and aligned spaces in normal HTML", () => {
    const text = "  first   aligned\n\n  last";
    assert.strictEqual(richComposeBody(textComposeHtml(text)).text, text);
  });
});

describe("lists and link alternatives", () => {
  it("retains ordered, unordered and nested lists with readable text prefixes", () => {
    const body = richComposeBody(
      "<ul>\n<li>first</li>\n<li>second<ol><li>inner</li><li>next</li></ol></li>\n</ul>",
    );
    assert.strictEqual(
      body.html,
      "<ul><li>first</li><li>second<ol><li>inner</li><li>next</li></ol></li></ul>",
    );
    assert.strictEqual(body.text, "- first\n- second\n  1. inner\n  2. next");
    assert.strictEqual(composeEditorText(body), "first\nsecond\ninner\nnext");
    assert.deepStrictEqual(richComposeBody(body.html), body);
  });
  it("adds escaped/decoded URL targets exactly once and never leaks dangerous targets", () => {
    const body = richComposeBody(
      '<a href="https://example.com/?x=1&amp;y=2">details</a> <a href="https://example.com">https://example.com</a> <a href="mailto:me@example.com">me</a> <a href="javascript:bad()">bad</a>',
    );
    assert.strictEqual(
      body.text,
      "details <https://example.com/?x=1&y=2> https://example.com me <mailto:me@example.com> bad",
    );
    assert.strictEqual(composeEditorText(body), "details https://example.com me bad");
    assert.deepStrictEqual(richComposeBody(body.html), body);
  });
});

describe("remote source and mode conversion", () => {
  it("preserves original metadata over non-body edits; a real body edit clears it", () => {
    const source =
      '<p style="color:red">Title</p><table><tr><td>Cell</td></tr></table><img src="https://example.com/image.png"><ul><li>item</li></ul>';
    const body = remoteComposeBody(source);
    const message = {
      to: [],
      cc: [],
      bcc: [],
      subject: "before",
      attachments: [],
      text: body.text,
      html: body.html,
      originalHtml: body.originalHtml,
    };
    const saved = normalizeComposeMessage({ ...message, subject: "after" });
    assert.strictEqual(saved.originalHtml, source);
    assert.deepStrictEqual(outgoingComposeBody(saved), body);
    assert.strictEqual(editedComposeBody(body, body.html), body);
    assert.strictEqual(
      editedComposeBody(body, body.html.replace("Title", "Edited")).originalHtml,
      undefined,
    );
    assert.strictEqual(
      normalizeComposeMessage({ ...saved, html: "<b>Edited</b>" }).originalHtml,
      undefined,
    );
    assert.strictEqual(composeHtmlHasUnsupported(source), true);
    assert.strictEqual(
      composeHtmlHasUnsupported("<p><b>bold</b></p><ul><li>item</li></ul>"),
      false,
    );
    const preserved = preservedComposeHtml(source);
    assert.include(preserved, 'style="color:red"');
    assert.include(preserved, "<table><tr><td>Cell</td></tr></table>");
    assert.include(preserved, '<img src="https://example.com/image.png">');
    assert.notMatch(body.html, /<table|<img|style=/);
  });
  it("the wider remote transport allow-list still strips executable content, events and unsafe CSS/URLs", () => {
    const html = preservedComposeHtml(
      '<table onclick="bad()"><tr><td style="color:red;background:url(javascript:bad());width:expression(bad())">cell</td></tr></table><script>bad()</script><img src="data:text/html,bad" onerror="bad()"><a href="javascript:bad()">label</a>',
    );
    assert.include(html, '<td style="color:red">cell</td>');
    assert.notMatch(html, /script|onclick|onerror|expression|javascript:|data:|url\(/);
  });
  it("converts marks, literal Markdown syntax, links and lists to Markdown without losing supported formatting", () => {
    const body = richComposeBody(
      '<b>bold</b> <i>italic</i> <a href="https://example.com/a(b)">details</a><ul><li>one</li><li>two</li></ul><div>literal *star*</div>',
    );
    const converted = composeConversion(body, "markdown");
    assert.strictEqual(converted.losesFormatting, false);
    assert.strictEqual(converted.body.kind, "markdown");
    assert.include(converted.body.text, "**bold**");
    assert.include(converted.body.text, "_italic_");
    assert.include(converted.body.text, "[details](https://example.com/a\\(b\\))");
    assert.include(converted.body.text, "- one\n- two");
    const rendered = renderMarkdown(converted.body.text);
    assert.include(rendered, "<strong>bold</strong>");
    assert.include(rendered, "<em>italic</em>");
    assert.include(rendered, "<li>one</li>");
    assert.include(rendered, "literal *star*");
  });
  it("requests confirmation when Plain loses marks or Markdown loses underline/remote features", () => {
    assert.strictEqual(
      composeConversion(richComposeBody("<b>bold</b>"), "plain").losesFormatting,
      true,
    );
    assert.strictEqual(
      composeConversion(richComposeBody("<u>under</u>"), "markdown").losesFormatting,
      true,
    );
    assert.strictEqual(
      composeConversion(remoteComposeBody('<img src="https://example.com/a">text'), "markdown")
        .losesFormatting,
      true,
    );
    const body = richComposeBody('<a href="https://example.com">details</a>');
    assert.deepStrictEqual(composeConversion(body, "plain"), {
      body: { kind: "plain", text: "details <https://example.com>" },
      losesFormatting: false,
    });
  });
  it("preserves intraword emphasis and nested ordered list structure in Markdown", () => {
    const body = richComposeBody(
      "<div>a<i>b</i>c</div><ol><li>outer<ol><li>inner</li></ol></li></ol>",
    );
    const converted = composeConversion(body, "markdown");
    assert.strictEqual(converted.losesFormatting, false);
    const rendered = renderMarkdown(converted.body.text);
    assert.include(rendered, "a<em>b</em>c");
    assert.match(rendered, /<li>outer\s*<ol>\s*<li>inner<\/li>/);
  });
  it("bounds untrusted nesting before recursive serialization and mode conversion", () => {
    const input = `${"<span>".repeat(600)}deep${"</span>".repeat(600)}`;
    assert.doesNotThrow(() => richComposeBody(input));
    assert.strictEqual(composeHtmlHasUnsupported(input), true);
    const body = remoteComposeBody(input);
    assert.strictEqual(composeConversion(body, "markdown").losesFormatting, true);
  });
  it("treats charset wrappers as harmless but detects stylesheets, headings and quoted layout loss", () => {
    assert.strictEqual(
      composeHtmlHasUnsupported(
        '<html><head><meta charset="utf-8"></head><body><b>bold</b></body></html>',
      ),
      false,
    );
    assert.strictEqual(
      composeHtmlHasUnsupported(
        "<html><head><style>p { color:red }</style></head><body>text</body></html>",
      ),
      true,
    );
    assert.strictEqual(composeHtmlHasUnsupported("<h1>heading</h1>"), true);
    assert.strictEqual(composeHtmlHasUnsupported("<blockquote>quote</blockquote>"), false);
  });
});
