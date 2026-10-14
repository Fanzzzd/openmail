import { afterEach, expect, it, vi } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";
import { composeTransportHtml, visibleHtmlText, type Provider } from "@openmail/core/schema";
import { flow, eventually, incoming, key, clickButton, row } from "./harness";
import {
  hiddenDraftProbes,
  clientHtmlDrafts,
  outlookMsoDraftHtml,
  outlookWindowsReplyHtml,
} from "../../../../../../packages/core/test-support/html-draft-fixtures";

let current: Awaited<ReturnType<typeof flow>> | undefined;
const originalObjectURLs = ["createObjectURL", "revokeObjectURL"].map((name) => ({
  name,
  descriptor: Object.getOwnPropertyDescriptor(URL, name),
}));
afterEach(async () => {
  await current?.dispose();
  current = undefined;
  for (const { name, descriptor } of originalObjectURLs) {
    if (descriptor) Object.defineProperty(URL, name, descriptor);
    else Reflect.deleteProperty(URL, name);
  }
});

const html =
  '<p>Hello <b>world</b>, <a href="https://example.com/details">details</a></p>' +
  "<ul><li>First</li><li><i>Second</i></li></ul>" +
  '<div class="signature">Regards<br><u>Alice</u><img src="cid:logo%40example.com" alt="Logo"></div>' +
  "<blockquote><p>On Tuesday Bob wrote:</p><blockquote><b>Quoted reply</b></blockquote></blockquote>";

function rawDraft(body: string) {
  return new TextEncoder().encode(
    [
      "From: me@example.com",
      "To: Bob <bob@example.com>",
      "Subject: HTML draft",
      "MIME-Version: 1.0",
      'Content-Type: multipart/related; boundary="draft"',
      "",
      "--draft",
      "Content-Type: text/html; charset=utf-8",
      "",
      body,
      "--draft",
      "Content-Type: image/png",
      "Content-Disposition: inline; filename=logo.png",
      "Content-ID: <logo@example.com>",
      "Content-Transfer-Encoding: base64",
      "",
      "aGk=",
      "--draft--",
      "",
    ].join("\r\n"),
  );
}

async function open(provider: Provider, body = html, raw = rawDraft(body)) {
  URL.createObjectURL = vi.fn(() => "blob:local-logo");
  URL.revokeObjectURL = vi.fn();
  current = await flow({
    provider,
    messages: [incoming("draft", { labels: ["DRAFT"], bodyHtml: body, bodyText: "stale" })],
    serverDraft: { providerId: "draft", raw },
  });
  await eventually(() => expect(screen.getByRole("textbox", { name: "Subject" })).toBeTruthy());
  return current;
}

function savedDraft(h: Awaited<ReturnType<typeof flow>>, index: number) {
  const draft = h.server.draftLog[index];
  if (draft?.kind !== "save") throw new Error("Missing draft save");
  return draft;
}

function editBold(editor: HTMLElement, from: string, to: string) {
  const bold = editor.querySelector("strong");
  if (!bold) throw new Error("Missing bold text");
  bold.textContent = bold.textContent.replace(from, to);
  fireEvent.input(editor);
}

function previewFrame(): HTMLIFrameElement {
  const frame = screen.getAllByTitle("Message").at(-1);
  if (!(frame instanceof HTMLIFrameElement)) throw new Error("Missing draft preview");
  return frame;
}

