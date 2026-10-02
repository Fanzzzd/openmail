import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Effect } from "effect";
import { beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => {
  const closed: { callback?: () => void } = {};
  return {
    calls: new Array<{ binary: string; args: string[] }>(),
    output: "[]",
    error: false,
    items: new Array<{ label: string; click: () => void }>(),
    choose: 0,
    menuFails: false,
    closeBeforePick: false,
    parentClosed: false,
    closed,
  };
});
vi.mock("electron", () => ({
  app: { isPackaged: false },
  BrowserWindow: class {
    isDestroyed() {
      return state.parentClosed;
    }
    once(_event: string, callback: () => void) {
      state.closed.callback = callback;
    }
    removeListener() {
      delete state.closed.callback;
    }
  },
  Menu: {
    buildFromTemplate: (items: { label: string; click: () => void }[]) => {
      state.items = items;
      return {
        popup: (options: { callback: () => void }) => {
          if (state.menuFails) throw new Error("menu failed");
          if (state.closeBeforePick) {
            state.parentClosed = true;
            state.closed.callback?.();
          }
          state.items[state.choose]?.click();
          options.callback();
        },
      };
    },
  },
}));
vi.mock("node:child_process", () => ({
  execFile: (
    binary: string,
    args: string[],
    _options: unknown,
    callback: (error: Error | null, output: string) => void,
  ) => {
    state.calls.push({ binary, args });
    callback(state.error ? new Error("helper failed") : null, state.output);
  },
}));
import { BrowserWindow } from "electron";
import {
  registeredAttachmentApps,
  openAttachmentWith,
  validatedAttachmentApps,
  attachmentAppLabels,
  chooseAttachmentApp,
} from "./attachment-apps";
beforeEach(() => {
  state.calls = [];
  state.error = false;
  state.output = "[]";
  state.choose = 0;
  state.menuFails = false;
  state.closeBeforePick = false;
  state.parentClosed = false;
});
it("Launch Services output uses separate execFile arguments and only trusted real bundles", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "om-apps-"));
  try {
    const application = path.join(root, "Reader ' $(touch sentinel).app");
    await mkdir(application);
    const file = "/tmp/private/-strange ' $(touch sentinel).pdf";
    state.output = JSON.stringify([application, application, "relative.app", "/tmp/launcher.sh"]);
    expect(await Effect.runPromise(registeredAttachmentApps(file, [root]))).toEqual([application]);
    expect(state.calls[0]?.args).toEqual([file]);
    await Effect.runPromise(openAttachmentWith(application, file, [root]));
    expect(state.calls[1]).toEqual({
      binary: "/usr/bin/open",
      args: ["-a", application, "--", file],
    });
    await rm(application, { recursive: true });
    await symlink(root, application);
    expect(
      (await Effect.runPromise(Effect.flip(openAttachmentWith(application, file, [root]))))._tag,
    ).toBe("DeviceError");
    expect(state.calls).toHaveLength(2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it("file bundles, bundle symlinks, symlink parents and outside roots are filtered out", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "om-trusted-apps-"));
  try {
    const root = path.join(directory, "Applications"),
      outside = path.join(directory, "Downloads");
    await mkdir(root);
    await mkdir(outside);
    const good = path.join(root, "Good.app"),
      file = path.join(root, "File.app"),
      alias = path.join(root, "Alias.app"),
      bad = path.join(outside, "Bad.app");
    await mkdir(good);
    await writeFile(file, "not a directory");
    await symlink(good, alias);
    await mkdir(bad);
    await symlink(outside, path.join(root, "Escape"));
    expect(
      await validatedAttachmentApps(
        [good, file, alias, bad, path.join(root, "Escape", "Bad.app")],
        [root],
      ),
    ).toEqual([good]);
    expect(await validatedAttachmentApps([good])).toEqual([]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
it("duplicate names show their paths; choosing and cancelling a menu return only its selected path", async () => {
  const apps = ["/Applications/Reader.app", "/System/Applications/Reader.app"];
  expect(attachmentAppLabels(apps)).toEqual(apps.map((application) => `Reader (${application})`));
  state.choose = 1;
  expect(await Effect.runPromise(chooseAttachmentApp(apps, null))).toBe(apps[1]);
  expect(state.items.map((item) => item.label)).toEqual(attachmentAppLabels(apps));
  state.choose = -1;
  expect(await Effect.runPromise(chooseAttachmentApp(apps, null))).toBeUndefined();
  state.menuFails = true;
  expect((await Effect.runPromise(Effect.flip(chooseAttachmentApp(apps, null))))._tag).toBe(
    "DeviceError",
  );
});
it("malformed helper output and helper failures remain typed device errors", async () => {
  state.output = '{"unexpected":true}';
  expect(
    (await Effect.runPromise(Effect.flip(registeredAttachmentApps("/tmp/file.pdf"))))._tag,
  ).toBe("DeviceError");
  state.error = true;
  expect(
    (await Effect.runPromise(Effect.flip(registeredAttachmentApps("/tmp/file.pdf"))))._tag,
  ).toBe("DeviceError");
});

it("closing the parent menu window cancels selection and removes its close listener", async () => {
  const parent = new BrowserWindow();
  state.closeBeforePick = true;
  expect(
    await Effect.runPromise(chooseAttachmentApp(["/Applications/Reader.app"], parent)),
  ).toBeUndefined();
  expect(state.closed.callback).toBeUndefined();
});
