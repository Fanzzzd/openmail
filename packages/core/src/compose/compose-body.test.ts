import { assert, describe, it } from "@effect/vitest";
import {
  normalizeComposeMessage,
  outgoingComposeBody,
  richComposeBody,
  textComposeHtml,
  composeConversion,
  composeEditorText,
  composeHtmlHasUnsupported,
  editedComposeBody,
  preservedComposeHtml,
  remoteComposeBody,
} from "./compose-body.js";
import { composeLink } from "./compose-nodes.js";
import { renderMarkdown } from "./markdown.js";
import { performance } from "node:perf_hooks";
{
  describe("compose HTML boundary", () => {
    it("preserves four marks and decodes entities into the matching text alternative", () => {
      const body = richComposeBody(
        '<p><b>王&#x5de5;</b> <i>报价</i> <u>确认</u><br><a href="https://example.com/?a=1&amp;b=2">明细</a> &copy; &#39;</p>',
      );
      assert.strictEqual(
        body.html,
        '<div><strong>王工</strong><em> 报价</em><u> 确认</u><br><a href="https://example.com/?a=1&amp;b=2">明细</a> © &#39;</div>',
      );
      assert.strictEqual(body.text, "王工 报价 确认\n明细 <https://example.com/?a=1&b=2> © '");
      assert.deepStrictEqual(richComposeBody(body.html), body);
    });

    it("keeps Outlook span marks and allowed decoration without resource attributes", () => {
      const body = richComposeBody(
        '<span style="font-weight:700;font-style:italic;text-decoration:underline;background:url(https://tracker.test)">你好</span>',
      );
      assert.strictEqual(body.html, "<strong><em><u>你好</u></em></strong>");
      assert.strictEqual(body.text, "你好");
    });

    it("removes scripts, resources, foreign markup, event handlers and dangerous URLs", () => {
      const body = richComposeBody(
        '<head><style>bad</style></head><script>alert(1)</script><svg><a>bad</a></svg><math><mtext>bad</mtext></math><iframe srcdoc="bad">bad</iframe><template>bad</template><div id="x" contenteditable="false" onclick="bad()"><img src="https://tracker.test" onerror="bad()"><a href="jav&#x61;script:bad()" onmouseover="bad()">保留</a><a href="data:text/html,bad">文字</a><a href="file:///tmp/x">文档</a></div>',
      );
      assert.strictEqual(body.html, "<div>保留文字文档</div>");
      assert.strictEqual(body.text, "保留文字文档");
    });

    it("reserializes malformed input so reparsing cannot create executable tags", () => {
      for (const html of [
        '<svg><style><a title="</style><img src=x onerror=bad()>">x',
        '<math><mtext><table><mglyph><style><!--</style><img title="--><img src=x onerror=bad()>">',
        '<div title="x > y" onfocus="bad()"><b>safe</div><script>bad()',
        "<textarea>&lt;img src=x onerror=bad()&gt;</textarea>",
        '<a href="java&#10;script:bad()">safe</a><a href="//evil.test">safe</a>',
      ]) {
        const body = richComposeBody(html);
        assert.notMatch(
          body.html,
          /<(script|img|svg|math|style|iframe)|<[a-z][^>]*\son\w+=|href="(?:javascript|data|file|\/\/)/i,
        );
        assert.deepStrictEqual(richComposeBody(body.html), body);
      }
    });

    it("preserves editor blank lines, block boundaries, Unicode and literal markup", () => {
      const text = "\n你好 & <script>literal</script>\n\n下一行\n";
      assert.strictEqual(richComposeBody(textComposeHtml(text)).text, text);
      assert.strictEqual(
        richComposeBody("<div>one</div><div><br></div><div>two</div>").text,
        "one\n\ntwo",
      );
      assert.strictEqual(richComposeBody("one<div>two</div>").text, "one\ntwo");
    });

    it("accepts only absolute http/https/mailto links", () => {
      for (const href of [
        "https://example.com/a?x=1&y=2",
        "http://example.com",
        "mailto:me@example.com",
      ])
        assert.strictEqual(composeLink(href), href);
      for (const href of [
        "javascript:bad()",
        "vbscript:bad()",
        "data:text/html,x",
        "file:///tmp/x",
        "//example.com",
        "/relative",
        "https://",
        "https://user:pass@example.com",
        "java\nscript:bad()",
        "mailto:",
      ])
        assert.strictEqual(composeLink(href), undefined);
    });

    it("keeps explicit plain and Markdown modes and replaces stale text for rich HTML", () => {
      const rich = richComposeBody("<b>bold</b> &amp; text");
      assert.deepStrictEqual(composeConversion(rich, "plain").body, {
        kind: "plain",
        text: "bold & text",
      });
      assert.deepStrictEqual(
        composeConversion({ kind: "markdown", text: "**source**" }, "rich").body,
        { kind: "rich", text: "**source**", html: "**source**" },
      );
      const message = {
        to: [],
        cc: [],
        bcc: [],
        subject: "",
        attachments: [],
        text: "stale",
        html: "<b>bold</b>",
      };
      assert.strictEqual(normalizeComposeMessage(message).text, "bold");
      assert.strictEqual(normalizeComposeMessage({ ...message, markdown: true }).html, undefined);
      assert.deepStrictEqual(outgoingComposeBody({ text: "**source**", markdown: true }), {
        kind: "markdown",
        text: "**source**",
      });
    });
  });
}

