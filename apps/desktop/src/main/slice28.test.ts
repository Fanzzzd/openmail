import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { Schema } from "effect";
import { readDockFiles, DOCK_COMPOSE_LIMIT } from "./dock-files";
import {
  NativeAction,
  NATIVE_MENUS,
  nativeActionEnabled,
  nativeActionStroke,
} from "../shared/native-actions";
import { KEYMAP, matchesShortcut } from "../shared/shortcuts";
import { DesktopEvent, desktopEventRoute, shouldBufferDesktopEvent } from "../shared/desktop";

vi.mock("electron", () => ({
  app: new EventEmitter(),
  BrowserWindow: { getAllWindows: () => [] },
  Menu: {},
}));
import { spellingItems } from "./spellcheck";

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
    await writeFile(large, Buffer.alloc(DOCK_COMPOSE_LIMIT));
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
    for (const action of group.actions) {
      expect(Schema.decodeUnknownSync(NativeAction)(action)).toBe(action);
      for (const set of ["mimestream", "gmail", "apple"] as const) {
        const stroke = nativeActionStroke(set, action);
        expect(stroke).toEqual(KEYMAP[set][action][0]);
        if (stroke)
          expect(
            matchesShortcut(set, action, {
              key: stroke.key,
              metaKey: Boolean(stroke.cmd),
              ctrlKey: Boolean(stroke.control),
              altKey: Boolean(stroke.alt),
              shiftKey: Boolean(stroke.shift),
            }),
          ).toBe(true);
      }
    }
  const empty = { selected: false, composing: false, gmail: false };
  expect(nativeActionEnabled("reply", empty)).toBe(false);
  expect(nativeActionEnabled("sync", empty)).toBe(true);
  expect(nativeActionEnabled("reply", { ...empty, selected: true })).toBe(true);
  expect(nativeActionEnabled("important", { ...empty, selected: true })).toBe(false);
  expect(nativeActionEnabled("important", { ...empty, selected: true, gmail: true })).toBe(true);
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

it("spelling suggestions replace the misspelling, dictionary writes use the session, and the toggle persists", () => {
  const contents = {
    replaceMisspelling: vi.fn(),
    session: { addWordToSpellCheckerDictionary: vi.fn() },
  };
  const save = vi.fn();
  // IO seam: this test exercises the callbacks without loading an Electron process.
  const items = spellingItems(
    contents,
    { dictionarySuggestions: ["hello"], misspelledWord: "helo" },
    undefined,
    save,
  );
  items[0]?.click?.({ checked: false });
  items[1]?.click?.({ checked: false });
  items.find((item) => item.type === "checkbox")?.click?.({ checked: false });
  expect(contents.replaceMisspelling).toHaveBeenCalledWith("hello");
  expect(contents.session.addWordToSpellCheckerDictionary).toHaveBeenCalledWith("helo");
  expect(save).toHaveBeenCalledWith({ spellcheck: false });
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
  )(require("../../electron-builder.config.cjs"));
  expect(config.mac.extendInfo.CFBundleDocumentTypes).toEqual([
    {
      CFBundleTypeName: "Attachment",
      CFBundleTypeRole: "Viewer",
      LSHandlerRank: "None",
      LSItemContentTypes: ["public.data", "public.content"],
    },
  ]);
});
