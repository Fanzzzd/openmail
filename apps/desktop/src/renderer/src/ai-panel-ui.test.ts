import { act, createElement, type ReactNode } from "react";
import { expect, it, vi } from "vitest";
import { setupI18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { Effect, Stream } from "effect";
import { AsyncResult } from "effect/reactivity";
import type { AiEvent } from "@openmail/core/schema";
import { testDom } from "./test-dom";

vi.mock("@effect/atom-react", async (original) => ({
  ...(await original<typeof import("@effect/atom-react")>()),
  useAtomValue: (atom: string) =>
    AsyncResult.success(
      atom === "AiSettings"
        ? {
            model: "claude-sonnet-5-5",
            keyConfigured: true,
            accounts: [{ accountId: "gmail:me", allowed: true, autoSummaries: false }],
          }
        : null,
    ),
}));
vi.mock("./rpc", () => ({
  MailClient: { query: (tag: string) => tag, mutation: (tag: string) => tag },
  submitAiKey: () => Effect.void,
}));
vi.mock("./state/mail", () => ({
  useRunMail: () => Effect.runSync,
  withMail: (body: (call: (tag: string) => unknown) => unknown) =>
    body((tag) =>
      tag === "Summarize"
        ? Stream.fromIterable<AiEvent>([
            { _tag: "Delta", text: "Incomplete result" },
            { _tag: "Done", model: "claude-sonnet-5-5", cached: false, truncated: true },
          ])
        : Effect.void,
    ),
}));
vi.mock("./components/Proposals", () => ({ Proposals: () => null }));
vi.mock("./components/ui/Dialog", () => ({
  Dialog: ({ children }: { children: ReactNode }) => createElement("section", null, children),
}));
import { Assistant, ThreadSummary } from "./components/AiPanel";

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