it.each(
  (["gmail", "outlook", "imap"] satisfies Provider[]).flatMap((provider) => [
    { provider, client: "Outlook MSO", body: outlookMsoDraftHtml },
    { provider, client: "Outlook Windows reply", body: outlookWindowsReplyHtml },
  ]),
)(
  "$provider: $client opens in the rich composer, saves and edits without losing content",
  async ({ provider, client, body }) => {
    const h = await open(provider, body);
    const editor = screen.getByRole("textbox", { name: "Body" });
    expect(editor.getAttribute("contenteditable")).toBe("true");
    expect(screen.queryByText("Original formatting kept")).toBeNull();
    expect(screen.queryByText("Hidden text was removed.")).toBeNull();
    expect(editor.innerHTML).toContain("font-family:Calibri,sans-serif");
    expect(editor.innerHTML).not.toMatch(/<style|MsoNormal|WordSection1|_MailAutoSig/);
    key("s", { metaKey: true }, editor);
    await eventually(() => expect(h.server.draftLog).toHaveLength(1));
    const saved = savedDraft(h, 0);
    expect(saved.push.message.html).toContain("<b>there</b>");
    editBold(editor, "there", "friend");
    key("s", { metaKey: true }, editor);
    await eventually(() => expect(h.server.draftLog).toHaveLength(2));
    const edited = savedDraft(h, 1);
    expect(edited.push.message.html).toContain("<strong>friend</strong>");
    expect(edited.push.message.html).toContain("font-family:Calibri,sans-serif");
    if (client === "Outlook MSO") {
      expect(edited.push.message.html).toContain('href="https://aka.ms/GetOutlookForMac"');
      expect(edited.push.message.text).toContain("Outlook for Mac");
      expect(edited.push.message.html).toContain("font-family:Aptos,sans-serif");
    } else {
      expect(edited.push.message.html).toContain("<hr>");
      expect(edited.push.message.html).toContain("<strong>From:</strong>");
      expect(edited.push.message.text).toContain("Quoted original");
    }
  },
);

it.each(["light", "dark"])(
  "Outlook iOS default text inherits the %s editor theme while link colours survive",
  async (theme) => {
    const body =
      '<p><span style="font-family:Aptos,sans-serif;color:#212121">Get </span><a href="https://aka.ms/outlook"><span style="color:#0078D4">Outlook for iOS</span></a></p>';
    const h = await open("outlook", body);
    const editor = screen.getByRole("textbox", { name: "Body" });
    editor.style.color = theme === "dark" ? "rgb(245,245,245)" : "rgb(23,23,23)";
    editor.style.backgroundColor = theme === "dark" ? "rgb(23,23,23)" : "rgb(255,255,255)";
    const get = [...editor.querySelectorAll("span")].find(
      (node) => node.textContent.trim() === "Get",
    );
    const link = editor.querySelector("a span");
    if (!get || !link) throw new Error("Missing signature text");
    expect(get.getAttribute("style")).not.toContain("color:");
    expect(window.getComputedStyle(get).color).toBe(window.getComputedStyle(editor).color);
    expect(window.getComputedStyle(link).color).toBe("rgb(0, 120, 212)");
    key("s", { metaKey: true }, editor);
    await eventually(() => expect(h.server.draftLog).toHaveLength(1));
    const saved = savedDraft(h, 0);
    expect(saved.push.message.html).not.toContain("#212121");
    expect(saved.push.message.html).toContain("color:#0078d4");
    expect(saved.push.message.text).toContain("Get Outlook for iOS");
  },
);

