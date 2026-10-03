import { afterEach, expect, it } from "vitest";
import { fireEvent, screen } from "@testing-library/react/pure";
import { flow, eventually } from "./harness";
let current: Awaited<ReturnType<typeof flow>> | undefined;
afterEach(async () => {
  await current?.dispose();
  current = undefined;
});

it("label unnest drop zone appears only during its account drag and clears on cancel and drop", async () => {
  current = await flow();
  const h = current;
  await h.run(h.m.connect({ provider: "outlook" }));
  await eventually(() =>
    expect(screen.getByRole("button", { name: /me@outlook.com/ })).toBeTruthy(),
  );
  await eventually(() => expect(screen.getByRole("button", { name: "Work" })).toBeTruthy());
  expect(screen.queryByRole("button", { name: /No parent/ })).toBeNull();
  const data = new Map<string, string>();
  const dataTransfer = {
    types: [],
    setData: (type: string, value: string) => data.set(type, value),
    getData: (type: string) => data.get(type) ?? "",
    effectAllowed: "",
  };
  fireEvent.dragStart(screen.getByRole("button", { name: "Work" }), { dataTransfer });
  const zone = await screen.findByRole("button", { name: /No parent/ });
  expect(screen.getAllByRole("button", { name: /No parent/ })).toHaveLength(1);
  expect(zone.textContent).toContain("me@gmail.com");
  expect(zone.className).toContain("border-dashed");
  fireEvent.dragEnd(screen.getByRole("button", { name: "Work" }));
  expect(screen.queryByRole("button", { name: /No parent/ })).toBeNull();
  fireEvent.dragStart(screen.getByRole("button", { name: "Work" }), { dataTransfer });
  fireEvent.drop(await screen.findByRole("button", { name: /No parent/ }), { dataTransfer });
  expect(screen.queryByRole("button", { name: /No parent/ })).toBeNull();
  await eventually(() =>
    expect(h.requests.some((request) => request.tag === "ChangeLabel")).toBe(true),
  );
});

it("Shift+F10 opens a label menu that moves a nested label to the top level", async () => {
  current = await flow();
  const h = current;
  h.server.labels = [{ id: "Label_work", name: "Parent/Child", color: null }];
  await h.run(h.m.sync());
  await eventually(() => expect(screen.getByRole("button", { name: "Parent/Child" })).toBeTruthy());
  const label = screen.getByRole("button", { name: "Parent/Child" });
  label.focus();
  fireEvent.keyDown(label, { key: "F10", shiftKey: true });
  fireEvent.click(await screen.findByRole("menuitem", { name: "Move to top level" }));
  await eventually(() => expect(h.server.labels[0]?.name).toBe("Child"));
  await eventually(() => expect(screen.getByRole("button", { name: "Child" })).toBeTruthy());
  expect(screen.queryByRole("button", { name: /No parent/ })).toBeNull();
});

it("top-level labels have no Move to top level menu action", async () => {
  current = await flow();
  await eventually(() => expect(screen.getByRole("button", { name: "Work" })).toBeTruthy());
  const label = screen.getByRole("button", { name: "Work" });
  fireEvent.contextMenu(label);
  expect(screen.queryByRole("menuitem", { name: "Move to top level" })).toBeNull();
  label.focus();
  fireEvent.keyDown(label, { key: "F10", shiftKey: true });
  expect(screen.queryByRole("menuitem", { name: "Move to top level" })).toBeNull();
  expect(current.requests.some((request) => request.tag === "ChangeLabel")).toBe(false);
});
