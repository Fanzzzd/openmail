// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { createElement as h } from "react";
import { I18nProvider } from "@lingui/react";
import { setupI18n } from "@lingui/core";
import { Effect } from "effect";
import type { SyncHealth } from "@openmail/core/schema";
import { SyncHealthCheck } from "./SyncHealth";

const fixture = vi.hoisted(() => {
  vi.resetModules();
  const calls: string[] = [];
  const copied: string[] = [];
  return { calls, copied };
});
vi.mock("../../../state/mail", () => ({
  useRunMail: () => (effect: Effect.Effect<unknown>) => Effect.runPromise(effect),
  withMail: (
    invoke: (
      call: (tag: string, payload?: { text?: string }) => Effect.Effect<SyncHealth | void>,
    ) => Effect.Effect<unknown>,
  ) =>
    invoke((tag, payload) => {
      if (tag === "CopyText")
        return Effect.sync(() => void fixture.copied.push(payload?.text ?? ""));
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
  fixture.copied.length = 0;
});
it("account sync health is explicit, renders offline counts and copies a redacted report", async () => {
  const i18n = setupI18n({ locale: "en", messages: {} });
  render(
    h(
      I18nProvider,
      { i18n },
      h(SyncHealthCheck, { accountId: "gmail:me@example.com", email: "me@example.com" }),
    ),
  );
  // With two accounts there are two of these regions; the address tells them apart.
  expect(screen.getByRole("region", { name: "Sync health for me@example.com" })).toBeTruthy();
  expect(fixture.calls).toEqual([]);
  fireEvent.click(screen.getByRole("button", { name: "Check sync health" }));
  await waitFor(() =>
    expect(screen.getAllByRole("cell", { name: "Server unavailable" })).toHaveLength(2),
  );
  expect(fixture.calls).toEqual(["SyncHealth"]);
  expect(screen.getByRole("cell", { name: "3 / 1 / 2" })).toBeTruthy();
  const disclosure = screen.getByRole("button", { name: "Redacted report" });
  expect(disclosure.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(disclosure);
  const report = screen.getByRole("textbox", { name: "Redacted report" });
  expect(report.getAttribute("readonly")).not.toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Copy redacted report" }));
  await waitFor(() => expect(fixture.copied).toHaveLength(1));
  expect(fixture.copied[0]).toContain('"scope": "folder:1"');
  expect(fixture.copied[0]).not.toContain("@");
});

afterAll(() => {
  vi.doUnmock("../../../state/mail");
  vi.resetModules();
});