it.each(
  clientHtmlDrafts.map((fixture, index) => ({
    ...fixture,
    provider: (["gmail", "outlook", "imap"] satisfies Provider[])[index] ?? "gmail",
  })),
)(
  "$client opens in the rich composer and preserves quotes and CID images after an edit",
  async ({ html, provider }) => {
    const h = await open(provider, html);
    const editor = screen.getByRole("textbox", { name: "Body" });
    expect(editor.getAttribute("contenteditable")).toBe("true");
    expect(editor.querySelector("strong")?.textContent).toBe("Bob");
    if (provider === "outlook") {
      expect(html).toContain(
        '<style type="text/css" style="display:none;"> P {margin-top:0;margin-bottom:0;} </style>',
      );
      expect(editor.querySelector("style")).toBeNull();
      expect(screen.queryByText("Hidden text was removed.")).toBeNull();
      expect(editor.querySelector(".elementToProof")).toBeNull();
      expect(editor.innerHTML).toContain("Aptos_EmbeddedFont");
      expect(editor.querySelector("hr")?.getAttribute("style")).toBe(
        "display:inline-block;width:98%",
      );
      expect(editor.querySelector("hr")?.hasAttribute("tabindex")).toBe(false);
      expect(editor.innerHTML).toContain("font-family:Calibri,sans-serif;font-size:13px");
      expect(editor.querySelector("font")).toBeNull();
    }
    if (provider === "imap") {
      expect(editor.querySelector("img")?.getAttribute("height")).toBe("80");
      expect(editor.querySelector("img")?.getAttribute("width")).toBe("240");
      expect(editor.querySelector("img")?.hasAttribute("apple-inline")).toBe(false);
      expect(editor.querySelector("img")?.hasAttribute("id")).toBe(false);
    }
    expect(screen.queryByText("Original formatting kept")).toBeNull();
    key("s", { metaKey: true }, editor);
    await eventually(() => expect(h.server.draftLog).toHaveLength(1));
    const saved = savedDraft(h, 0);
    expect(saved.push.message.html).not.toContain("openmail-reader-body");
    editBold(editor, "Bob", "Ben");
    key("s", { metaKey: true }, editor);
    await eventually(() => expect(h.server.draftLog).toHaveLength(2));
    const edited = savedDraft(h, 1);
    expect(edited.push.message.html).toContain("<strong>Ben</strong>");
    expect(edited.push.message.html).toMatch(/<blockquote[^>]*>.*<strong>Quoted reply<\/strong>/);
    expect(edited.push.message.html).toContain('src="cid:logo@example.com"');
    expect(edited.push.message.attachments).toMatchObject([{ contentId: "logo@example.com" }]);
    expect(edited.push.message.composeFont).toEqual(saved.push.message.composeFont);
    if (provider === "outlook")
      expect(edited.push.message.html).toContain('<hr style="display:inline-block;width:98%">');
    if (provider === "imap") expect(edited.push.message.html).toContain('height="80"');
  },
);

it("an editable imported draft explains that hidden text was removed, including after reopening", async () => {
  const h = await open("outlook", '<p>Visible <b>word</b></p><p style="display:none">SECRET</p>');
  const editor = screen.getByRole("textbox", { name: "Body" });
  expect(editor.getAttribute("contenteditable")).toBe("true");
  expect(screen.getByText("Hidden text was removed.")).toBeTruthy();
  expect(screen.queryByText("Original formatting kept")).toBeNull();
  expect(editor.textContent).not.toContain("SECRET");
  key("s", { metaKey: true }, editor);
  await eventually(() => expect(h.server.draftLog).toHaveLength(1));
  const stored = (await h.run(h.m.threads({ mailbox: "drafts" })))[0];
  if (!stored) throw new Error("Missing saved draft");
  const reopened = await h.run(h.m.openDraft(stored.id));
  expect(reopened.message.hiddenTextRemoved).toBe(true);
  expect(reopened.message.text).toBe("Visible word");
  editBold(editor, "word", "edit");
  expect(screen.queryByText("Hidden text was removed.")).toBeNull();
  key("s", { metaKey: true }, editor);
  await eventually(() => expect(h.server.draftLog).toHaveLength(2));
  expect(savedDraft(h, 1).push.message.hiddenTextRemoved).toBeUndefined();
});

