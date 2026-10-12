import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Effect } from "effect";
import { beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  calls: new Array<{ binary: string; args: string[] }>(),
  output: "[]",
  error: false,
}));
vi.mock("electron", () => ({ app: { isPackaged: false } }));
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
import {
  registeredAttachmentApps,
  openAttachmentWith,
  validatedAttachmentApps,
  attachmentAppLabels,
} from "./attachment-apps";
beforeEach(() => {
  state.calls = [];
  state.error = false;
  state.output = "[]";
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
it("duplicate app names show their paths so the React menu can tell them apart", () => {
  const apps = ["/Applications/Reader.app", "/System/Applications/Reader.app"];
  expect(attachmentAppLabels(apps)).toEqual(apps.map((application) => `Reader (${application})`));
  expect(attachmentAppLabels(["/Applications/Preview.app"])).toEqual(["Preview"]);
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
