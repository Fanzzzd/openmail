import { expect, it, vi } from "vitest";
import { Effect, FileSystem } from "effect";

const native = vi.hoisted(() => ({
  files: new Map<string, Uint8Array>(),
  directories: new Set<string>(),
  exclude: vi.fn(),
}));
vi.mock("expo-file-system", () => ({
  Paths: { document: "file:///sandbox/documents", cache: "file:///sandbox/cache" },
  Directory: class {
    uri: string;
    constructor(...parts: (string | { uri: string })[]) {
      this.uri = parts.map((part) => (typeof part === "string" ? part : part.uri)).join("/");
    }
    get exists() {
      return native.directories.has(this.uri);
    }
    create() {
      native.directories.add(this.uri);
    }
    moveSync(target: { uri: string }) {
      const previous = this.uri;
      native.directories.delete(previous);
      native.directories.add(target.uri);
      for (const [path, data] of native.files) {
        if (path.startsWith(`${previous}/`)) {
          native.files.delete(path);
          native.files.set(`${target.uri}${path.slice(previous.length)}`, data);
        }
      }
      this.uri = target.uri;
    }
    list() {
      return [...native.files.keys()]
        .filter((path) => path.startsWith(`${this.uri}/`))
        .map((uri) => ({ uri }));
    }
    delete() {
      native.directories.delete(this.uri);
    }
  },
  File: class {
    uri: string;
    constructor(...parts: (string | { uri: string })[]) {
      this.uri = parts.map((part) => (typeof part === "string" ? part : part.uri)).join("/");
    }
    get exists() {
      return native.files.has(this.uri);
    }
    write(content: Uint8Array | string) {
      native.files.set(
        this.uri,
        typeof content === "string" ? new TextEncoder().encode(content) : content,
      );
    }
    async bytes() {
      const value = native.files.get(this.uri);
      if (!value) throw new Error("not found");
      return value;
    }
    async text() {
      return new TextDecoder().decode(await this.bytes());
    }
    async copy(target: { uri: string }, options?: { overwrite?: boolean }) {
      const data = native.files.get(this.uri);
      if (!data || (native.files.has(target.uri) && !options?.overwrite))
        throw new Error("Copy failed");
      native.files.set(target.uri, new Uint8Array(data));
    }
    async move(target: { uri: string }, options?: { overwrite?: boolean }) {
      await this.copy(target, options);
      native.files.delete(this.uri);
      this.uri = target.uri;
    }
    delete() {
      native.files.delete(this.uri);
    }
  },
}));
vi.mock("expo-crypto", () => ({ randomUUID: () => "unique-migration" }));
vi.mock("expo", () => ({ requireNativeModule: () => ({ excludeFromBackup: native.exclude }) }));
vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));
import { dataDirectory, fileUri, filesLayer, prepareMailDirectory } from "./files";

it("maps Effect paths to Expo sandbox URIs and preserves file bytes", async () => {
  expect(dataDirectory()).toBe("/sandbox/documents/openmail-data");
  expect(fileUri("/sandbox/documents/openmail-data/a b.txt")).toBe(
    "file:///sandbox/documents/openmail-data/a%20b.txt",
  );
  await Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory("/sandbox/documents/openmail-data", { recursive: true });
      yield* fs.writeFile(
        "/sandbox/documents/openmail-data/test.bin",
        new Uint8Array([0, 128, 255]),
      );
      expect(yield* fs.readFile("/sandbox/documents/openmail-data/test.bin")).toEqual(
        new Uint8Array([0, 128, 255]),
      );
      yield* fs.writeFileString("/sandbox/documents/openmail-data/test.txt", "消息文本");
      expect(yield* fs.readFileString("/sandbox/documents/openmail-data/test.txt")).toBe(
        "消息文本",
      );
      yield* fs.remove("/sandbox/documents/openmail-data/test.bin");
      expect(yield* fs.exists("/sandbox/documents/openmail-data/test.bin")).toBe(false);
    }).pipe(Effect.provide(filesLayer)),
  );
});
it("rejects paths outside the sandbox, including encoded traversal", () => {
  for (const path of [
    "/sandbox/cache/other",
    "/sandbox/documents/openmail-data/../other",
    "file:///sandbox/documents/openmail-data/%2e%2e/other",
    "/sandbox/documents/openmail-data2/data",
  ]) {
    expect(() => fileUri(path)).toThrow("outside");
  }
});