it("preserved draft preview matches transport and excludes every hidden-content probe", async () => {
  const h = await open(
    "gmail",
    `${html}${hiddenDraftProbes.join("")}<table><tr><td>Layout</td></tr></table>`,
  );
  const frame = previewFrame();
  key("s", { metaKey: true });
  await eventually(() => expect(h.server.draftLog).toHaveLength(1));
  const saved = savedDraft(h, 0);
  const transport = composeTransportHtml(saved.push.message) ?? "";
  expect(transport).not.toMatch(
    /SECRET|HIDDEN-AFTER|remote\.test|data:image|url\(|openmail-reader-body/,
  );
  expect(saved.push.message.text).not.toMatch(/SECRET|HIDDEN-AFTER/);
  previewMatches(transport, frame);
  expect(
    new DOMParser().parseFromString(frame.srcdoc, "text/html").querySelectorAll("img"),
  ).toHaveLength(1);
});

it("forward preview and send exclude every hidden-content probe", async () => {
  const body = `<p>Visible</p>${hiddenDraftProbes.join("")}<table><tr><td>Layout</td></tr></table>`;
  current = await flow({
    messages: [incoming("one", { bodyHtml: body, bodyText: "Visible SECRET" })],
  });
  const h = current;
  await eventually(() => expect(row(h.id("one"))).toBeTruthy());
  fireEvent.click(row(h.id("one")));
  await eventually(() =>
    expect(screen.getByRole("article", { name: /^Selected message/ })).toBeTruthy(),
  );
  key("f", { metaKey: true, shiftKey: true });
  await eventually(() => expect(screen.getByText("Original formatting kept")).toBeTruthy());
  const frame = previewFrame();
  fireEvent.change(screen.getByLabelText("To", { exact: true }), {
    target: { value: "bob@example.com" },
  });
  await eventually(() => expect(screen.queryByText("Loading attachments…")).toBeNull());
  clickButton("Send");
  await eventually(() => expect(h.server.sent).toHaveLength(1));
  const sent = h.server.sent[0];
  if (!sent) throw new Error("Missing forwarded message");
  expect(sent.message.html).not.toMatch(
    /SECRET|HIDDEN-AFTER|remote\.test|data:image|url\(|openmail-reader-body/,
  );
  expect(sent.message.text).not.toMatch(/SECRET|HIDDEN-AFTER/);
  previewMatches(composeTransportHtml(sent.message) ?? "", frame);
});

function previewMatches(transport: string, frame = previewFrame()) {
  expect(frame.getAttribute("sandbox")).toBe("allow-same-origin");
  expect(frame.srcdoc).toContain("default-src 'none'");
  const preview = new DOMParser().parseFromString(frame.srcdoc, "text/html");
  expect(visibleHtmlText(preview.body.innerHTML).text).toBe(visibleHtmlText(transport).text);
  expect(preview.body.querySelector("script,form,input,button")).toBeNull();
  expect(preview.body.innerHTML).not.toMatch(
    /SECRET|HIDDEN-AFTER|remote\.test|tracker\.test|url\(/,
  );
}

function semantics(body: string, word: string) {
  const document = new DOMParser().parseFromString(body, "text/html");
  expect(document.querySelector("b,strong")?.textContent.trim()).toBe(word);
  expect(document.querySelector("a")?.getAttribute("href")).toBe("https://example.com/details");
  expect([...document.querySelectorAll("li")].map((li) => li.textContent)).toEqual([
    "First",
    "Second",
  ]);
  expect(document.querySelector("li i,li em")?.textContent).toBe("Second");
  expect(document.querySelector("u")?.textContent).toBe("Alice");
  expect(document.querySelector("img")?.parentElement?.textContent).toBe("RegardsAlice");
  expect(document.querySelector("blockquote blockquote")?.textContent).toBe("Quoted reply");
  expect(document.querySelector("blockquote b,blockquote strong")?.textContent).toBe(
    "Quoted reply",
  );
  expect(document.querySelector("img")?.getAttribute("src")).toBe("cid:logo@example.com");
  expect(body).not.toMatch(/blob:|data-compose-cid/);
}

it.each(["gmail", "outlook", "imap"] satisfies Provider[])(
  "%s plain-text server drafts still use the textarea and save literal text",
  async (provider) => {
    const text = "Hello **world**\n\n<literal>";
    const raw = new TextEncoder().encode(
      [
        "To: bob@example.com",
        "Subject: Plain draft",
        "MIME-Version: 1.0",
        "Content-Type: text/plain; charset=utf-8",
        "",
        text,
      ].join("\r\n"),
    );
    const h = await open(provider, "", raw);
    const editor = screen.getByRole("textbox", { name: "Body" });
    expect(editor).toBeInstanceOf(HTMLTextAreaElement);
    expect(editor).toHaveProperty("value", text);
    expect(screen.queryByText("Original formatting kept")).toBeNull();
    key("s", { metaKey: true }, editor);
    await eventually(() => expect(h.server.draftLog).toHaveLength(1));
    const saved = savedDraft(h, 0);
    expect(saved.push.message.text).toBe(text);
    expect(saved.push.message.html).toBeUndefined();
    fireEvent.change(editor, { target: { value: text.replace("world", "everyone") } });
    key("s", { metaKey: true }, editor);
    await eventually(() => expect(h.server.draftLog).toHaveLength(2));
    const edited = savedDraft(h, 1);
    expect(edited.push.message.text).toBe(text.replace("world", "everyone"));
    expect(edited.push.message.html).toBeUndefined();
  },
);

it.each(["gmail", "outlook", "imap"] satisfies Provider[])(
  "%s server HTML opens, saves untouched, then edits one word without losing other formatting",
  async (provider) => {
    const h = await open(provider);
    const editor = screen.getByRole("textbox", { name: "Body" });
    expect(editor.getAttribute("contenteditable")).toBe("true");
    expect(editor.querySelector("img")?.getAttribute("src")).toBe("blob:local-logo");
    key("s", { metaKey: true }, editor);
    await eventually(() => expect(h.server.draftLog).toHaveLength(1));
    const saved = savedDraft(h, 0);
    semantics(saved.push.message.html ?? "", "world");
    expect(saved.push.message.attachments).toMatchObject([
      { contentId: "logo@example.com", content: "aGk=" },
    ]);

    editBold(editor, "world", "everyone");
    key("s", { metaKey: true }, editor);
    await eventually(() => expect(h.server.draftLog).toHaveLength(2));
    const edited = savedDraft(h, 1);
    semantics(edited.push.message.html ?? "", "everyone");
    expect(edited.push.message.originalHtml).toBeUndefined();
    expect(edited.push.message.attachments).toEqual(saved.push.message.attachments);
    expect(edited.push.message.text).toContain("Hello everyone");
  },
);

it.each(["gmail", "outlook", "imap"] satisfies Provider[])(
  "%s keeps unsupported tables and CSS until an explicit body edit",
  async (provider) => {
    const source = `${html}<style>.signature{padding:16px}@import "https://tracker.test/style.css";</style><table style="border-collapse:collapse"><tr><td style="padding:16px;font-family:Georgia">Cell</td></tr></table><script>bad()</script><form action="https://tracker.test"><input name="secret"><button>Submit</button></form><img src="https://tracker.test/pixel" onerror="bad()"><div onclick="bad()" style="background:url(https://tracker.test/background)">Safe text</div>`;
    const h = await open(provider, source);
    const frame = previewFrame();
    expect(screen.queryByRole("textbox", { name: "Body" })).toBeNull();
    expect(screen.getByText("Original formatting kept")).toBeTruthy();
    key("s", { metaKey: true });
    await eventually(() => expect(h.server.draftLog).toHaveLength(1));
    const saved = savedDraft(h, 0);
    expect(saved.push.message.html).toContain('style="border-collapse:collapse"');
    expect(saved.push.message.html).toContain('style="padding:16px;font-family:Georgia"');
    expect(saved.push.message.html).toContain("<table");
    previewMatches(composeTransportHtml(saved.push.message) ?? "", frame);
    expect(saved.push.message.html).toContain(".signature{padding:16px}");
    expect(saved.push.message.html).not.toMatch(
      /<script|<form|<input|<button|onerror|onclick|@import/,
    );
    clickButton("Edit body");
    await eventually(() => expect(screen.getByRole("alertdialog")).toBeTruthy());
    const dialog = screen.getByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Edit body" }));
    await eventually(() => expect(screen.getByRole("textbox", { name: "Body" })).toBeTruthy());
    const editor = screen.getByRole("textbox", { name: "Body" });
    expect(editor.getAttribute("contenteditable")).toBe("true");
    // Merely unlocking is not a body edit.
    key("s", { metaKey: true }, editor);
    await eventually(() => expect(h.server.draftLog).toHaveLength(2));
    const unlocked = savedDraft(h, 1);
    expect(unlocked.push.message.html).toBe(saved.push.message.html);
    editBold(editor, "world", "edited");
    key("s", { metaKey: true }, editor);
    await eventually(() => expect(h.server.draftLog).toHaveLength(3));
    const edited = savedDraft(h, 2);
    expect(edited.push.message.originalHtml).toBeUndefined();
    expect(edited.push.message.html).not.toContain("<table");
    semantics(edited.push.message.html ?? "", "edited");
  },
);
