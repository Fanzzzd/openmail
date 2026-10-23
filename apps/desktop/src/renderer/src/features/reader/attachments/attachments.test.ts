import { act, createElement, type ReactNode } from "react";
import { Effect } from "effect";
import { AsyncResult } from "effect/reactivity";
import { setupI18n, i18n as globalI18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { DEFAULT_PREFS, type ReaderAttachment } from "@openmail/core/schema";
import { beforeAll, expect, it, vi } from "vitest";
import { testDom } from "../../../test-support/test-dom";

const rpc = vi.hoisted(() => ({ calls: vi.fn(), openDownloads: vi.fn() }));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => AsyncResult.success(DEFAULT_PREFS),
  useAtomSet: () => rpc.openDownloads,
}));
vi.mock("../../../state/downloads", () => ({ downloadsOpenAtom: "downloadsOpen" }));
vi.mock("../../../state/queries", () => ({ prefsAtom: "prefs" }));
vi.mock("../../../state/mail", () => ({
  useRunMail: () => Effect.runSync,
  withMail: (
    f: (call: (tag: string, payload: unknown) => Effect.Effect<unknown>) => Effect.Effect<unknown>,
  ) =>
    f((tag, payload) => {
      rpc.calls(tag, payload);
      switch (tag) {
        case "AttachmentCapabilities":
          return Effect.succeed({ share: true });
        case "PrepareAttachmentDrag":
          return Effect.void;
        case "AttachmentAction":
          return Effect.succeed({ count: 2, failures: [] });
        case "SaveAttachmentsTo":
          return Effect.succeed(2);
        case "EmbeddedMessage":
          return Effect.succeed({
            subject: "Inside",
            from: "Sender <sender@example.com>",
            to: "Reader <to@example.com>",
            cc: "",
            date: "2026-01-01",
            bodyHtml: '<p>Embedded body</p><img src="https://remote.example/image.png">',
            attachments: [
              {
                path: [2, 0],
                filename: "inside.txt",
                mimeType: "text/plain",
                size: 6,
                embedded: false,
                decodeError: false,
              },
            ],
          });
        default:
          return Effect.succeed([]);
      }
    }),
}));
vi.mock("../../../ui/Menu", () => ({
  DropdownMenu: ({ trigger, children }: { trigger: ReactNode; children: ReactNode }) =>
    createElement("div", null, trigger, children),
  MenuItem: ({ children, onClick }: { children: ReactNode; onClick: () => void }) =>
    createElement("button", { onClick }, children),
}));
vi.mock("./OpenWithMenu", () => ({ OpenWithSubmenu: () => null }));
vi.mock("../../../ui/Tip", () => ({
  Tip: ({ children }: { children: ReactNode }) => children,
}));
import { AttachmentList } from "./Attachments";
import { loadMessageBody } from "../body/MessageBodyShell";

// The reader body is a lazy chunk; load it so renders below are synchronous.
beforeAll(() => loadMessageBody());

