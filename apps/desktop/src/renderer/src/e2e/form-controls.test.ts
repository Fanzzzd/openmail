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
  const settings = await screen.findByRole("dialog", { name: "Settings" });
  fireEvent.click(within(settings).getByRole("tab", { name: tab }));
  return settings;
}

const prefsPatches = () =>
  (current?.requests ?? [])
    .filter((request) => request.tag === "SetPrefs")
    .map((request) => JSON.stringify(request.payload));

it("an on/off setting is a switch; a click on its label saves the new value", async () => {
  const settings = await openSettingsTab("Reading");
  const toolbar = await within(settings).findByRole("switch", { name: "Show toolbar" });
  await eventually(() => expect(toolbar.getAttribute("aria-checked")).toBe("true"));
  fireEvent.click(within(settings).getByText("Show toolbar"));
  await eventually(() =>
    expect(prefsPatches().some((patch) => patch.includes('"toolbarVisible":false'))).toBe(true),
  );
  await eventually(() => expect(toolbar.getAttribute("aria-checked")).toBe("false"));
  // Space on the focused switch turns it back on.
  toolbar.focus();
  fireEvent.keyDown(toolbar, { key: " " });
  fireEvent.keyUp(toolbar, { key: " " });
  await eventually(() =>
    expect(prefsPatches().some((patch) => patch.includes('"toolbarVisible":true'))).toBe(true),
  );
});
