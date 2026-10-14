// @vitest-environment jsdom
import { setupI18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Effect } from "effect";
import { createElement as h, type ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";

const calls: string[] = [];
let addFails = true;
// Counted when the effect runs, not when it is built, like a real RPC.
const call = (tag: string) => Effect.suspend(() => answer(tag));
const answer = (tag: string) => {
  calls.push(tag);
  if (tag === "InspectAttachment")
    return Effect.succeed({
      kind: "contacts",
      contacts: [{ name: "Ada", address: "ada@example.com" }],
    });
  return addFails ? Effect.fail(new Error("no")) : Effect.void;
};
// One run function, as the real hook returns: the dialog's inspect effect depends on it.
const run = (effect: Effect.Effect<unknown>) => void Effect.runPromise(effect);
vi.mock("../../../state/mail", () => ({
  useRunMail: () => run,
  withMail: (body: (c: typeof call) => Effect.Effect<unknown, unknown>) => body(call),
}));

import { AttachmentImportDialog } from "./AttachmentImportDialog";

vi.stubGlobal("matchMedia", (query: string) => ({
  matches: false,
  media: query,
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
}));

afterEach(cleanup);
const localized = (node: ReactNode) =>
  h(I18nProvider, { i18n: setupI18n({ locale: "en", messages: { en: {} } }) }, node);

it("keeps focus on an add button after it runs, and clears a failure once a retry works", async () => {
  render(
    localized(
      h(AttachmentImportDialog, {
        messageId: "m",
        file: {
          path: [0],
          filename: "ada.vcf",
          mimeType: "text/vcard",
          size: 10,
          embedded: false,
          decodeError: false,
        },
        onClose: () => null,
      }),
    ),
  );
  const add = await screen.findByRole("button", { name: "Add to Contacts" });
  add.focus();
  fireEvent.click(add);
  await screen.findByRole("alert");
  addFails = false;
  fireEvent.click(screen.getByRole("button", { name: "Add to Contacts" }));
  const added = await screen.findByRole("button", { name: "Added" });
  // A disabled button would drop focus to the page; aria-disabled keeps it here.
  expect(document.activeElement).toBe(added);
  expect(added.getAttribute("aria-disabled")).toBe("true");
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  // A second press does nothing.
  fireEvent.click(added);
  expect(calls.filter((tag) => tag === "AddAppleContact")).toHaveLength(2);
});
