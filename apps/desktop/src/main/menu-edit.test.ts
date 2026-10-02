import { expect, it, vi } from "vitest";
import { menuEdit } from "./menu-edit";
it("Undo/Select All route to native text editing while an input or composer is focused", async () => {
  const contents = {
    executeJavaScript: vi.fn<(code: string) => Promise<boolean>>(async () => true),
    undo: vi.fn(),
    selectAll: vi.fn(),
  };
  const appEdit = vi.fn();
  await menuEdit(contents, "undo", appEdit);
  await menuEdit(contents, "selectAll", appEdit);
  expect(contents.undo).toHaveBeenCalledOnce();
  expect(contents.selectAll).toHaveBeenCalledOnce();
  expect(appEdit).not.toHaveBeenCalled();
  expect(contents.executeJavaScript.mock.calls[0]?.[0]).toContain("contenteditable");
});
it("mail focus routes to app undo; a failed focus query never mutates mail", async () => {
  const contents = {
    executeJavaScript: vi.fn<(code: string) => Promise<boolean>>(async () => false),
    undo: vi.fn(),
    selectAll: vi.fn(),
  };
  const appEdit = vi.fn();
  await menuEdit(contents, "undo", appEdit);
  expect(appEdit).toHaveBeenCalledOnce();
  contents.executeJavaScript.mockRejectedValueOnce(new Error("renderer closed"));
  await menuEdit(contents, "undo", appEdit);
  expect(contents.undo).toHaveBeenCalledOnce();
  expect(appEdit).toHaveBeenCalledOnce();
});
