import { expect, it } from "vitest";
import { customTemplateVariables, fillTemplate } from "./compose-text.js";
import { composePaste } from "./compose-paste.js";
import { richComposeBody, composeConversion, normalizeComposeMessage } from "./compose-body.js";

it("template form discovers unique custom variables across subject/body and never expands values twice", () => {
  expect(
    customTemplateVariables("{project}: {first_name}", "{project} {date} {email} {toString}"),
  ).toEqual(["project", "date", "toString"]);
  expect(
    fillTemplate(
      "{name} {project} {date}",
      { name: "Ada", address: "ada@example.com" },
      { name: "override", project: "{date}", date: "$&" },
    ),
  ).toBe("Ada {date} $&");
  expect(fillTemplate("{toString} {unknown}", undefined)).toBe("{toString} {unknown}");
});
it("matching style pastes literal clipboard text; quote paste is an escaped quote block", () => {
  const text = "<script>alert(1)</script>\r\n<img src=x onerror=bad()> & hello";
  const match = composePaste(text, "matchStyle");
  expect(match.text).toBe(text.replaceAll("\r\n", "\n"));
  expect(match.html).toContain("&lt;script&gt;");
  expect(match.html).not.toContain("<script>");
  const quote = composePaste(text, "quotation");
  expect(quote.text).toBe("> <script>alert(1)</script>\n> <img src=x onerror=bad()> & hello");
  expect(quote.html).toMatch(/^<blockquote>/);
  expect(quote.html).not.toContain("<img");
  expect(richComposeBody(quote.html).html).toBe(quote.html);
});
it("strike and existing quote blocks survive draft/send sanitization, dangerous attributes do not", () => {
  const body = richComposeBody(
    '<blockquote onclick="bad()"><strike style="color:red">old</strike> <s onmouseover="bad()">new</s><script>bad()</script></blockquote>',
  );
  expect(body.html).toBe("<blockquote><s>old</s><s> new</s></blockquote>");
  const message = normalizeComposeMessage({
    to: [],
    cc: [],
    bcc: [],
    subject: "",
    text: "",
    html: body.html,
    attachments: [],
  });
  expect(message.html).toBe(body.html);
});

it("quote paste remains quoted in plain and Markdown alternatives and strike survives span styles", () => {
  const body = richComposeBody(
    '<blockquote>one<br>two<blockquote>nested</blockquote></blockquote><span style="text-decoration:line-through">old</span>',
  );
  expect(body.text).toBe("> one\n> two\n> > nested\nold");
  expect(body.html).toContain("<s>old</s>");
  const markdown = composeConversion(body, "markdown");
  expect(markdown.body).toEqual({ kind: "markdown", text: "> one\n> two\n> > nested\n~~old~~" });
  expect(composeConversion(body, "plain").losesFormatting).toBe(true);
});
