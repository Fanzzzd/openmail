import { afterEach, expect, it } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react/pure";
import { eventually, flow } from "./harness";

let current: Awaited<ReturnType<typeof flow>> | undefined;
afterEach(async () => {
  await current?.dispose();
  current = undefined;
});

async function openSettingsTab(tab: string) {
  current = await flow({ route: "/mail/all/inbox?dialog=settings" });
  // Settings is a lazy chunk; its first import in a cold jsdom run can take over a second.
  const settings = await screen.findByRole("dialog", { name: "Settings" });
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
    const editor = await screen.findByRole("dialog", { name: dialog });
    close(editor);
    await eventually(() => expect(screen.queryByRole("dialog", { name: dialog })).toBeNull());
    await eventually(() => expect(document.activeElement).toBe(button));
    expect(settings.contains(document.activeElement)).toBe(true);
  });
async function openNewSpaceIn(settings: HTMLElement) {
  fireEvent.click(await within(settings).findByRole("button", { name: "New space" }));
  return screen.findByRole("dialog", { name: "New space" });
}
const openNewSpace = async () => openNewSpaceIn(await openSettingsTab("Spaces"));

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

it("editing the space name clears a save error and the field's invalid state", async () => {
  const create = async (name: string) => {
    const editor = await openNewSpaceIn(settings);
    const field = within(editor).getByRole<HTMLInputElement>("textbox", {
      name: "Name, like Work",
    });
    fireEvent.change(field, { target: { value: name } });
    fireEvent.click(within(editor).getByRole("button", { name: "Create" }));
    return { editor, field };
  };
  const settings = await openSettingsTab("Spaces");
  const first = await create("Work");
  await eventually(() => expect(first.editor.isConnected).toBe(false));
  const { editor, field } = await create("Work");
  await eventually(() => expect(within(editor).getByRole("alert")).toBeTruthy());
  expect(field.getAttribute("aria-invalid")).toBe("true");
  expect(field.classList.contains("aria-invalid:border-a11y-danger")).toBe(true);
  fireEvent.change(field, { target: { value: "Work 2" } });
  expect(within(editor).queryByRole("alert")).toBeNull();
  expect(field.hasAttribute("aria-invalid")).toBe(false);
});

it("names each space color in words, not by its key", async () => {
  const editor = await openNewSpace();
  const colors = within(within(editor).getByRole("radiogroup", { name: "Color" })).getAllByRole(
    "radio",
  );
  expect(colors.map((color) => color.getAttribute("aria-label"))).toEqual([
    "Blue",
    "Purple",
    "Red",
    "Orange",
    "Brown",
    "Green",
    "Teal",
    "Gray",
  ]);
});

for (const kind of ["label", "folder"] as const)
  it(`deleting a ${kind} names it in the confirmation`, async () => {
    current = await flow({
      route: "/mail/all/inbox?dialog=settings",
      provider: kind === "label" ? "gmail" : "imap",
    });
    const settings = await screen.findByRole("dialog", { name: "Settings" });
    fireEvent.click(within(settings).getByRole("tab", { name: "Organize" }));
    fireEvent.click(await within(settings).findByRole("button", { name: "Delete Work" }));
    expect(
      await screen.findByRole("alertdialog", { name: `Delete the ${kind} “Work”?` }),
    ).toBeTruthy();
  });