{
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
    it("maps URL-encoded CID references to MIME content ids without dropping them on edit", () => {
      const body = remoteComposeBody(
        '<p><b>word</b><img src="cid:logo%40example.com" alt="Logo"></p><blockquote>quoted</blockquote>',
      );
      assert.include(body.html, 'src="cid:logo@example.com"');
      assert.strictEqual(composeHtmlHasUnsupported(body.originalHtml ?? ""), false);
      const edited = editedComposeBody(body, body.html.replace("word", "edited"));
      assert.include(edited.html, 'src="cid:logo@example.com"');
      assert.include(edited.html, "<blockquote>quoted</blockquote>");
    });
    it("keeps inert complex CSS and stylesheet rules in original-format transport", () => {
      const preserved = preservedComposeHtml(
        '<html><head><style>.signature { font-family:Georgia; padding:16px } @import "https://tracker.test/style.css";</style></head><body><table style="border-collapse:collapse"><tr><td class="signature" style="padding:16px;font-family:Georgia">Cell</td></tr></table></body></html>',
      );
      assert.include(preserved, 'style="border-collapse:collapse"');
      assert.include(preserved, 'style="padding:16px;font-family:Georgia"');
      assert.include(preserved, 'class="signature"');
      assert.include(preserved, ".signature{font-family:Georgia;padding:16px}");
      assert.notMatch(preserved, /@import|tracker\.test/);
      const deep = `${"<div>".repeat(10_000)}<script>bad()</script><b>text</b>${"</div>".repeat(10_000)}`;
      const preservedDeep = preservedComposeHtml(deep);
      assert.notMatch(preservedDeep, /<script/);
      assert.include(preservedDeep, "text");
    });
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
      assert.strictEqual(saved.originalHtml, preservedComposeHtml(source));
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
      assert.include(preserved, 'style="color:rgb(255,0,0)"');
      assert.include(preserved, "<table><tbody><tr><td>Cell</td></tr></tbody></table>");
      assert.notMatch(preserved, /<img|example\.com/);
      assert.notMatch(body.html, /<table|<img/);
      assert.include(body.html, 'style="color:rgb(255,0,0)"');
    });
    it("the wider remote transport allow-list still strips executable content, events and unsafe CSS/URLs", () => {
      const html = preservedComposeHtml(
        '<table onclick="bad()"><tr><td style="color:red;background:url(javascript:bad());width:expression(bad())">cell</td></tr></table><script>bad()</script><img src="data:text/html,bad" onerror="bad()"><a href="javascript:bad()">label</a>',
      );
      assert.include(html, '<td style="color:rgb(255,0,0)">cell</td>');
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
        composeConversion(remoteComposeBody("<table><tr><td>text</td></tr></table>"), "markdown")
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
      const input = `${"<div>".repeat(600)}deep${"</div>".repeat(600)}`;
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
          "<html><head><style>p { padding:16px }</style></head><body>text</body></html>",
        ),
        true,
      );
      assert.strictEqual(composeHtmlHasUnsupported("<h1>heading</h1>"), true);
      assert.strictEqual(composeHtmlHasUnsupported("<blockquote>quote</blockquote>"), false);
    });
  });
}

{
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
      assert.strictEqual(
        normalizeComposeMessage(message).originalHtml,
        preservedComposeHtml(input),
      );
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
}
