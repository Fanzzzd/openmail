import { assert, describe, it } from "@effect/vitest";
import { performance } from "node:perf_hooks";
import { composeStyle, composeStyleValue, composeReplacement } from "./compose-format.js";
import {
  composeHtmlHasUnsupported,
  richComposeBody,
  normalizeComposeMessage,
  composeConversion,
} from "./compose-body.js";
import { scaledMs } from "../../test-support/test-time.js";

const formatted =
  '<div dir="rtl" style="text-align:justify;margin-left:24px"><span style="font-family:Georgia;font-size:18px;color:#aBc;background-color:rgb(1, 2, 255)"><sup>2</sup><sub>3</sub><s>old</s><code>x\u00a0&lt;\u00a0y</code></span></div><blockquote><blockquote>quote</blockquote></blockquote><ul type="dash"><li>one<ol type="1"><li>two</li></ol></li></ul><pre> a  b\nc</pre>';
describe("rich formatting boundary", () => {
  it("retains allowed formats, editable remote drafts and consistent plain alternatives", () => {
    const body = richComposeBody(formatted);
    assert.include(
      body.html,
      "font-family:Georgia;font-size:18px;color:#abc;background-color:rgb(1,2,255)",
    );
    assert.include(body.html, "<sup>2</sup><sub>3</sub><s>old</s><code>x\u00a0&lt;\u00a0y</code>");
    assert.include(body.text, "> > quote");
    assert.include(body.text, "- one\n  1. two");
    assert.include(body.text, " a  b\nc");
    assert.strictEqual(richComposeBody("Use <code>x  y</code>").text, "Use x  y");
    assert.strictEqual(composeHtmlHasUnsupported(formatted), false);
    assert.deepStrictEqual(richComposeBody(body.html), body);
    assert.strictEqual(
      normalizeComposeMessage({
        to: [],
        cc: [],
        bcc: [],
        subject: "",
        attachments: [],
        text: "stale",
        html: formatted,
      }).text,
      body.text,
    );
    assert.strictEqual(composeConversion(body, "plain").losesFormatting, true);
    assert.strictEqual(composeConversion(body, "markdown").losesFormatting, true);
    assert.strictEqual(composeHtmlHasUnsupported('<div dir="auto">שלום</div>'), false);
  });
  it("rejects executable, noncanonical and unbounded CSS, retaining valid declarations only", () => {
    for (const value of [
      "url(https://evil)",
      "expression(alert(1))",
      "var(--x)",
      "#123!important",
      "#123/*x*/",
      "r\\65 d",
      "#12345678",
      "rgb(256,0,0)",
      "rgb(-1,0,0)",
      "rgb(50%,0,0)",
      "red",
    ]) {
      assert.strictEqual(composeStyleValue("color", value), undefined, value);
      assert.strictEqual(
        composeHtmlHasUnsupported(`<span style="color:${value}">x</span>`),
        value !== "#123/*x*/" && value !== "red",
      );
    }
    for (const style of [
      "position:fixed",
      "font-family:url(https://evil)",
      "font-size:999px",
      "margin-left:241px",
      "padding-left:-1px",
      "text-align:start",
      "direction:auto",
      "background:url(x)",
      "width:50px",
    ])
      assert.strictEqual(composeStyle(style), "", style);
    const body = richComposeBody(
      '<span id="x" onclick="bad()" style="color:#fff;position:fixed;background-color:url(x);font-size:14px">safe</span>',
    );
    assert.strictEqual(body.html, '<span style="color:#fff;font-size:14px">safe</span>');
    assert.strictEqual(
      composeStyle('font-family:"Courier New";padding-left:240px;text-decoration:line-through'),
      "font-family:Courier New;padding-left:240px;text-decoration:line-through",
    );
  });
  it("fuzzes malformed structures, style combinations and nesting for idempotence", () => {
    const tokens = [
      "<p>",
      "</p>",
      '<div dir="rtl">',
      "</div>",
      "<pre>",
      "</pre>",
      "<code>",
      "</code>",
      "<sup>",
      "</sup>",
      "<sub>",
      "</sub>",
      "<blockquote>",
      "</blockquote>",
      '<ul type="dash">',
      "</ul>",
      '<ol type="i">',
      "</ol>",
      "<li>",
      "</li>",
      '<span style="text-decoration:underline;font-weight:700;color:#aBc;font-size:14px">',
      "</span>",
      '<span style="color:var(--x);font-family:Arial">',
      "<script>bad()</script>",
      " a ",
      "\n",
      "&nbsp;",
      "<br>",
    ];
    let seed = 26;
    const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
    for (let sample = 0; sample < 2000; sample++) {
      const input = Array.from(
        { length: 8 + (next() % 60) },
        () => tokens[next() % tokens.length],
      ).join("");
      const body = richComposeBody(input);
      assert.deepStrictEqual(richComposeBody(body.html), body, input);
      assert.notMatch(body.html, /<script|var\(|on\w+=/);
    }
    const deep = `${"<blockquote>".repeat(1000)}x${"</blockquote>".repeat(1000)}`;
    const body = richComposeBody(deep);
    assert.deepStrictEqual(richComposeBody(body.html), body);
    assert.strictEqual(composeHtmlHasUnsupported(deep), true);
    const expanded = `${'<span style="font-weight:bold;font-style:italic;text-decoration:underline">'.repeat(200)}x${"</span>".repeat(200)}`;
    const capped = richComposeBody(expanded);
    assert.deepStrictEqual(richComposeBody(capped.html), capped);
  });
  it("processes long hostile CSS and large shallow documents within a linear-time budget", () => {
    const input = `<span style="color:${" ".repeat(100000)}#123;unknown:${"x".repeat(100000)}">ok</span>${"<div><code>x</code></div>".repeat(15000)}`;
    const start = performance.now();
    const body = richComposeBody(input);
    assert.isBelow(performance.now() - start, scaledMs(3000));
    assert.include(body.html, 'style="color:#123"');
  });
});
it("detects bounded Markdown replacements and independently controls lists", () => {
  for (const [text, field, expected] of [
    ["* ", "block", "ul"],
    ["- ", "block", "ul"],
    ["1. ", "block", "ol"],
    ["> ", "block", "blockquote"],
    ["``` ", "block", "pre"],
    ["**bold**", "tag", "strong"],
    ["*italic*", "tag", "em"],
    ["~~old~~", "tag", "s"],
    ["`code`", "tag", "code"],
  ] as const) {
    const result = composeReplacement(text, true, true);
    assert.ok(result && field in result);
    assert.strictEqual("block" in result ? result.block : result.tag, expected);
  }
  assert.strictEqual(composeReplacement("* ", true, false), undefined);
  assert.ok(composeReplacement("* ", false, true));
  assert.strictEqual(composeReplacement("**bold**", false, true), undefined);
  for (const text of ["** **", "\\**bold**", "word*word*", "1. a", "*later ", "> later"])
    assert.strictEqual(composeReplacement(text, true, true), undefined, text);
});