const files: ReaderAttachment[] = [
  {
    path: [0, 0],
    filename: "same.txt",
    mimeType: "text/plain",
    size: 3,
    embedded: false,
    decodeError: false,
  },
  {
    path: [0, 1],
    filename: "same.txt",
    mimeType: "text/plain",
    size: 3,
    embedded: false,
    decodeError: false,
  },
  {
    path: [2],
    filename: "attached.eml",
    mimeType: "message/rfc822",
    size: 300,
    embedded: true,
    decodeError: false,
  },
];
it("multi-selection saves, copies and drags exact paths; embedded mail uses the blocked EmailFrame", () => {
  rpc.calls.mockClear();
  const dom = testDom();
  vi.stubGlobal("MouseEvent", dom.window.Event);
  const i18n = setupI18n({ locale: "en", messages: { en: {} } });
  globalI18n.load("en", {});
  globalI18n.activate("en");
  const notify = vi.fn();
  try {
    dom.render(
      createElement(
        I18nProvider,
        { i18n },
        createElement(AttachmentList, { messageId: "gmail:me/message", files, notify }),
      ),
    );
    const button = (label: string) => {
      const element = Array.from(dom.element.querySelectorAll("button")).find(
        (b) => b.textContent === label,
      );
      if (!element) throw new Error(`Missing ${label}`);
      return element;
    };
    // Use modifier-click so duplicate visible filenames remain separate selections.
    const same = Array.from(dom.element.querySelectorAll("button")).filter((b) =>
      b.textContent.startsWith("same.txt"),
    );
    for (const item of same) {
      const event = new dom.window.Event("click", { bubbles: true });
      Object.defineProperty(event, "metaKey", { value: true });
      act(() => {
        item.dispatchEvent(event);
      });
    }
    expect(dom.element.querySelectorAll('input[type="checkbox"]').length).toBe(3);
    expect(rpc.calls.mock.calls.filter(([tag]) => tag === "PrepareAttachmentDrag")).toHaveLength(0);
    act(() => {
      button("Drag selected to Finder").dispatchEvent(
        new dom.window.Event("pointerdown", { bubbles: true }),
      );
    });
    expect(rpc.calls).toHaveBeenCalledWith("PrepareAttachmentDrag", {
      messageId: "gmail:me/message",
      listId: expect.any(String),
      paths: [
        [0, 0],
        [0, 1],
      ],
    });
    // Saving asks nothing: with no Downloads button in this window, a toast says where files go.
    act(() => button("Save selected").click());
    expect(notify).toHaveBeenCalledWith({
      text: "Saving 2 attachments to your attachment folder",
    });
    expect(rpc.openDownloads).not.toHaveBeenCalled();
    const panel = dom.window.document.createElement("div");
    panel.setAttribute("data-downloads", "");
    dom.window.document.body.append(panel);
    act(() => button("Save selected").click());
    expect(rpc.openDownloads).toHaveBeenCalledWith(true);
    panel.remove();
    // Save To is the one path that asks the main process for an OS folder picker.
    act(() => button("Save selected to…").click());
    expect(rpc.calls).toHaveBeenCalledWith("SaveAttachmentsTo", {
      messageId: "gmail:me/message",
      paths: [
        [0, 0],
        [0, 1],
      ],
    });
    act(() => button("Copy selected").click());
    act(() => {
      button("Drag selected to Finder").dispatchEvent(
        new dom.window.Event("dragstart", { bubbles: true, cancelable: true }),
      );
    });
    for (const action of ["save", "copy", "drag"])
      expect(rpc.calls).toHaveBeenCalledWith("AttachmentAction", {
        messageId: "gmail:me/message",
        listId: expect.any(String),
        paths: [
          [0, 0],
          [0, 1],
        ],
        action,
      });
    act(() => {
      const element = Array.from(dom.element.querySelectorAll("button")).find((b) =>
        b.textContent.startsWith("attached.eml"),
      );
      if (!element) throw new Error("No embedded file");
      element.click();
    });
    expect(rpc.calls).toHaveBeenCalledWith("EmbeddedMessage", {
      messageId: "gmail:me/message",
      path: [2],
    });
    expect(dom.element.textContent).toContain("Inside");
    expect(dom.element.textContent).toContain("sender@example.com");
    expect(dom.element.textContent).toContain("inside.txt");
    const frame = dom.element.querySelector("iframe");
    expect(frame?.getAttribute("sandbox")).not.toContain("allow-scripts");
    const html = frame?.getAttribute("srcDoc") ?? frame?.getAttribute("srcdoc") ?? "";
    for (const directive of [
      "script-src 'none'",
      "object-src 'none'",
      "frame-src 'none'",
      "connect-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
    ])
      expect(html).toContain(directive);
    expect(html).toContain("Embedded body");
    expect(html).toContain("img-src data: cid:");
    expect(html).not.toContain("img-src data: cid: https:");
    act(() => button("Clear selection").click());
    expect(dom.element.textContent).not.toContain("Save selected");
  } finally {
    dom.dispose();
  }
});

it("marks the matching attachment index and escapes snippet text", () => {
  rpc.calls.mockClear();
  const dom = testDom();
  const i18n = setupI18n({ locale: "en", messages: { en: {} } });
  const matchingFiles = [0, 1].map((index) => ({
    ...files[0],
    path: [index],
    filename: "same.pdf",
    mimeType: "application/pdf",
    size: 10,
    embedded: false,
    decodeError: false,
  }));
  try {
    dom.render(
      createElement(
        I18nProvider,
        { i18n },
        createElement(AttachmentList, {
          messageId: "gmail:me/m",
          files: matchingFiles,
          notify: vi.fn(),
          matches: [
            {
              source: "attachment",
              messageId: "gmail:me/m",
              attachmentIndex: 1,
              attachmentName: "same.pdf",
              snippet: "<script>amount</script>",
              highlights: [{ start: 8, end: 14 }],
            },
          ],
        }),
      ),
    );
    expect(dom.element.querySelectorAll(".border-amber-500")).toHaveLength(1);
    expect(
      dom.element
        .querySelector(".border-amber-500")
        ?.querySelector('[role="checkbox"]')
        ?.getAttribute("aria-label"),
    ).toBe("Select same.pdf");
    expect(dom.element.querySelector("mark")?.textContent).toBe("amount");
    expect(dom.element.querySelector("script")).toBeNull();
    expect(dom.element.textContent).toContain("In attachment same.pdf");
    expect(rpc.calls.mock.calls.some(([tag]) => tag === "AttachmentAction")).toBe(false);
  } finally {
    dom.dispose();
  }
});
