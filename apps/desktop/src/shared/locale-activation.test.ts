import { expect, it, vi } from "vitest";
import { setupI18n, type Messages } from "@lingui/core";
import { createLocaleActivator } from "./locale-activation";
import type { Locale } from "./locales";

it("only the selected catalog loads, activation waits, and stale imports cannot change the language", async () => {
  const i18n = setupI18n();
  const ready = new Map<Locale, (messages: Messages) => void>();
  const load = vi.fn(
    (locale: Locale) =>
      new Promise<Messages>((resolve) => {
        ready.set(locale, resolve);
      }),
  );
  const activated = vi.fn();
  const activate = createLocaleActivator(i18n, load, activated);
  const first = activate("de");
  expect(i18n.locale).toBe("");
  expect(activated).not.toHaveBeenCalled();
  const second = activate("ja");
  ready.get("ja")?.({ hello: "こんにちは" });
  expect(await second).toBe(true);
  expect(i18n.locale).toBe("ja");
  ready.get("de")?.({ hello: "Hallo" });
  expect(await first).toBe(false);
  expect(i18n._("hello")).toBe("こんにちは");
  expect(load.mock.calls.map(([locale]) => locale)).toEqual(["de", "ja"]);
  expect(activated.mock.calls).toEqual([["ja"]]);
});