const cache = "file:///sandbox/cache/openmail";
const target = "file:///sandbox/documents/openmail-data";
const legacy = "file:///sandbox/documents/openmail";
function resetStorage() {
  native.files.clear();
  native.directories.clear();
  native.exclude.mockReset();
}
it("atomically moves the cache DB/WAL/SHM into persistent excluded storage", () => {
  resetStorage();
  native.directories.add(cache);
  for (const [index, name] of ["mail.db", "mail.db-wal", "mail.db-shm"].entries())
    native.files.set(`${cache}/${name}`, new Uint8Array([index]));
  expect(prepareMailDirectory()).toBe("/sandbox/documents/openmail-data");
  for (const [index, name] of ["mail.db", "mail.db-wal", "mail.db-shm"].entries())
    expect(native.files.get(`${target}/${name}`)).toEqual(new Uint8Array([index]));
  expect(native.directories.has(cache)).toBe(false);
  expect(native.exclude.mock.calls).toEqual([[cache], [target]]);
  expect(prepareMailDirectory()).toBe("/sandbox/documents/openmail-data");
});
it("keeps an established persistent DB and archives both older copies", () => {
  resetStorage();
  for (const uri of [target, cache, legacy]) native.directories.add(uri);
  native.files.set(`${target}/mail.db`, new Uint8Array([3]));
  native.files.set(`${cache}/mail.db`, new Uint8Array([2]));
  native.files.set(`${legacy}/mail.db`, new Uint8Array([1]));
  prepareMailDirectory();
  expect(native.files.get(`${target}/mail.db`)).toEqual(new Uint8Array([3]));
  expect(native.files.get(`${target}/legacy-cache-unique-migration/mail.db`)).toEqual(
    new Uint8Array([2]),
  );
  expect(native.files.get(`${target}/legacy-documents-unique-migration/mail.db`)).toEqual(
    new Uint8Array([1]),
  );
});
it("recovers an empty target left by an interrupted first launch", () => {
  resetStorage();
  native.directories.add(target);
  native.directories.add(cache);
  native.files.set(`${cache}/mail.db`, new Uint8Array([9]));
  prepareMailDirectory();
  expect(native.files.get(`${target}/mail.db`)).toEqual(new Uint8Array([9]));
});
it("migrates an older Documents DB if no cache DB exists", () => {
  resetStorage();
  native.directories.add(legacy);
  native.files.set(`${legacy}/mail.db`, new Uint8Array([8]));
  prepareMailDirectory();
  expect(native.files.get(`${target}/mail.db`)).toEqual(new Uint8Array([8]));
  expect(native.exclude).toHaveBeenCalledWith(legacy);
});
it("stops before opening or moving data when backup exclusion fails", () => {
  resetStorage();
  native.directories.add(cache);
  native.files.set(`${cache}/mail.db`, new Uint8Array([9]));
  native.exclude.mockImplementation(() => {
    throw new Error("Backup exclusion unavailable");
  });
  expect(() => prepareMailDirectory()).toThrow("Backup exclusion");
  expect(native.files.has(`${cache}/mail.db`)).toBe(true);
});

it("maps quarantine copy and replacement move to the Expo Promise APIs", async () => {
  resetStorage();
  const root = dataDirectory();
  await Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFile(`${root}/mail.db`, new Uint8Array([1, 128, 255]));
      yield* fs.copyFile(`${root}/mail.db`, `${root}/mail.db.corrupt-id`);
      yield* fs.writeFile(`${root}/mail.db.recovery-id`, new Uint8Array([2, 0]));
      yield* fs.remove(`${root}/mail.db`);
      yield* fs.rename(`${root}/mail.db.recovery-id`, `${root}/mail.db`);
      expect(yield* fs.readFile(`${root}/mail.db.corrupt-id`)).toEqual(
        new Uint8Array([1, 128, 255]),
      );
      expect(yield* fs.readFile(`${root}/mail.db`)).toEqual(new Uint8Array([2, 0]));
      yield* fs.writeFileString(`${root}/state.json`, "old");
      yield* fs.writeFileString(`${root}/state.json.tmp`, "complete");
      yield* fs.rename(`${root}/state.json.tmp`, `${root}/state.json`);
      expect(yield* fs.readFileString(`${root}/state.json`)).toBe("complete");
      expect(yield* fs.exists(`${root}/mail.db.recovery-id`)).toBe(false);
    }).pipe(Effect.provide(filesLayer)),
  );
});
