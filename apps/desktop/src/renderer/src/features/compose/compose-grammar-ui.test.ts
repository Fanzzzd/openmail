import { setupI18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { Effect } from "effect";
import { AsyncResult } from "effect/reactivity";
import { act, createElement } from "react";
import { expect, it, vi } from "vitest";
import type { GrammarIssue } from "../../../../shared/native-compose";
import { GrammarResults, useComposeGrammar } from "./components/ComposeGrammar";
import { testDom } from "../../test-support/test-dom";

const state = vi.hoisted(() => {
  vi.resetModules();
  return {
    requests: new Array<{ text: string }>(),
    answers: new Array<(issues: readonly GrammarIssue[]) => void>(),
  };
});
vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => AsyncResult.success({ grammar: true }),
}));
vi.mock("../../state/queries", () => ({ nativeComposeCapabilitiesAtom: "native-compose" }));
vi.mock("../../state/mail", () => ({
  useRunMail: () => (effect: Effect.Effect<unknown>) => {
    void Effect.runPromise(effect);
  },
  withMail: (
    f: (
      call: (name: string, payload: { text: string }) => Effect.Effect<readonly GrammarIssue[]>,
    ) => Effect.Effect<unknown>,
  ) =>
    f((_name, payload) => {
      state.requests.push(payload);
      return Effect.promise(
        () =>
          new Promise<readonly GrammarIssue[]>((resolve) => {
            state.answers.push(resolve);
          }),
      );
    }),
}));

/** The composer's "More formatting" item, reduced to a button, above the results. */
function Grammar(props: Parameters<typeof useComposeGrammar>[0]) {
  const grammar = useComposeGrammar(props);
  return createElement(
    "div",
    null,
    createElement(
      "button",
      { type: "button", disabled: grammar.disabled, onClick: grammar.check },
      "Check grammar on this Mac",
    ),
    createElement(GrammarResults, { grammar, locked: props.locked }),
  );
}

it("grammar is user-triggered, discards late results, selects UTF-16 ranges, and never changes text automatically", async () => {
  state.requests.length = 0;
  state.answers.length = 0;
  const dom = testDom();
  vi.stubGlobal("HTMLDivElement", dom.window.HTMLDivElement);
  vi.stubGlobal("HTMLTextAreaElement", dom.window.HTMLTextAreaElement);
  const textarea = dom.window.document.createElement("textarea");
  dom.window.document.body.append(textarea);
  const select = vi.fn();
  Object.assign(textarea, { setSelectionRange: select });
  const onChange = vi.fn();
  const i18n = setupI18n({ locale: "en", messages: {} });
  const render = (text: string) => {
    textarea.value = text;
    dom.render(
      createElement(
        I18nProvider,
        { i18n },
        createElement(Grammar, {
          body: { kind: "plain", text },
          bodyRef: { current: textarea },
          onChange,
          locked: false,
        }),
      ),
    );
  };
  const click = (text: string) => {
    const button = [...dom.element.querySelectorAll("button")].find(
      (item) => item.textContent === text,
    );
    if (!button) throw new Error(`Missing button: ${text}`);
    act(() => {
      button.dispatchEvent(new dom.window.Event("click", { bubbles: true }));
    });
  };
  try {
    render("😀 He are here.");
    expect(state.requests).toEqual([]);
    click("Check grammar on this Mac");
    await act(async () => {
      await Promise.resolve();
    });
    expect(state.requests).toEqual([{ text: "😀 He are here." }]);
    render("😀 He is here.");
    await act(async () => {
      state.answers.shift()?.([
        { start: 6, end: 9, description: "Agreement", suggestions: ["is"] },
      ]);
    });
    expect(dom.element.textContent).not.toContain("Agreement");
    expect(onChange).not.toHaveBeenCalled();
    render("😀 He are here.");
    click("Check grammar on this Mac");
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      state.answers.shift()?.([
        { start: 6, end: 9, description: "Agreement", suggestions: ["is"] },
      ]);
    });
    expect(dom.element.textContent).toContain("Agreement");
    expect(dom.element.querySelector(".underline")?.textContent).toBe("are");
    click("are");
    expect(select).toHaveBeenCalledWith(6, 9);
    expect(textarea.value).toBe("😀 He are here.");
    expect(onChange).not.toHaveBeenCalled();
    render("Changed again");
    expect(dom.element.textContent).not.toContain("Agreement");
    expect(state.requests).toHaveLength(2);
  } finally {
    dom.dispose();
  }
});
