// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { createElement as h } from "react";
import { I18nProvider } from "@lingui/react";
import { setupI18n } from "@lingui/core";
import { Effect } from "effect";
import type { SyncHealth } from "@openmail/core/schema";
import { SyncHealthCheck } from "./components/SyncHealth";

const fixture = vi.hoisted(() => {
  vi.resetModules();
  const calls: string[] = [];
  return { calls };
});
vi.mock("./state/mail", () => ({
  useRunMail: () => (effect: Effect.Effect<unknown>) => Effect.runPromise(effect),
  withMail: (
    invoke: (call: (tag: string) => Effect.Effect<SyncHealth>) => Effect.Effect<unknown>,
  ) =>
    invoke((tag) => {
      fixture.calls.push(tag);
      return Effect.succeed({
        provider: "gmail",
        accountDomainHash: "domain-hash",
        checkedAt: 1,
        cursorAgeMs: null,
        pendingOps: 2,
        folders: [
          {
            scope: "private@company.invalid",
            local: { total: 3, unread: 1, threads: 2 },
            server: { kind: "unavailable" },
            bodyCacheWindowDays: 30,
            headerWindow: null,
            cursorAgeMs: null,
            pendingOps: 2,
            verdict: "server unavailable",
          },
        ],
      });
    }),
}));
afterEach(() => {
  cleanup();
  fixture.calls.length = 0;
  vi.unstubAllGlobals();
});
it("account sync health is explicit, renders offline counts and copies a redacted report", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  const i18n = setupI18n({ locale: "en", messages: {} });
  render(h(I18nProvider, { i18n }, h(SyncHealthCheck, { accountId: "gmail:me@example.com" })));
  expect(fixture.calls).toEqual([]);
  fireEvent.click(screen.getByRole("button", { name: "Check sync health" }));
  await waitFor(() =>
    expect(screen.getAllByRole("cell", { name: "Server unavailable" })).toHaveLength(2),
  );
  expect(fixture.calls).toEqual(["SyncHealth"]);
  expect(screen.getByRole("cell", { name: "3 / 1 / 2" })).toBeTruthy();
  const report = screen.getByRole("textbox", { name: "Redacted report", hidden: true });
  expect(report.getAttribute("readonly")).not.toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Copy redacted report" }));
  await waitFor(() => expect(writeText).toHaveBeenCalledOnce());
  expect(writeText.mock.calls[0]?.[0]).toContain('"scope": "folder:1"');
  expect(writeText.mock.calls[0]?.[0]).not.toContain("@");
});

afterAll(() => {
  vi.doUnmock("./state/mail");
  vi.resetModules();
});
