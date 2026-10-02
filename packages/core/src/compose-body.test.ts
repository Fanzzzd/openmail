import { assert, describe, it } from "@effect/vitest";

import {
  changeComposeBodyKind,
  composeLink,
  normalizeComposeMessage,
  outgoingComposeBody,
  richComposeBody,
  textComposeHtml,
} from "./compose-body.js";

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
    assert.deepStrictEqual(changeComposeBodyKind(rich, "plain"), {
      kind: "plain",
      text: "bold & text",
    });
    assert.deepStrictEqual(
      changeComposeBodyKind({ kind: "markdown", text: "**source**" }, "rich"),
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
