import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { Schema } from "effect";
import { COMPOSE_ATTACHMENT_LIMIT } from "@openmail/core";
import { readDockFiles } from "./dock-files";
import {
  GO_MAILBOXES,
  goSpaceIndex,
  isGoMailbox,
  isGoSpace,
  NativeAction,
  NATIVE_MENUS,
  nativeMenuActions,
  nativeActionEnabled,
  nativeActionStroke,
  providerMenuState,
} from "../../shared/native-actions";
import {
  folderShortcut,
  historyShortcut,
  KEYMAP,
  matchesShortcut,
  spaceShortcut,
} from "../../shared/shortcuts";
import { DesktopEvent, desktopEventRoute, shouldBufferDesktopEvent } from "../../shared/desktop";
vi.mock("electron", () => ({
  app: new EventEmitter(),
  BrowserWindow: { getAllWindows: () => [] },
  Menu: {},
}));

it("Dock drops read bounded regular files and roundtrip as a deferred compose event", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "openmail-dock-"));
  try {
    const first = path.join(directory, "report.txt");
    const second = path.join(directory, "photo.png");
    await writeFile(first, "report");
    await writeFile(second, new Uint8Array([1, 2, 3]));
    const attachments = await readDockFiles([first, second]);
    expect(attachments.map((f) => f.filename)).toEqual(["report.txt", "photo.png"]);
    expect(Buffer.from(attachments[0]?.content ?? "", "base64").toString()).toBe("report");
    const event = Schema.decodeUnknownSync(DesktopEvent)({ _tag: "ComposeFiles", attachments });
    expect(desktopEventRoute(event, true)).toBe("defer");
    expect(shouldBufferDesktopEvent(event)).toBe(true);
    const folder = path.join(directory, "folder");
    await mkdir(folder);
    await expect(readDockFiles([folder])).rejects.toMatchObject({ reason: "notFile" });
    await expect(
      readDockFiles([path.join(directory, "missing-private-file.txt")]),
    ).rejects.toMatchObject({ reason: "unreadable", message: "unreadable" });
    const large = path.join(directory, "large.txt");
    await writeFile(large, Buffer.alloc(COMPOSE_ATTACHMENT_LIMIT));
    await expect(readDockFiles([first, large])).rejects.toMatchObject({ reason: "tooLarge" });
    await expect(readDockFiles(Array.from({ length: 257 }, () => first))).rejects.toMatchObject({
      reason: "tooMany",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("native mail menus share the keymap and selection/composer capability rules", () => {
  for (const group of NATIVE_MENUS)
    for (const action of nativeMenuActions(group)) {
      expect(Schema.decodeUnknownSync(NativeAction)(action)).toBe(action);
      for (const set of ["mimestream", "gmail", "apple"] as const) {
        const stroke = nativeActionStroke(set, action);
        const event = stroke && {
          key: stroke.key,
          metaKey: Boolean(stroke.cmd),
          ctrlKey: Boolean(stroke.control),
          altKey: Boolean(stroke.alt),
          shiftKey: Boolean(stroke.shift),
        };
        // Go menu keys are the window's folder and history keys, not keymap entries.
        if (isGoMailbox(action)) {
          expect(event && folderShortcut(set, event)).toBe(GO_MAILBOXES[action]);
          continue;
        }
        if (action === "goOverview" || action === "goAllAccounts" || isGoSpace(action)) {
          expect(event && spaceShortcut(event, set)).toEqual(
            action === "goOverview"
              ? { kind: "overview" }
              : action === "goAllAccounts"
                ? { kind: "all" }
                : { kind: "profile", index: goSpaceIndex(action) },
          );
          continue;
        }
        if (action === "goBack" || action === "goForward") {
          expect(event && historyShortcut(event)).toBe(action === "goBack" ? "back" : "forward");
          continue;
        }
        expect(stroke).toEqual(KEYMAP[set][action][0]);
        if (event) expect(matchesShortcut(set, action, event)).toBe(true);
      }
    }
  const empty = { selected: false, composing: false, important: false };
  expect(nativeActionEnabled("reply", empty)).toBe(false);
  expect(nativeActionEnabled("sync", empty)).toBe(true);
  expect(nativeActionEnabled("reply", { ...empty, selected: true })).toBe(true);
  expect(nativeActionEnabled("important", { ...empty, selected: true })).toBe(false);
  expect(nativeActionEnabled("important", { ...empty, selected: true, important: true })).toBe(
    true,
  );
  expect(nativeActionEnabled("bold", { ...empty, composing: true })).toBe(true);
  expect(nativeActionEnabled("send", empty)).toBe(false);
  expect(
    shouldBufferDesktopEvent({
      _tag: "NativeAction",
      action: "send",
      triggeredByAccelerator: false,
    }),
  ).toBe(false);
  expect(
    desktopEventRoute(
      { _tag: "NativeAction", action: "trash", triggeredByAccelerator: false },
      true,
    ),
  ).toBe("drop");
});

it("packaged macOS app accepts Dock files without becoming their default handler", () => {
  const require = createRequire(import.meta.url);
  const config = Schema.decodeUnknownSync(
    Schema.Struct({
      mac: Schema.Struct({
        extendInfo: Schema.Struct({
          CFBundleDocumentTypes: Schema.optionalKey(
            Schema.Array(
              Schema.Struct({
                CFBundleTypeName: Schema.String,
                CFBundleTypeRole: Schema.String,
                LSHandlerRank: Schema.String,
                LSItemContentTypes: Schema.Array(Schema.String),
              }),
            ),
          ),
        }),
      }),
    }),
  )(require("../../../electron-builder.config.cjs"));
  expect(config.mac.extendInfo.CFBundleDocumentTypes).toEqual([
    {
      CFBundleTypeName: "Attachment",
      CFBundleTypeRole: "Viewer",
      LSHandlerRank: "None",
      LSItemContentTypes: ["public.data", "public.content"],
    },
  ]);
});

it("the native menu offers Mark important and web links where the toolbar does", () => {
  const enabled = (provider: "gmail" | "outlook" | "imap" | undefined) => {
    const state = { selected: true, composing: false, ...providerMenuState(provider) };
    return [nativeActionEnabled("important", state), nativeActionEnabled("shareWebLink", state)];
  };
  expect(enabled("gmail")).toEqual([true, true]);
  expect(enabled("outlook")).toEqual([true, true]);
  expect(enabled("imap")).toEqual([false, false]);
  expect(enabled(undefined)).toEqual([false, false]);
});
