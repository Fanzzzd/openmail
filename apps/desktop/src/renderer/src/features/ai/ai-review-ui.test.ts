import { createElement, type ReactNode } from "react";
import { expect, it, vi } from "vitest";
import { setupI18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { Effect } from "effect";
import { AsyncResult } from "effect/reactivity";
import type { Account, Proposal } from "../../../../shared/api";
import { testDom } from "../../test-support/test-dom";

vi.mock("@effect/atom-react", async (original) => ({
  ...(await original<typeof import("@effect/atom-react")>()),
  useAtom: () => [AsyncResult.success(undefined), vi.fn()],
  useAtomValue: (atom: string) =>
    AsyncResult.success(
      atom === "labels"
        ? [{ accountId: "gmail:me", id: "Label_1", name: "Receipts for tax", color: null }]
        : [{ id: "source", accountId: "gmail:me", subject: "Original approval request" }],
    ),
}));
vi.mock("../../state/queries", () => ({ threadAtom: () => "thread", labelsAtom: () => "labels" }));
vi.mock("../../state/mutations", () => ({ decideAtom: () => "decide" }));
vi.mock("../../state/mail", () => ({
  useRunMail: () => Effect.runSync,
  withMail: () => Effect.void,
}));
vi.mock("../../ui/Dialog", () => ({
  Dialog: ({ children }: { children: ReactNode }) => createElement("section", null, children),
}));
import { Proposals } from "./Proposals";

const account: Account = {
  id: "gmail:me",
  provider: "gmail",
  email: "me@example.com",
  createdAt: 0,
  lastSyncedAt: null,
  lastSyncError: null,
  profileId: null,
  needsReauth: false,
};
const base = {
  id: 1,
  createdAt: 0,
  status: "pending",
  actor: { kind: "agent", surface: "rule", name: "openmail-assistant" },
} as const;
const render = (proposal: Proposal) => {
  const dom = testDom();
  // React initializes textareas through defaultValue. Linkedom lacks the native
  // reflection to textContent that browsers provide, so supply it in this harness.
  const prototype = dom.window.HTMLTextAreaElement.prototype;
  const original = Object.getOwnPropertyDescriptor(prototype, "defaultValue");
  Object.defineProperty(prototype, "defaultValue", {
    configurable: true,
    get(this: HTMLTextAreaElement) {
      return this.textContent;
    },
    set(this: HTMLTextAreaElement, value: string) {
      this.textContent = value;
    },
  });
  dom.render(
    createElement(
      I18nProvider,
      { i18n: setupI18n({ locale: "en", messages: { en: {} } }) },
      createElement(Proposals, {
        accounts: [account],
        proposals: [proposal],
        onClose: vi.fn(),
        onOpenDraft: vi.fn(),
      }),
    ),
  );
  return {
    ...dom,
    dispose() {
      dom.dispose();
      if (original) Object.defineProperty(prototype, "defaultValue", original);
      else Reflect.deleteProperty(prototype, "defaultValue");
    },
  };
};

for (const mode of ["reply", "replyAll", "forward"] as const) {
  it(`draft approval displays all recipients, ${mode}, reply target and the entire body`, () => {
    const body = `First paragraph\n${"Long body\n".repeat(40)}Final paragraph with an important condition`;
    const dom = render({
      ...base,
      command: {
        kind: "draft",
        accountId: account.id,
        message: {
          from: { name: "Sender alias", address: "alias@example.com" },
          to: [{ name: "To", address: "to@example.com" }],
          cc: [{ name: "Cc", address: "cc@example.com" }],
          bcc: [{ name: "Bcc", address: "bcc@example.com" }],
          subject: "Draft subject",
          text: body,
          mode,
          inReplyTo: "source",
          attachments: [],
        },
      },
    });
    try {
      const text = dom.element.textContent;
      for (const value of [
        "alias@example.com",
        "to@example.com",
        "cc@example.com",
        "bcc@example.com",
        "Original approval request",
        mode === "replyAll" ? "Reply all" : mode === "reply" ? "Reply" : "Forward",
      ])
        expect(text).toContain(value);
      const preview = dom.element.querySelector("textarea");
      expect(preview?.getAttribute("aria-label")).toBe("Draft body");
      expect(preview?.value).toBe(body);
      expect(preview?.getAttributeNames().map((name) => name.toLowerCase())).toContain("readonly");
      expect(preview?.className).toContain("overflow-y-auto");
      expect(preview?.className).not.toContain("line-clamp");
    } finally {
      dom.dispose();
    }
  });
}

it("label approval names the actual account label", () => {
  const dom = render({
    ...base,
    command: {
      kind: "modify",
      threads: ["source"],
      op: { kind: "label", labelId: "Label_1", value: true },
    },
  });
  try {
    expect(dom.element.textContent).toContain("Receipts for tax");
  } finally {
    dom.dispose();
  }
});

for (const surface of ["mcp", "rule"] as const) {
  it(`${surface} proposals show the trusted surface beside the self-reported assistant name`, () => {
    const dom = render({
      ...base,
      actor: { kind: "agent", surface, name: "openmail-assistant" },
      command: {
        kind: "draft",
        accountId: account.id,
        message: { to: [], cc: [], bcc: [], subject: "s", text: "t", attachments: [] },
      },
    });
    try {
      expect(dom.element.textContent).toContain(
        `${surface === "mcp" ? "MCP" : "Rule"} · openmail-assistant`,
      );
      const actions = Array.from(dom.element.querySelectorAll("button")).map(
        (button) => button.textContent,
      );
      expect(actions).toContain(surface === "mcp" ? "Review and send" : "Approve and edit");
      expect(actions).not.toContain(surface === "mcp" ? "Approve and edit" : "Review and send");
    } finally {
      dom.dispose();
    }
  });
}

it("snooze and reply approvals show the localized time and subject, never raw ids or epochs", () => {
  const due = Date.UTC(2026, 9, 14, 9, 30);
  const snooze = render({
    ...base,
    command: { kind: "snooze", threads: ["source"], due },
  });
  try {
    const text = snooze.element.textContent;
    expect(text).not.toContain(String(due));
    expect(text).toContain(
      `Until ${new Date(due).toLocaleString("en", { dateStyle: "medium", timeStyle: "short" })}`,
    );
  } finally {
    snooze.dispose();
  }
  const reply = render({
    ...base,
    command: {
      kind: "draft",
      accountId: account.id,
      message: {
        to: [{ name: "", address: "to@example.com" }],
        cc: [],
        bcc: [],
        subject: "s",
        text: "t",
        mode: "reply",
        inReplyTo: "source",
        attachments: [],
      },
    },
  });
  try {
    expect(reply.element.textContent).toContain("Original approval request");
    expect(reply.element.textContent).not.toContain("[source]");
  } finally {
    reply.dispose();
  }
});

it("proposal times keep the locale's hour cycle without a padded hour", () => {
  const createdAt = new Date(2026, 9, 14, 9, 5).getTime();
  const dom = render({
    ...base,
    createdAt,
    command: { kind: "snooze", threads: ["source"], due: createdAt },
  });
  try {
    expect(dom.element.textContent).toContain(
      new Date(createdAt).toLocaleString("en", {
        month: "numeric",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      }),
    );
    expect(dom.element.textContent).not.toMatch(/\b09:05\b/);
  } finally {
    dom.dispose();
  }
});
