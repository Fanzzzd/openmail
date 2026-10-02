import { AppPaths } from "@openmail/core/portable";
import { Effect, FileSystem, Layer, Path, PlatformError } from "effect";
import { Directory, File, Paths } from "expo-file-system";
import { randomUUID } from "expo-crypto";

export const dataDirectory = () =>
  decodeURIComponent(new Directory(Paths.cache, "openmail").uri.replace(/^file:\/\//, ""));

/** Move pre-fix Documents data out of backups before opening any database connection. */
export function prepareMailDirectory(): string {
  const cache = new Directory(Paths.cache, "openmail");
  const legacy = new Directory(Paths.document, "openmail");
  if (legacy.exists) {
    if (cache.exists) legacy.moveSync(new Directory(cache, `legacy-${randomUUID()}`));
    else legacy.moveSync(cache);
  }
  cache.create({ intermediates: true, idempotent: true });
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
