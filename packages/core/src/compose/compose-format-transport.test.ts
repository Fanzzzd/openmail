import { assert, it } from "@effect/vitest";
import {
  composeConversion,
  composeHtmlHasUnsupported,
  preservedComposeHtml,
  remoteComposeBody,
  richComposeBody,
} from "./compose-body.js";
import { composeTransportHtml } from "./compose-transport.js";

it("default paragraphs and lists convert without a false formatting warning", () => {
  for (const html of [
    "<div>one</div><div>two</div>",
    '<div dir="auto">one</div><div dir="auto">two</div>',
    '<ul type="disc"><li>one</li><li>two</li></ul>',
    '<ol type="1"><li>one</li><li>two</li></ol>',
  ]) {
    const body = richComposeBody(html);
    for (const mode of ["markdown", "plain"] as const)
      assert.strictEqual(composeConversion(body, mode).losesFormatting, false, `${mode}: ${html}`);
  }
  for (const html of [
    '<div dir="ltr">one</div>',
    '<div dir="rtl">one</div>',
    '<ul type="dash"><li>one</li></ul>',
    '<ol type="a"><li>one</li></ol>',
    '<div style="text-align:right">one</div>',
  ]) {
    for (const mode of ["markdown", "plain"] as const)
      assert.strictEqual(composeConversion(richComposeBody(html), mode).losesFormatting, true);
  }
});

it("outgoing nested quotes and dashed lists render without application CSS and import losslessly", () => {
  const body = richComposeBody(
    '<blockquote><div>one</div><blockquote>two</blockquote></blockquote><ul type="dash"><li>first</li><li><strong>second</strong><ul type="dash"><li>nested</li></ul></li><li>– literal</li><li></li></ul>',
  );
  const wire = composeTransportHtml({ html: body.html });
  assert.ok(wire);
  assert.strictEqual(
    (wire.match(/border-left:2px solid #ccc;padding-left:12px;margin-left:0/g) ?? []).length,
    2,
  );
  assert.strictEqual((wire.match(/list-style-type:none/g) ?? []).length, 2);
  assert.include(wire, "<li>– first</li>");
  assert.include(wire, "<li>– <strong>second</strong>");
  assert.include(wire, "<li>– – literal</li>");
  assert.strictEqual(composeHtmlHasUnsupported(wire), false);
  assert.deepStrictEqual(richComposeBody(wire), body);
  assert.strictEqual(remoteComposeBody(wire).html, body.html);
  assert.strictEqual(composeTransportHtml({ html: richComposeBody(wire).html }), wire);
  assert.strictEqual(composeTransportHtml({ html: wire }), wire);
  assert.strictEqual(composeTransportHtml({ html: preservedComposeHtml(wire) }), wire);
});

it("transport defaults preserve original quote and list styles without broadening editor CSS", () => {
  const original = preservedComposeHtml(
    '<blockquote class="quoted" style="padding:16px;font-family:Georgia"><b>reply</b></blockquote>',
  );
  const decorated = composeTransportHtml({ html: original });
  assert.include(decorated ?? "", 'class="quoted"');
  assert.include(decorated ?? "", "padding:16px;font-family:Georgia");
  const body = richComposeBody(
    '<blockquote style="margin-left:24px;padding-left:48px;color:#123" dir="rtl">quote</blockquote><ul type="dash" style="margin-left:24px"><li>item</li></ul>',
  );
  const wire = composeTransportHtml({ html: body.html });
  assert.ok(wire);
  assert.deepStrictEqual(richComposeBody(wire), body);
  assert.strictEqual(composeHtmlHasUnsupported(wire), false);
  for (const hostile of [
    '<blockquote style="border-left:2px solid #ccc;padding-left:12px;margin-left:0;background:url(x)">x</blockquote>',
    '<blockquote style="border-left:expression(x);padding-left:12px;margin-left:0">x</blockquote>',
    '<ul type="dash" style="list-style-type:url(x)"><li>– x</li></ul>',
    '<div style="list-style-type:none">x</div>',
    '<ul type="dash" style="list-style-type:none" onclick="bad()"><li>– x</li></ul>',
  ]) {
    assert.strictEqual(composeHtmlHasUnsupported(hostile), true);
    const sanitized = richComposeBody(hostile);
    assert.notMatch(sanitized.html, /url\(|expression|onclick|border-left|list-style-type/);
    assert.deepStrictEqual(richComposeBody(sanitized.html), sanitized);
  }
});

it("formatted transport inside a default font wrapper reopens without locking or accumulating wrappers", () => {
  const body = richComposeBody('<blockquote>quote</blockquote><ul type="dash"><li>dash</li></ul>');
  const font = { family: "Georgia", size: 18 } as const;
  const wire = composeTransportHtml({ html: body.html, composeFont: font });
  assert.ok(wire);
  const reopened = remoteComposeBody(wire);
  assert.strictEqual(reopened.html, body.html);
  assert.deepStrictEqual(reopened.font, font);
  assert.strictEqual(composeHtmlHasUnsupported(wire), false);
  assert.strictEqual(
    composeTransportHtml({ html: reopened.html, composeFont: reopened.font }),
    wire,
  );
});

it("transport preserves unrelated HTML bytes used by Markdown fingerprints and remote draft fixtures", () => {
  for (const html of [
    "",
    "<b>bold</b>",
    "<p>one</p>\n<p>two</p>\n",
    '<a href="https://example.com/?a=1&amp;b=2">details</a>',
  ])
    assert.strictEqual(composeTransportHtml({ html }), html);
});
