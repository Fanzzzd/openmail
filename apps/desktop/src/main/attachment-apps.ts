import { execFile } from "node:child_process";
import { lstat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { nativeBinary } from "./native-binary";
import { Effect, Schema } from "effect";
import { DeviceError, deviceFailure } from "@openmail/core";

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
    catch: deviceFailure,
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
    )(output).pipe(Effect.mapError(deviceFailure));
    return yield* Effect.tryPromise({
      try: () => validatedAttachmentApps(applications, roots),
      catch: deviceFailure,
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
export const openAttachmentWith = (application: string, file: string, roots = trustedRoots) =>
  Effect.gen(function* () {
    const checked = yield* Effect.tryPromise({
      try: () => validatedAttachmentApps([application], roots),
      catch: deviceFailure,
    });
    if (!checked.length)
      yield* new DeviceError({
        message: "The selected application is no longer a trusted directory.",
      });
    yield* execute("/usr/bin/open", ["-a", application, "--", file]);
  });
