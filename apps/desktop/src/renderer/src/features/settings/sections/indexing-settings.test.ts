// @vitest-environment jsdom
import { setupI18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import type { IndexingProgress } from "@openmail/core/schema";
import { cleanup, render, screen } from "@testing-library/react";
import { AsyncResult } from "effect/reactivity";
import { createElement as h, type ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ progress: null as unknown }));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => AsyncResult.success(state.progress),
  useAtomSet: () => vi.fn(),
}));
vi.mock("../../../state/queries", () => ({ indexingProgressAtom: "indexing" }));
vi.mock("../../../state/rpc", () => ({ MailClient: { mutation: (tag: string) => tag } }));

import { IndexingSettings } from "./IndexingSettings";

afterEach(cleanup);

const localized = (node: ReactNode) =>
  h(I18nProvider, { i18n: setupI18n({ locale: "en", messages: { en: {} } }) }, node);
const progress: IndexingProgress = {
  available: true,
  paused: false,
  onBattery: false,
  queued: 0,
  running: 0,
  done: 0,
  failed: 0,
  pipelineVersion: "test",
  modelsEnabled: false,
};

it("on an Intel Mac the model switch is off and disabled, and says it needs Apple silicon", () => {
  state.progress = { ...progress, modelsSupported: false };
  render(localized(h(IndexingSettings)));
  const toggle = screen.getByRole("switch", { name: "Download on-device models, ~226 MB" });
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  expect(toggle.hasAttribute("disabled") || toggle.getAttribute("aria-disabled") === "true").toBe(
    true,
  );
  expect(screen.getByText(/needs a Mac with Apple silicon/)).toBeTruthy();
});

it("on Apple silicon the switch works and the Intel line is absent", () => {
  state.progress = progress;
  render(localized(h(IndexingSettings)));
  const toggle = screen.getByRole("switch", { name: "Download on-device models, ~226 MB" });
  expect(toggle.hasAttribute("disabled") || toggle.getAttribute("aria-disabled") === "true").toBe(
    false,
  );
  expect(screen.queryByText(/Apple silicon/)).toBeNull();
});
