import { afterEach, expect, it } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react/pure";
import { eventually, flow } from "./harness";
import { scaledMs } from "../../../../../../packages/core/test-support/test-time.js";

let current: Awaited<ReturnType<typeof flow>> | undefined;
afterEach(async () => {
  await current?.dispose();
  current = undefined;
});

async function openSettingsTab(tab: string) {
  current = await flow({ route: "/mail/all/inbox?dialog=settings" });
  // Settings is a lazy chunk; its first import in a cold jsdom run can take over a second.
  const settings = await screen.findByRole(
    "dialog",
    { name: "Settings" },
    { timeout: scaledMs(5000) },
  );
  fireEvent.click(within(settings).getByRole("tab", { name: tab }));
  return settings;
}

for (const [tab, opener, dialog, how, close] of [
  [
    "Spaces",
    "New space",
    "New space",
    "Escape",
    (d: HTMLElement) => fireEvent.keyDown(d, { key: "Escape" }),
  ],
  [
    "Spaces",
    "New space",
    "New space",
    "Cancel",
    (d: HTMLElement) => fireEvent.click(within(d).getByRole("button", { name: "Cancel" })),
  ],
  [
    "Spaces",
    "New space",
    "New space",
    "Close window",
    () => void current?.event({ _tag: "CloseSheet" }),
  ],
  [
    "Organize",
    "New label or folder",
    "Label or folder",
    "Escape",
    (d: HTMLElement) => fireEvent.keyDown(d, { key: "Escape" }),
  ],
] as const)
  it(`closing ${dialog} from Settings with ${how} returns focus to ${opener}`, async () => {
    const settings = await openSettingsTab(tab);
    const button = await within(settings).findByRole("button", { name: opener });
    button.focus();
    fireEvent.click(button);
    const editor = await screen.findByRole("dialog", { name: dialog }, { timeout: scaledMs(5000) });
    close(editor);
    await eventually(() => expect(screen.queryByRole("dialog", { name: dialog })).toBeNull());
    await eventually(() => expect(document.activeElement).toBe(button));
    expect(settings.contains(document.activeElement)).toBe(true);
  });
