import { expect, it } from "vitest";
import {
  hiddenDraftProbes,
  clientHtmlDrafts,
  outlookMsoDraftHtml,
  outlookWindowsReplyHtml,
} from "../../test-support/html-draft-fixtures.js";
import {
  composeHtmlHasUnsupported,
  remoteComposeBody,
  outgoingComposeBody,
  normalizeComposeMessage,
  preservedComposeHtml,
  editedComposeBody,
  richComposeBody,
} from "./compose-body.js";
import { visibleHtmlText } from "../visible-text.js";
import { prepareMessageHtml } from "../reader-html.js";

const backgroundDraftProbes = [
  '<div style="background-color:#777"><span style="color:#000000">Visible contrast</span></div>',
  '<style>.dark{background-color:#777}</style><div class="dark"><span style="color:#000000">Visible contrast</span></div>',
  '<style>.dark{background-color:#777}.ink{color:#000000}</style><div class="dark"><span class="ink">Visible contrast</span></div>',
  '<div style="background-color:#777"><div><font color="#000000">Visible contrast</font></div></div>',
  '<table bgcolor="#777777"><tr><td><span style="color:#000000">Visible contrast</span></td></tr></table>',
];
it.each(backgroundDraftProbes)("default text keeps its colour on explicit paper: %s", (html) => {
  const transport = preservedComposeHtml(html);
  expect(transport).toContain("Visible contrast");
  expect(transport).toMatch(/color:(?:#000(?:000)?|rgb\(0,0,0\))/);
  expect(visibleHtmlText(transport).text).toBe("Visible contrast");
  expect(preservedComposeHtml(transport)).toBe(transport);
  expect(visibleHtmlText(prepareMessageHtml(transport).html).text).toBe(
    visibleHtmlText(transport).text,
  );
});

it.each([
  '<div style="background:#000"><span style="color:windowtext">SECRET</span></div>',
  '<style>.dark{background:#000}</style><div class="dark"><span style="color:windowtext">SECRET</span></div>',
  '<style>.dark{background:#000}.ink{color:windowtext}</style><div class="dark"><span class="ink">SECRET</span></div>',
  '<table bgcolor="#000000"><tr><td><span style="color:windowtext">SECRET</span></td></tr></table>',
  '<div style="background:#000"><span>SECRET</span></div>',
  '<style>.dark{background:#000}</style><div class="dark"><span>SECRET</span></div>',
  '<table bgcolor="#000000"><tr><td><span>SECRET</span></td></tr></table>',
  "<style>body{background:#000}</style><span>SECRET</span>",
  '<style>html{background:#000}</style><span style="color:windowtext">SECRET</span>',
  "<style>html body{background:#000}</style><span>SECRET</span>",
])("default text on a dark paper cannot escape as unreadable transport: %s", (html) => {
  const body = remoteComposeBody(`${html}<p style="color:#f00">Visible</p>`);
  const transport = preservedComposeHtml(body.originalHtml ?? "");
  expect(body.text).toBe("Visible");
  expect(body.hiddenTextRemoved).toBe(true);
  expect(transport).not.toContain("SECRET");
  expect(preservedComposeHtml(transport)).toBe(transport);
  expect(visibleHtmlText(prepareMessageHtml(transport).html).text).toBe(
    visibleHtmlText(transport).text,
  );
});

it("hidden class-coloured text leaves no empty style and remains idempotent", () => {
  const html = '<style>.Wh{color:white}</style><p class="Wh">SECRET</p><p>Visible</p>';
  const transport = preservedComposeHtml(html);
  expect(transport).not.toMatch(/SECRET| style(?:[ >]|="")/);
  expect(preservedComposeHtml(transport)).toBe(transport);
});

it("a readable intentional colour on dark paper survives inherited defaults", () => {
  const body = remoteComposeBody(
    '<div style="background-color:#000;color:#fff"><span>Readable</span></div>',
  );
  expect(body.text).toBe("Readable");
  expect(body.html).toContain("color:#fff");
  expect(body.hiddenTextRemoved).toBeUndefined();
});

it.each([outlookMsoDraftHtml, outlookWindowsReplyHtml])(
  "Word-generated Outlook HTML opens editable and preserves its content",
  (html) => {
    const body = remoteComposeBody(html);
    expect(composeHtmlHasUnsupported(html)).toBe(false);
    expect(composeHtmlHasUnsupported(body.originalHtml ?? "")).toBe(false);
    expect(body.hiddenTextRemoved).toBeUndefined();
    expect(body.html).toContain("<strong>there</strong>");
    expect(body.html).toContain("font-family:Calibri,sans-serif");
    expect(body.html).not.toMatch(/MsoNormal|WordSection1|EmailStyle|<style|<font|_MailAutoSig/);
    expect(preservedComposeHtml(preservedComposeHtml(html))).toBe(preservedComposeHtml(html));
    const edited = editedComposeBody(body, body.html.replace("there", "friend"));
    expect(edited.html).toContain("<strong>friend</strong>");
    if (html === outlookMsoDraftHtml) {
      expect(body.text).toContain("Hello there");
      expect(body.html).toContain('href="https://aka.ms/GetOutlookForMac"');
      expect(body.html).toMatch(
        /Get<\/span> <a href="https:\/\/aka.ms\/GetOutlookForMac"><span[^>]*>Outlook for Mac/,
      );
      expect(edited.html).toContain("font-family:Aptos,sans-serif");
      expect(edited.text).toContain("Outlook for Mac");
    } else {
      expect(body.html).toContain("<hr>");
      expect(edited.html).toContain("<strong>From:</strong>");
      expect(edited.html).toMatch(/<blockquote[^>]*>.*Quoted original/);
    }
  },
);

it("MSO EmailStyle's windowtext inherits visible text instead of removing it", () => {
  const body = remoteComposeBody(
    '<style>span.EmailStyle17{font-family:"Calibri",sans-serif;color:windowtext}</style><span class="EmailStyle17">Visible</span>',
  );
  expect(body.text).toBe("Visible");
  expect(body.hiddenTextRemoved).toBeUndefined();
  expect(composeHtmlHasUnsupported(body.originalHtml ?? "")).toBe(false);
});

it.each(["margin-top:0;margin-bottom:0", "margin-top:0px;margin-bottom:0px", "margin:0"])(
  "Outlook's hidden P stylesheet is inert and editable: %s",
  (margin) => {
    const source = `<html><head><style type="text/css" style="display:none;"> P {${margin};color:#123;} </style></head><body><p>Reply</p></body></html>`;
    const body = remoteComposeBody(source);
    expect(composeHtmlHasUnsupported(source)).toBe(false);
    expect(composeHtmlHasUnsupported(body.originalHtml ?? "")).toBe(false);
    expect(body.html).toBe('<div style="color:#123">Reply</div>');
    expect(body.text).toBe("Reply");
    expect(body.hiddenTextRemoved).toBeUndefined();
    expect(body.originalHtml).not.toContain("<style");
  },
);

it("a complete Outlook web draft carrying the exact web stylesheet opens editable", () => {
  const fixture = clientHtmlDrafts.find(({ client }) => client === "Outlook web");
  if (!fixture) throw new Error("Missing Outlook fixture");
  expect(fixture.html).toContain(
    '<style type="text/css" style="display:none;"> P {margin-top:0;margin-bottom:0;} </style>',
  );
  const body = remoteComposeBody(fixture.html);
  expect(composeHtmlHasUnsupported(fixture.html)).toBe(false);
  expect(composeHtmlHasUnsupported(body.originalHtml ?? "")).toBe(false);
  expect(body.html).toContain("Aptos_EmbeddedFont");
  expect(body.html).toContain('<hr style="display:inline-block;width:98%">');
  expect(body.html).toContain('src="cid:logo@example.com"');
  expect(body.html).toMatch(/<blockquote[^>]*>.*<strong>Quoted reply<\/strong>/);
  expect(body.hiddenTextRemoved).toBeUndefined();
});

it("a hiding rule on the document body omits the entire hidden subtree", () => {
  const body = remoteComposeBody("<style>body{display:none}</style><p>SECRET</p>");
  expect(body.text).toBe("");
  expect(preservedComposeHtml(body.originalHtml ?? "")).not.toContain("SECRET");
});

it("benign stylesheet inlining keeps specificity, source order and inline overrides", () => {
  const body = remoteComposeBody(
    '<style>.visible{color:#000;background-color:#fff}p{color:#fff}</style><p class="visible">Visible</p><p style="color:#000">Inline</p>',
  );
  expect(body.text).toBe("Visible\nInline");
  expect(visibleHtmlText(preservedComposeHtml(body.originalHtml ?? "")).text).toBe(
    "Visible\nInline",
  );
});

it("existing cached drafts cannot send a stale text alternative or a hidden CID part", () => {
  const originalHtml =
    '<p>Visible</p><div style="display:none">SECRET<img src="cid:hidden@example.com"></div>';
  const old = richComposeBody(originalHtml);
  const saved = normalizeComposeMessage({
    to: [],
    cc: [],
    bcc: [],
    subject: "Old draft",
    html: old.html,
    text: "Visible SECRET",
    originalHtml,
    attachments: [
      {
        filename: "hidden.png",
        mimeType: "image/png",
        content: "aGk=",
        contentId: "hidden@example.com",
      },
    ],
  });
  expect(saved.text).toBe("Visible");
  expect(saved.originalHtml).not.toContain("SECRET");
  expect(saved.attachments).toEqual([]);
});

it("the ordinary space in a greeting stays outside the bold mark", () => {
  expect(richComposeBody("Hi <b>Bob</b>").html).toBe("Hi <strong>Bob</strong>");
});

it.each(hiddenDraftProbes)("preserved drafts exclude hidden content and resources: %s", (probe) => {
  const body = remoteComposeBody(`<p>Visible</p>${probe}<img src="cid:logo@example.com">`);
  const message = normalizeComposeMessage({
    to: [],
    cc: [],
    bcc: [],
    subject: "Draft",
    text: body.text,
    html: body.html,
    originalHtml: body.originalHtml,
    attachments: [],
  });
  const transport = preservedComposeHtml(message.originalHtml ?? message.html ?? "");
  expect(transport).not.toMatch(/SECRET|HIDDEN-AFTER|remote\.test|data:image|url\(/);
  expect(message.text).not.toMatch(/SECRET|HIDDEN-AFTER/);
  expect(transport).toContain('src="cid:logo@example.com"');
  expect(visibleHtmlText(transport).text).toContain("Visible");
});

it.each(clientHtmlDrafts)(
  "$client HTML is editable and survives opening, saving and a word edit",
  ({ html }) => {
    const body = remoteComposeBody(html);
    expect(composeHtmlHasUnsupported(body.originalHtml ?? "")).toBe(false);
    expect(composeHtmlHasUnsupported(html)).toBe(false);
    const saved = normalizeComposeMessage({
      to: [],
      cc: [],
      bcc: [],
      subject: "Draft",
      text: body.text,
      html: body.html,
      originalHtml: body.originalHtml,
      ...(body.font ? { composeFont: body.font } : {}),
      attachments: [],
    });
    expect(outgoingComposeBody(saved)).toEqual(body);
    const edited = editedComposeBody(body, body.html.replace("Bob", "Ben"));
    expect(edited.html).toContain("<strong>Ben</strong>");
    expect(edited.html).toContain("<li>First</li><li>Second</li>");
    expect(edited.html).toMatch(/<blockquote[^>]*>.*<strong>Quoted reply<\/strong>/);
    expect(edited.html).toContain('src="cid:logo@example.com"');
  },
);

it.each([
  "font-family: Aptos, Aptos_EmbeddedFont, Aptos_MSFontService, Calibri, Helvetica, sans-serif; font-size:12pt; color:rgb(0,0,0)",
  'font-family:"Aptos",\'Aptos_EmbeddedFont\',"Aptos_MSFontService",Calibri,Helvetica,sans-serif;font-size:11pt',
])("Outlook font stacks remain editable: %s", (style) => {
  const body = remoteComposeBody(
    `<div class="elementToProof" style="${style.replaceAll('"', "&quot;")}">Hi <b>Bob</b></div>`,
  );
  expect(composeHtmlHasUnsupported(body.originalHtml ?? "")).toBe(false);
  expect(body.html).toContain("Aptos_EmbeddedFont");
  expect(body.html).toContain("Aptos_MSFontService");
  expect(body.html).not.toMatch(/\d+\.\d{3,}px/);
});

it("reply rules and legacy font tags survive a word edit", () => {
  const body = remoteComposeBody(
    '<p>Hi <b>Bob</b></p><hr style="display:inline-block;width:98%" tabindex="-1"><font face="Calibri, sans-serif" size="2" color="#000">Regards</font>',
  );
  expect(composeHtmlHasUnsupported(body.originalHtml ?? "")).toBe(false);
  expect(body.html).toContain('<hr style="display:inline-block;width:98%">');
  expect(body.html).toContain(
    '<span style="font-family:Calibri,sans-serif;font-size:13px">Regards</span>',
  );
  expect(editedComposeBody(body, body.html.replace("Bob", "Ben")).html).toContain("<hr");
});

it.each([
  "black",
  "#000",
  "#000000",
  "rgb(0,0,0)",
  "windowtext",
  "#212121",
  "#1F1F1F",
  "rgb(36,36,36)",
])("imported default text colour follows the theme: %s", (colour) => {
  const body = remoteComposeBody(
    `<p style="color:${colour}">Get <a href="https://aka.ms/outlook"><span style="color:#0078D4">Outlook for iOS</span></a></p>`,
  );
  expect(body.text).toContain("Get Outlook for iOS");
  expect(body.hiddenTextRemoved).toBeUndefined();
  expect(composeHtmlHasUnsupported(body.originalHtml ?? "")).toBe(false);
  expect(body.html).toContain("color:#0078d4");
  expect(body.html).not.toMatch(
    /color:(?:black|#000(?:000)?|#212121|#1f1f1f|rgb\(0,0,0\)|rgb\(36,36,36\)|windowtext)(?:;|"|<)/i,
  );
  expect(preservedComposeHtml(body.originalHtml ?? "")).not.toContain(colour);
  const source = `<span style="color:${colour}">Get</span>`;
  const once = preservedComposeHtml(source);
  expect(once).toBe("Get");
  expect(preservedComposeHtml(once)).toBe(once);
  const picked = editedComposeBody(body, body.html.replace("<div>", '<div style="color:#000000">'));
  const saved = normalizeComposeMessage({
    to: [],
    cc: [],
    bcc: [],
    subject: "Edited",
    text: picked.text,
    html: picked.html,
    originalHtml: picked.originalHtml,
    attachments: [],
  });
  expect(saved.html).toContain("color:#000000");
  expect(saved.originalHtml).toBeUndefined();
});

it("default-colour normalization does not reveal text hidden on a black background", () => {
  const body = remoteComposeBody(
    '<p style="color:#000;background-color:#000">SECRET</p><p>Visible</p>',
  );
  expect(body.text).toBe("Visible");
  expect(body.originalHtml).not.toContain("SECRET");
  expect(body.hiddenTextRemoved).toBe(true);
});

it("a benign reply-rule stylesheet is represented in the editor", () => {
  const body = remoteComposeBody(
    "<style>hr{display:inline-block;width:98%}</style><p>Hi</p><hr><p>Quoted</p>",
  );
  expect(composeHtmlHasUnsupported(body.originalHtml ?? "")).toBe(false);
  expect(body.html).toContain('<hr style="display:inline-block;width:98%">');
  expect(body.text).toBe("Hi\nQuoted");
});

it("the hidden-text notice survives saving and disappears after a real body edit", () => {
  const body = remoteComposeBody('<p>Visible</p><p style="display:none">SECRET</p>');
  expect(body.hiddenTextRemoved).toBe(true);
  const saved = normalizeComposeMessage({
    to: [],
    cc: [],
    bcc: [],
    subject: "Draft",
    html: body.html,
    text: body.text,
    originalHtml: body.originalHtml,
    hiddenTextRemoved: body.hiddenTextRemoved,
    attachments: [],
  });
  const reopened = outgoingComposeBody(saved);
  expect(reopened.kind === "rich" && reopened.hiddenTextRemoved).toBe(true);
  expect(
    editedComposeBody(body, body.html.replace("Visible", "Edited")).hiddenTextRemoved,
  ).toBeUndefined();
});

it.each([
  '<img apple-inline="yes" id="apple-logo" src="cid:logo@example.com" height="80" width="240">',
  '<img src="cid:logo@example.com" height="80">',
])("CID image dimensions remain editable: %s", (html) => {
  const body = remoteComposeBody(html);
  expect(composeHtmlHasUnsupported(html)).toBe(false);
  expect(body.html).toContain('height="80"');
  expect(body.html).not.toMatch(/apple-inline|id=/);
});

it.each([
  ...clientHtmlDrafts.map(({ html }) => html),
  ...hiddenDraftProbes,
  '<table><tr><td style="padding:16px;color:red">Cell</td></tr></table>',
  '<div style="color:red"></div>',
  '<style>.signature{font-family:Calibri;position:relative}</style><div class="signature">Text</div>',
  '<font face="Calibri, sans-serif" size="2" color="#000">Hi</font>',
])("preserved HTML is idempotent: %s", (html) => {
  const once = preservedComposeHtml(html);
  expect(preservedComposeHtml(once)).toBe(once);
});
