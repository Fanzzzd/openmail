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

async function openNewSpace() {
  const settings = await openSettingsTab("Spaces");
  fireEvent.click(await within(settings).findByRole("button", { name: "New space" }));
  return screen.findByRole("dialog", { name: "New space" }, { timeout: scaledMs(5000) });
}

it("the checked space icon has its own ring in light and dark, apart from the unchecked tiles", async () => {
  const editor = await openNewSpace();
  const icons = within(within(editor).getByRole("radiogroup", { name: "Icon" })).getAllByRole(
    "radio",
  );
  const checked = icons.find((icon) => icon.getAttribute("aria-checked") === "true");
  if (!checked) throw new Error("No checked icon");
  // Checked tiles get a solid ring in each theme; at rest every tile has the same faint ring.
  for (const ring of ["data-checked:ring-neutral-900", "dark:data-checked:ring-white"])
    expect(checked.classList.contains(ring), ring).toBe(true);
  expect(checked.classList.contains("data-checked:ring-2")).toBe(true);
  expect(checked.classList.contains("dark:data-checked:ring-2")).toBe(true);
});
