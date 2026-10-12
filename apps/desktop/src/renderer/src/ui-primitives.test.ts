// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { createElement as h, useState, type ReactNode } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setupI18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";

import { ConfirmHost, confirmDialog, confirmOpen } from "./components/ui/Confirm";
import { Disclosure } from "./components/ui/Disclosure";
import { Select } from "./components/ui/Select";
import { ProgressBar } from "./components/ui/Progress";

afterEach(cleanup);
const localized = (node: ReactNode) =>
  h(I18nProvider, { i18n: setupI18n({ locale: "en", messages: { en: {} } }) }, node);

function Picker() {
  const [value, setValue] = useState<"daily" | "weekly" | "monthly">("daily");
  return h(
    "div",
    null,
    h(Select<"daily" | "weekly" | "monthly">, {
      "aria-label": "Repeat",
      value,
      options: [
        { value: "daily", label: "Daily" },
        { value: "weekly", label: "Weekly" },
        { value: "monthly", label: "Monthly" },
      ],
      onValueChange: setValue,
    }),
    h("output", { role: "status" }, value),
  );
}

it("Select opens from the keyboard, moves with arrows, picks with Enter and returns focus", async () => {
  const user = userEvent.setup();
  render(localized(h(Picker)));
  const trigger = screen.getByRole("combobox", { name: "Repeat" });
  expect(trigger.textContent).toContain("Daily");
  trigger.focus();
  await user.keyboard("{ArrowDown}");
  const list = await screen.findByRole("listbox");
  expect(list).toBeTruthy();
  await waitFor(() => expect(document.activeElement?.getAttribute("role")).toBe("option"));
  await user.keyboard("{ArrowDown}");
  await waitFor(() => expect(document.activeElement?.textContent).toContain("Weekly"));
  await user.keyboard("{Enter}");
  await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
  expect(screen.getByRole("status", { hidden: true }).textContent).toBe("weekly");
  expect(trigger.textContent).toContain("Weekly");
  expect(document.activeElement).toBe(trigger);

  await user.keyboard("{Enter}");
  await screen.findByRole("listbox");
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
  expect(screen.getByRole("status", { hidden: true }).textContent).toBe("weekly");
  expect(document.activeElement).toBe(trigger);
});

it("Disclosure is a button with aria-expanded; Enter and Space toggle its panel", async () => {
  const user = userEvent.setup();
  render(h(Disclosure, { summary: "More conditions", children: h("p", null, "Hidden content") }));
  const button = screen.getByRole("button", { name: "More conditions" });
  expect(button.getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByText("Hidden content")).toBeNull();
  button.focus();
  await user.keyboard("{Enter}");
  expect(button.getAttribute("aria-expanded")).toBe("true");
  const panel = document.getElementById(button.getAttribute("aria-controls") ?? "");
  expect(panel?.textContent).toBe("Hidden content");
  await user.keyboard(" ");
  expect(button.getAttribute("aria-expanded")).toBe("false");
});

it("ProgressBar exposes value and range to assistive technology", () => {
  render(h(ProgressBar, { value: 25, max: 200, "aria-label": "Model download progress" }));
  const bar = screen.getByRole("progressbar", { name: "Model download progress" });
  expect(bar.getAttribute("aria-valuenow")).toBe("25");
  expect(bar.getAttribute("aria-valuemax")).toBe("200");
});

it("confirmDialog replaces window.confirm: Cancel has focus, Escape cancels, confirm resolves true", async () => {
  const user = userEvent.setup();
  const opener = document.createElement("button");
  opener.textContent = "Send";
  document.body.append(opener);
  opener.focus();
  render(localized(h(ConfirmHost)));

  let first!: Promise<boolean>;
  act(() => {
    first = confirmDialog({ title: "Send this message again?", confirmLabel: "Send" });
  });
  const dialog = await screen.findByRole("alertdialog", { name: "Send this message again?" });
  await waitFor(() =>
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" })),
  );
  expect(dialog).toBeTruthy();
  await user.keyboard("{Escape}");
  expect(await first).toBe(false);
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(opener));

  let second!: Promise<boolean>;
  let third!: Promise<boolean>;
  act(() => {
    second = confirmDialog({ title: "First?", confirmLabel: "Yes" });
    third = confirmDialog({ title: "Second?", confirmLabel: "Delete", destructive: true });
  });
  await user.click(await screen.findByRole("button", { name: "Yes" }));
  expect(await second).toBe(true);
  // Queued confirmations show one at a time.
  await screen.findByRole("alertdialog", { name: "Second?" });
  await user.click(screen.getByRole("button", { name: "Delete" }));
  expect(await third).toBe(true);
  expect(confirmOpen()).toBe(false);

  // The quit prompt reports when it has painted, and the main process can withdraw it.
  const controller = new AbortController();
  let shown = false;
  let withdrawn!: Promise<boolean>;
  act(() => {
    withdrawn = confirmDialog({
      title: "Quit?",
      confirmLabel: "Quit",
      signal: controller.signal,
      onShown: () => {
        shown = true;
      },
    });
  });
  expect(confirmOpen()).toBe(true);
  await waitFor(() => expect(shown).toBe(true));
  act(() => controller.abort());
  expect(await withdrawn).toBe(false);
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(confirmOpen()).toBe(false);
  opener.remove();
});
