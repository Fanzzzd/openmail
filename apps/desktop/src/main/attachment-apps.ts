import { execFile } from "node:child_process";
import { lstat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { nativeBinary } from "./native-binary";
import { Effect, Schema } from "effect";
import { Menu, type BrowserWindow } from "electron";
import { DeviceError, deviceErrorReason } from "@openmail/core";

const failed = (error: unknown) => new DeviceError({ message: deviceErrorReason(error) });
const trustedRoots = [
  "/Applications",
  "/System/Applications",
  path.join(homedir(), "Applications"),
  "/System/Cryptexes/App/System/Applications",
];
const execute = (binary: string, args: string[]) =>
  Effect.tryPromise({
    try: () =>
      new Promise<string>((resolve, reject) => {
        execFile(binary, args, { timeout: 15_000, maxBuffer: 1024 * 1024 }, (error, output) =>
          error ? reject(error) : resolve(output),
        );
      }),
    catch: failed,
  });
/** Roots are fixed in production. An injected root lets filesystem tests use private fixtures. */
export async function validatedAttachmentApps(
  applications: readonly string[],
  roots = trustedRoots,
): Promise<string[]> {
  const result: string[] = [];
  for (const application of new Set(applications)) {
    if (
      !path.isAbsolute(application) ||
      !application.endsWith(".app") ||
      path.resolve(application) !== application
    )
      continue;
    const root = roots.find((candidate) => application.startsWith(`${candidate}/`));
    if (!root) continue;
    try {
      const rootInfo = await lstat(root);
      if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) continue;
      // Check the bundle and every descendant directory; a symlink parent must not escape a trusted root.
      for (let current = application; current !== root; current = path.dirname(current)) {
        const info = await lstat(current);
        if (info.isSymbolicLink() || !info.isDirectory())
          throw new Error("Invalid application directory");
      }
      result.push(application);
    } catch {
      /* Unregistered, missing and aliased bundles never enter the chooser. */
    }
  }
  return result;
}
export const registeredAttachmentApps = (file: string, roots = trustedRoots) =>
  Effect.gen(function* () {
    const output = yield* execute(nativeBinary("attachment-apps"), [file]);
    const applications = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(Schema.Array(Schema.String)),
    )(output).pipe(Effect.mapError(failed));
    return yield* Effect.tryPromise({
      try: () => validatedAttachmentApps(applications, roots),
      catch: failed,
    });
  });
const name = (application: string) => path.basename(application, ".app");
export function attachmentAppLabels(applications: readonly string[]): string[] {
  return applications.map((application) =>
    applications.filter((other) => name(other).toLowerCase() === name(application).toLowerCase())
      .length > 1
      ? `${name(application)} (${application})`
      : name(application),
  );
}
export const chooseAttachmentApp = (
  applications: readonly string[],
  parent: BrowserWindow | null,
) =>
  Effect.tryPromise({
    try: () =>
      new Promise<string | undefined>((resolve, reject) => {
        if (parent?.isDestroyed()) {
          resolve(undefined);
          return;
        }
        let selected: string | undefined;
        const closed = () => {
          parent?.removeListener("closed", closed);
          resolve(selected);
        };
        try {
          const labels = attachmentAppLabels(applications);
          const menu = Menu.buildFromTemplate(
            applications.map((application, index) => ({
              label: labels[index] ?? application,
              click: () => {
                selected = application;
              },
            })),
          );
          parent?.once("closed", closed);
          menu.popup({ ...(parent ? { window: parent } : {}), callback: closed });
        } catch (error) {
          parent?.removeListener("closed", closed);
          reject(error);
        }
      }),
    catch: failed,
  });
export const openAttachmentWith = (application: string, file: string, roots = trustedRoots) =>
  Effect.gen(function* () {
    const checked = yield* Effect.tryPromise({
      try: () => validatedAttachmentApps([application], roots),
      catch: failed,
    });
    if (!checked.length)
      yield* new DeviceError({
        message: "The selected application is no longer a trusted directory.",
      });
    yield* execute("/usr/bin/open", ["-a", application, "--", file]);
  });
