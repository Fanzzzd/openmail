import { act, createElement, useEffect, useState, type ReactNode } from "react";
import { expect, it, vi } from "vitest";
import { setupI18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { Effect, Stream } from "effect";
import { AsyncResult } from "effect/reactivity";
import type { AiEvent, AiTriage, ComposeBody } from "@openmail/core/schema";
import { DEFAULT_PREFS } from "@openmail/core/schema";
import { testDom } from "../../test-support/test-dom";

const aiQueries = vi.hoisted(() => ({ tags: new Array<string>() }));
const compose = vi.hoisted(() => ({ requests: new Array<unknown>(), truncated: false }));
const triage = vi.hoisted((): { row: AiTriage | null; decisions: unknown[] } => ({
  row: null,
  decisions: [],
}));

vi.mock("@effect/atom-react", async (original) => ({
  ...(await original<typeof import("@effect/atom-react")>()),
  useAtom: () => [AsyncResult.initial(), (input: unknown) => triage.decisions.push(input)],
  useAtomValue: (atom: string) =>
    AsyncResult.success(
      atom === "AiSettings"
        ? {
            model: "claude-sonnet-5-5",
            keyConfigured: true,
            accounts: [
              { accountId: "gmail:me", allowed: true, autoSummaries: false, autoTriage: true },
            ],
          }
        : atom === "AiTriage"
          ? triage.row
          : atom === "Labels"
            ? []
            : atom === "Prefs"
              ? DEFAULT_PREFS
              : null,
    ),
}));
vi.mock("../../state/rpc", () => ({
  MailClient: {
    query: (tag: string) => {
      aiQueries.tags.push(tag);
      return tag;
    },
    mutation: (tag: string) => tag,
  },
  submitAiKey: () => Effect.void,
}));
vi.mock("../../state/mail", () => ({
  useRunMail: () => Effect.runSync,
  withMail: (body: (call: (tag: string, payload?: unknown) => unknown) => unknown) =>
    body((tag, payload) =>
      tag === "Summarize"
        ? Stream.fromIterable<AiEvent>([
            { _tag: "Delta", text: "Incomplete result" },
            { _tag: "Done", model: "claude-sonnet-5-5", cached: false, truncated: true },
          ])
        : tag === "ComposeAi"
          ? (() => {
              compose.requests.push(payload);
              return Stream.fromIterable<AiEvent>([
                { _tag: "Delta", text: "Bob <img src=x onerror=alert(1)>" },
                {
                  _tag: "Done",
                  model: "claude-sonnet-5-5",
                  cached: false,
                  truncated: compose.truncated,
                },
              ]);
            })()
          : Effect.void,
    ),
}));
vi.mock("./Proposals", () => ({ Proposals: () => null }));
vi.mock("../../state/queries", () => ({ labelsAtom: () => "Labels", prefsAtom: "Prefs" }));
// The real Select is a Base UI popup, covered in ui-primitives.test.ts; here one button per option picks it.
vi.mock("../../ui/Select", () => ({
  Select: (props: {
    "aria-label": string;
    options: readonly { value: string; label: string }[];
    onValueChange: (value: string) => void;
  }) =>
    createElement(
      "div",
      { role: "group", "aria-label": props["aria-label"] },
      props.options.map((option) =>
        createElement(
          "button",
          {
            key: option.value,
            type: "button",
            "data-option": option.value,
            onClick: () => props.onValueChange(option.value),
          },
          option.label,
        ),
      ),
    ),
}));
vi.mock("../../ui/Dialog", () => ({
  Dialog: ({ children }: { children: ReactNode }) => createElement("section", null, children),
}));
import { AiOutput, Assistant, ThreadSummary } from "./AiPanel";
import { ComposerAi } from "../compose/components/ComposerAi";
import { TriageChip } from "./TriageChip";

const localize = (node: ReactNode) =>
  createElement(I18nProvider, { i18n: setupI18n({ locale: "en", messages: { en: {} } }) }, node);

it("reader displays a truncated summary with its token-limit warning", () => {
  const dom = testDom();
  try {
    dom.render(
      localize(createElement(ThreadSummary, { id: "gmail:me/m1", accountId: "gmail:me" })),
    );
    const summarize = dom.element.querySelector("button");
    if (!summarize) throw new Error("Missing Summarize button");
    act(() => summarize.click());
    expect(dom.element.textContent).toContain("Incomplete result");
    expect(dom.element.textContent).toContain("Output truncated at the token limit");
  } finally {
    dom.dispose();
  }
});

for (const platform of ["MacIntel", "Win32", "Linux x86_64"]) {
  it(`assistant shortcut label follows ${platform}`, () => {
    const dom = testDom();
    vi.stubGlobal("navigator", { platform });
    try {
      dom.render(
        localize(createElement(Assistant, { accounts: [], proposals: [], onOpenDraft: vi.fn() })),
      );
      const event = new dom.window.Event("keydown", { bubbles: true, cancelable: true });
      Object.assign(event, {
        key: "j",
        ctrlKey: platform !== "MacIntel",
        metaKey: platform === "MacIntel",
        altKey: false,
        shiftKey: false,
      });
      act(() => {
        dom.window.dispatchEvent(event);
      });
      const heading = dom.element.querySelector("h2")?.textContent;
      expect(heading).toContain(platform === "MacIntel" ? "⌘J" : "Ctrl+J");
      if (platform !== "MacIntel") expect(heading).not.toContain("⌘");
    } finally {
      dom.dispose();
    }
  });
}

for (const action of ["discard", "undo", "later typing", "unflushed typing"] as const) {
  it(`composer previews selection as text and handles ${action} without losing later edits`, () => {
    const dom = testDom();
    vi.stubGlobal("HTMLTextAreaElement", dom.window.HTMLTextAreaElement);
    const element = dom.window.document.createElement("textarea");
    element.value = "Hello Alice\nRegards";
    element.selectionStart = 6;
    element.selectionEnd = 11;
    compose.requests = [];
    compose.truncated = false;
    const before: ComposeBody = { kind: "plain", text: element.value };
    const onChange = vi.fn();
    let updateBody = (next: ComposeBody) => {
      element.value = next.text;
    };
    function Harness() {
      const [body, setBody] = useState(before);
      useEffect(() => {
        updateBody = setBody;
      }, []);
      return createElement(ComposerAi, {
        accountId: "gmail:me",
        replyTo: "gmail:me/m1",
        body,
        bodyRef: { current: element },
        selectionRef: { current: null },
        onChange: (next) => {
          onChange(next);
          setBody(next);
        },
      });
    }
    const click = (text: string) => {
      const button = [...dom.element.querySelectorAll("button")].find((item) =>
        item.textContent.startsWith(text),
      );
      if (!button) throw new Error(`Missing button ${text}`);
      act(() => button.click());
    };
    try {
      dom.render(localize(createElement(Harness)));
      const shortcut = new dom.window.Event("keydown", { bubbles: true, cancelable: true });
      Object.assign(shortcut, {
        key: "j",
        metaKey: true,
        ctrlKey: false,
        altKey: false,
        shiftKey: true,
      });
      act(() => {
        dom.window.dispatchEvent(shortcut);
      });
      const rewrite = dom.element.querySelector<HTMLButtonElement>(
        '[aria-label="AI action"] [data-option="rewrite"]',
      );
      if (!rewrite) throw new Error("Missing AI action selector");
      act(() => rewrite.click());
      click("Generate preview");
      expect(compose.requests).toEqual([
        {
          input: {
            accountId: "gmail:me",
            replyTo: "gmail:me/m1",
            text: "Alice",
            task: { kind: "rewrite", tone: "shorter" },
          },
        },
      ]);
      expect(dom.element.querySelector("del")?.textContent).toBe("Alice");
      expect(dom.element.querySelector("ins")?.textContent).toContain("Bob <img");
      expect(dom.element.querySelector("img")).toBeNull();
      expect(onChange).not.toHaveBeenCalled();
      expect(element.value).toBe(before.text);
      click(action === "discard" ? "Discard" : "Accept");
      if (action !== "discard") {
        expect(onChange).toHaveBeenLastCalledWith({
          kind: "plain",
          text: "Hello Bob <img src=x onerror=alert(1)>\nRegards",
        });
        if (action === "undo") {
          click("Undo AI edit");
          expect(onChange).toHaveBeenLastCalledWith(before);
        } else {
          element.value += "\nLater typing";
          if (action === "later typing")
            act(() => updateBody({ kind: "plain", text: element.value }));
          else click("Undo AI edit");
          expect(onChange).toHaveBeenCalledTimes(1);
          expect(element.value).toContain("Later typing");
          expect(
            [...dom.element.querySelectorAll("button")].some(
              (button) => button.textContent === "Undo AI edit",
            ),
          ).toBe(false);
        }
      } else expect(onChange).not.toHaveBeenCalled();
    } finally {
      dom.dispose();
    }
  });
}

for (const labels of [
  ["INBOX"],
  [],
  ["TRASH"],
  ["SPAM"],
  ["DRAFT"],
  ["INBOX", "TRASH"],
  ["INBOX", "SPAM"],
  ["INBOX", "DRAFT"],
]) {
  it(`triage shows the actual star action only for eligible inbox threads (${labels.join("+") || "archive"})`, () => {
    const dom = testDom();
    triage.row = {
      threadId: "gmail:me/t1",
      model: "claude-sonnet-5-5",
      inputHash: "hash",
      promptVersion: "triage-text-v2",
      text: "",
      action: { kind: "replyNeeded" },
      reason: "A reply is needed",
      status: "pending",
    };
    triage.decisions = [];
    try {
      dom.render(
        localize(createElement(TriageChip, { id: "gmail:me/m1", accountId: "gmail:me", labels })),
      );
      if (labels.length === 1 && labels[0] === "INBOX") {
        const button = dom.element.querySelector("button");
        expect(button?.textContent).toBe("Reply needed: add star");
        act(() => button?.click());
        const accept = [...dom.element.querySelectorAll("button")].find(
          (item) => item.textContent === "Accept",
        );
        act(() => accept?.click());
        expect(triage.decisions).toHaveLength(1);
        expect(triage.decisions[0]).toMatchObject({ payload: { id: "gmail:me/m1", accept: true } });
      } else expect(dom.element.textContent).toBe("");
    } finally {
      dom.dispose();
    }
  });
}

for (const hours of [1, 2]) {
  it(`snooze chip renders ${hours === 1 ? "singular" : "plural"} hours`, () => {
    const dom = testDom();
    triage.row = {
      threadId: "gmail:me/t1",
      model: "claude-sonnet-5-5",
      inputHash: "hash",
      promptVersion: "triage-text-v2",
      text: "",
      action: { kind: "snooze", hours },
      reason: "Later",
      status: "pending",
    };
    try {
      dom.render(
        localize(
          createElement(TriageChip, {
            id: "gmail:me/m1",
            accountId: "gmail:me",
            labels: ["INBOX"],
          }),
        ),
      );
      expect(dom.element.querySelector("button")?.textContent).toBe(
        `Snooze for ${hours} ${hours === 1 ? "hour" : "hours"}`,
      );
    } finally {
      dom.dispose();
    }
  });
}

it("AI answers render URLs and phone numbers as plain text", () => {
  const dom = testDom();
  try {
    const text =
      'Visit https://evil.example/pay or call +1 555 010 1234. <a href="https://evil.example">Pay</a>';
    dom.render(
      localize(
        createElement(AiOutput, {
          result: {
            text,
            sources: [],
            model: "",
            truncated: false,
            status: "done",
            start: vi.fn(),
            cancel: vi.fn(),
          },
          openSource: vi.fn(),
        }),
      ),
    );
    expect(dom.element.textContent).toContain(text);
    expect(dom.element.querySelectorAll("a")).toHaveLength(0);
  } finally {
    dom.dispose();
  }
});

it("unapproved reader never subscribes to summary or triage RPCs", () => {
  const dom = testDom();
  aiQueries.tags = [];
  try {
    dom.render(localize(createElement(ThreadSummary, { id: "other/m1", accountId: "other" })));
    dom.render(
      localize(
        createElement(TriageChip, { id: "other/m1", accountId: "other", labels: ["INBOX"] }),
      ),
    );
    expect(aiQueries.tags).not.toContain("AiSummary");
    expect(aiQueries.tags).not.toContain("AiTriage");
  } finally {
    dom.dispose();
  }
});
