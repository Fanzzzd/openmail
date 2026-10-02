import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleBounds, windowStateFile } from "./window-state";
import type { SavedWindow } from "../shared/window-state";
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
it("persists the complete window set with bounds, draft target and space/folder/message selection", () => {
  const dir = mkdtempSync(join(tmpdir(), "openmail-windows-"));
  dirs.push(dir);
  const file = join(dir, "windows.json");
  const windows: SavedWindow[] = [
    {
      key: "main-1",
      kind: "main",
      bounds: { x: 100, y: 100, width: 1300, height: 800 },
      maximized: false,
      selection: {
        space: "profile:work",
        mailbox: "all",
        label: { id: "folder-2", accountId: "account-1" },
        messageId: "message-900",
      },
    },
    {
      key: "reader",
      kind: "message",
      target: "message-123",
      bounds: { x: 200, y: 100, width: 820, height: 860 },
      maximized: true,
    },
    {
      key: "compose",
      kind: "compose",
      target: "draft-1",
      bounds: { x: 300, y: 150, width: 760, height: 800 },
      maximized: false,
    },
  ];
  expect(windowStateFile(file).read()).toEqual([]);
  windowStateFile(file).write(windows);
  expect(windowStateFile(file).read()).toEqual(windows);
  windowStateFile(file).write(windows.slice(0, 1));
  expect(windowStateFile(file).read()).toEqual(windows.slice(0, 1));
  writeFileSync(file, '[{"kind":"not-a-window"}]');
  expect(windowStateFile(file).read()).toEqual([]);
});
it("keeps restored windows visible after a display is unplugged or resized", () => {
  const displays = [{ workArea: { x: 0, y: 24, width: 1440, height: 876 } }];
  expect(
    visibleBounds({ x: 2000, y: -600, width: 1800, height: 1000 }, displays, {
      width: 480,
      height: 400,
    }),
  ).toEqual(displays[0]?.workArea);
  expect(
    visibleBounds({ x: 1200, y: 500, width: 700, height: 500 }, displays, {
      width: 480,
      height: 400,
    }),
  ).toEqual({ x: 740, y: 400, width: 700, height: 500 });
});
