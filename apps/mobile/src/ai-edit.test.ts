import { expect, it } from "vitest";
import { restoreMobileRichText, richComposeBody } from "@openmail/core/portable";
import { applyAiEdit, composeAiPart, aiUndoBody } from "./ai-edit";

it("replaces just the reply and keeps the signature, quote, HTML and their mark offsets", () => {
  const suffix = "\n\n-- \nMy signature\n\n> Original quote";
  const htmlSuffix =
    "<br><br>-- <br><em>My signature</em><br><br>&gt; <strong>Original quote</strong>";
  const body = {
    text: `My reply${suffix}`,
    html: `<strong>My reply</strong>${htmlSuffix}`,
    marks: [
      { start: 0, end: 8, kind: "bold" as const },
      { start: 14, end: 26, kind: "italic" as const },
      { start: 30, end: 44, kind: "bold" as const },
    ],
    list: false,
  };
  expect(composeAiPart(body.text).text).toBe("My reply");
  const accepted = applyAiEdit(body, "Thanks for confirming.");
  expect(accepted?.text).toBe(`Thanks for confirming.${suffix}`);
  expect(accepted?.html).toContain(htmlSuffix);
  const actual = body;
  const shift = "Thanks for confirming.".length - "My reply".length;
  for (const mark of actual.marks.filter((entry) => entry.start >= 8))
    expect(accepted?.marks).toContainEqual({
      ...mark,
      start: mark.start + shift,
      end: mark.end + shift,
    });
  if (!accepted) throw new Error("Missing accepted edit");
  const undo = { before: body, acceptedText: accepted.text };
  expect(aiUndoBody(accepted, undo)).toBe(body);
  expect(aiUndoBody({ text: `${accepted.text}edited later` }, undo)).toBe(null);
});

it("keeps leading/trailing whitespace, signatures without a separator and quoted headers intact", () => {
  const text =
    "  My reply\r\n\r\nRegards,\r\nAlice\r\n\r\nOn Friday, Bob wrote:\r\n> Quoted message";
  const part = composeAiPart(text, "Regards,\r\nAlice");
  expect(part.text).toBe("My reply");
  const body = { text, marks: [], list: false };
  const accepted = applyAiEdit(body, "New reply", "Regards,\r\nAlice");
  expect(accepted?.text).toBe(text.replace("My reply", "New reply"));
  expect(composeAiPart("\n\n-- \nSignature\n\n> Quote").text).toBe("");
});

it.each([
  "<p>Hello &amp; welcome</p><p>My reply</p><p>-- <br><em>Alice</em></p><blockquote>Original quote</blockquote>",
  "<ul><li>First point</li><li>Last point</li><li>-- <br><strong>Alice</strong></li></ul><blockquote>Original quote</blockquote>",
])("preserves formatted tails across HTML blocks and entity boundaries: %s", (html) => {
  const canonical = richComposeBody(html).html;
  const editor = restoreMobileRichText({ text: "", html: canonical });
  const body = { ...editor, html: canonical };
  const accepted = applyAiEdit(body, "New & concise reply");
  const part = composeAiPart(body.text);
  expect(accepted?.text).toBe(`New & concise reply${body.text.slice(part.end)}`);
  expect(accepted?.html).toContain("<blockquote>Original quote</blockquote>");
  expect(accepted?.html).toContain("Alice</");
});

it("keeps a CRLF signature and quote byte-identical without a configured signature", () => {
  const text = "My reply\r\n\r\n-- \r\nAlice\r\n\r\n> Original quote";
  expect(composeAiPart(text).text).toBe("My reply");
  expect(applyAiEdit({ text, marks: [], list: false }, "New reply")?.text).toBe(
    text.replace("My reply", "New reply"),
  );
});

it("rewrites a formatted reply after the editor and canonical HTML normalize whitespace differently", () => {
  const text = "My reply\n\n-- \nAlice\n\n> Original quote";
  const html = richComposeBody(
    "<strong>My reply</strong><br><br>-- <br><em>Alice</em><br><br>&gt; Original quote",
  ).html;
  const accepted = applyAiEdit({ text, html, marks: [], list: false }, "New reply");
  expect(accepted?.text).toBe(text.replace("My reply", "New reply"));
  expect(accepted?.html).toContain(html.slice(html.indexOf("<br>")));
});
it("preserves HTML blockquotes without a text quote marker or signature", () => {
  const html = "<p>My reply</p><blockquote><em>Quoted history</em></blockquote>";
  const editor = restoreMobileRichText({ text: "", html });
  expect(composeAiPart(editor.text, undefined, html).text).toBe("My reply");
  const accepted = applyAiEdit({ ...editor, html }, "New reply");
  expect(accepted?.text).toBe(editor.text.replace("My reply", "New reply"));
  expect(accepted?.html).toContain("<blockquote><em>Quoted history</em></blockquote>");
});
