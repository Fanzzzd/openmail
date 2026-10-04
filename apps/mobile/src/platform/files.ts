import { requireNativeModule } from "expo";
import { Platform } from "react-native";
import { AppPaths } from "@openmail/core/portable";
import { Effect, FileSystem, Layer, Path, PlatformError } from "effect";
import { Directory, File, Paths } from "expo-file-system";
import { randomUUID } from "expo-crypto";

const persistentDirectory = () => new Directory(Paths.document, "openmail-data");
export const dataDirectory = () =>
  decodeURIComponent(persistentDirectory().uri.replace(/^file:\/\//, ""));

/** Whole-directory moves preserve DB/WAL/SHM together before SQLite opens. */
export function prepareMailDirectory(): string {
  const target = persistentDirectory();
  const cache = new Directory(Paths.cache, "openmail");
  const legacy = new Directory(Paths.document, "openmail");
  if (target.exists && !new File(target, "mail.db").exists && target.list().length === 0)
    target.delete();
  if (!target.exists) {
    const source = cache.exists ? cache : legacy.exists ? legacy : null;
    if (source) {
      excludeMailBackup(source.uri);
      source.moveSync(target);
    } else target.create({ intermediates: true, idempotent: true });
  }
  excludeMailBackup(target.uri);
  for (const origin of ["cache", "documents"] as const) {
    // moveSync mutates its source handle; recreate it to check the original location.
    const remaining = new Directory(origin === "cache" ? Paths.cache : Paths.document, "openmail");
    if (remaining.exists) {
      excludeMailBackup(remaining.uri);
      remaining.moveSync(new Directory(target, `legacy-${origin}-${randomUUID()}`));
    }
  }
  return dataDirectory();
}

/** Effect uses POSIX paths, Expo uses file URIs. Limit this adapter to the app sandbox. */
export function fileUri(path: string, root = dataDirectory()): string {
  const plain = path.startsWith("file://") ? decodeURIComponent(path.slice(7)) : path;
  if (
    (plain !== root && !plain.startsWith(`${root}/`)) ||
    plain.split("/").includes("..") ||
    plain.includes("\0")
  ) {
    throw new Error("File path is outside the mobile mail sandbox");
  }
  return `file://${plain.split("/").map(encodeURIComponent).join("/")}`;
}
const attempt = <A>(method: string, fn: () => A) =>
  Effect.try({
    try: fn,
    catch: () => PlatformError.systemError({ _tag: "Unknown", module: "FileSystem", method }),
  });
const asynchronous = <A>(method: string, fn: () => Promise<A>) =>
  Effect.tryPromise({
    try: fn,
    catch: () => PlatformError.systemError({ _tag: "Unknown", module: "FileSystem", method }),
  });
export const fileSystem = FileSystem.makeNoop({
  exists: (path) =>
    attempt("exists", () => new File(fileUri(path)).exists || new Directory(fileUri(path)).exists),
  makeDirectory: (path, options) =>
    attempt("makeDirectory", () =>
      new Directory(fileUri(path)).create({ intermediates: options?.recursive, idempotent: true }),
    ),
  readFile: (path) => asynchronous("readFile", () => new File(fileUri(path)).bytes()),
  readFileString: (path) => asynchronous("readFileString", () => new File(fileUri(path)).text()),
  writeFile: (path, bytes) => attempt("writeFile", () => new File(fileUri(path)).write(bytes)),
  writeFileString: (path, text) =>
    attempt("writeFileString", () => new File(fileUri(path)).write(text)),
  readDirectory: (path) =>
    attempt("readDirectory", () => new Directory(fileUri(path)).list().map((entry) => entry.name)),
  remove: (path, options) =>
    attempt("remove", () => {
      const uri = fileUri(path);
      const file = new File(uri);
      if (file.exists) {
        file.delete();
        return;
      }
      const directory = new Directory(uri);
      if (directory.exists) {
        if (!options?.recursive && directory.list().length)
          throw new Error("Directory is not empty");
        directory.delete();
      } else if (!options?.force) throw new Error("File does not exist");
    }),
  rename: (source, target) =>
    asynchronous("rename", () => new File(fileUri(source)).move(new File(fileUri(target)))),
  copyFile: (source, target) =>
    asynchronous("copyFile", () => new File(fileUri(source)).copy(new File(fileUri(target)))),
  realPath: (path) => attempt("realPath", () => decodeURIComponent(fileUri(path).slice(7))),
});
export const filesLayer = Layer.mergeAll(
  Path.layer,
  Layer.succeed(FileSystem.FileSystem, fileSystem),
  Layer.succeed(AppPaths, { dataDirectory: Effect.sync(dataDirectory) }),
);

/** iOS must acknowledge backup exclusion before a database can be opened. */
function excludeMailBackup(uri: string): void {
  if (Platform.OS === "ios") {
    requireNativeModule<{ excludeFromBackup: (uri: string) => void }>(
      "OpenmailStorage",
    ).excludeFromBackup(uri);
  }
}
