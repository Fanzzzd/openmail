import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { centeredBounds, visibleBounds, windowStateFile } from "./window-state";
import type { SavedWindow } from "../../shared/window-state";
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
it("persists the complete window set with bounds, draft target and space/folder/message route", () => {
  const dir = mkdtempSync(join(tmpdir(), "openmail-windows-"));
  dirs.push(dir);
  const file = join(dir, "windows.json");
  const windows: SavedWindow[] = [
    {
      key: "main-1",
      kind: "main",
      bounds: { x: 100, y: 100, width: 1300, height: 800 },
      maximized: false,
      href: "/mail/profile%3Awork/all?label=account-1%2Ffolder-2&thread=message-900",
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
  // Files from before routes saved the view as `selection`.
  const { href: _href, ...main } = windows[0]!;
  writeFileSync(
    file,
    JSON.stringify([
      {
        ...main,
        selection: {
          space: "profile:work",
          mailbox: "all",
          label: { id: "folder-2", accountId: "account-1" },
          messageId: "message-900",
        },
      },
    ]),
  );
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

it("a pop-out centres on its parent's display and shrinks to fit a small one", () => {
  // A secondary display to the right of the primary, with a menu bar inset.
  const secondary = { x: 1920, y: 25, width: 2560, height: 1415 };
  expect(centeredBounds({ width: 760, height: 800 }, secondary)).toEqual({
    x: 1920 + 900,
    y: 25 + 308,
    width: 760,
    height: 800,
  });
  // A display left of and above the primary has negative coordinates.
  const left = { x: -1280, y: -200, width: 1280, height: 776 };
  expect(centeredBounds({ width: 820, height: 860 }, left)).toEqual({
    x: -1280 + 230,
    y: -200,
    width: 820,
    height: 776,
  });
  const bounds = centeredBounds({ width: 820, height: 860 }, secondary);
  expect(bounds.x).toBeGreaterThanOrEqual(secondary.x);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(secondary.x + secondary.width);
});
