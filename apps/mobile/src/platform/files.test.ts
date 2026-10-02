import { expect, it, vi } from "vitest";
import { Effect, FileSystem } from "effect";

const native = vi.hoisted(() => ({
  files: new Map<string, Uint8Array>(),
  directories: new Set<string>(),
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
      return [];
    }
    delete() {
      native.directories.delete(this.uri);
    }
  },
  File: class {
    uri: string;
    constructor(uri: string) {
      this.uri = uri;
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
    delete() {
      native.files.delete(this.uri);
    }
  },
}));
vi.mock("expo-crypto", () => ({ randomUUID: () => "unique-migration" }));
import { dataDirectory, fileUri, filesLayer, prepareMailDirectory } from "./files";

it("maps Effect paths to Expo sandbox URIs and preserves file bytes", async () => {
  expect(dataDirectory()).toBe("/sandbox/cache/openmail");
  expect(fileUri("/sandbox/cache/openmail/a b.txt")).toBe(
    "file:///sandbox/cache/openmail/a%20b.txt",
  );
  await Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory("/sandbox/cache/openmail", { recursive: true });
      yield* fs.writeFile("/sandbox/cache/openmail/test.bin", new Uint8Array([0, 128, 255]));
      expect(yield* fs.readFile("/sandbox/cache/openmail/test.bin")).toEqual(
        new Uint8Array([0, 128, 255]),
      );
      yield* fs.writeFileString("/sandbox/cache/openmail/test.txt", "消息文本");
      expect(yield* fs.readFileString("/sandbox/cache/openmail/test.txt")).toBe("消息文本");
      yield* fs.remove("/sandbox/cache/openmail/test.bin");
      expect(yield* fs.exists("/sandbox/cache/openmail/test.bin")).toBe(false);
    }).pipe(Effect.provide(filesLayer)),
  );
});
it("rejects paths outside the sandbox, including encoded traversal", () => {
  for (const path of [
    "/sandbox/cache/other",
    "/sandbox/cache/openmail/../other",
    "file:///sandbox/cache/openmail/%2e%2e/other",
    "/sandbox/cache/openmail2/data",
  ]) {
    expect(() => fileUri(path)).toThrow("outside");
  }
});

it("moves legacy mail and WAL out of Documents before using the cache database", () => {
  native.files.clear();
  native.directories.clear();
  native.directories.add("file:///sandbox/documents/openmail");
  native.files.set("file:///sandbox/documents/openmail/mail.db", new Uint8Array([1]));
  native.files.set("file:///sandbox/documents/openmail/mail.db-wal", new Uint8Array([2]));
  expect(prepareMailDirectory()).toBe("/sandbox/cache/openmail");
  expect(native.directories.has("file:///sandbox/documents/openmail")).toBe(false);
  expect(native.files.get("file:///sandbox/cache/openmail/mail.db")).toEqual(new Uint8Array([1]));
  expect(native.files.get("file:///sandbox/cache/openmail/mail.db-wal")).toEqual(
    new Uint8Array([2]),
  );
});
it("keeps both copies in excluded cache storage when legacy Documents data also exists", () => {
  native.files.clear();
  native.directories.clear();
  native.directories.add("file:///sandbox/documents/openmail");
  native.directories.add("file:///sandbox/cache/openmail");
  native.files.set("file:///sandbox/documents/openmail/mail.db", new Uint8Array([1]));
  native.files.set("file:///sandbox/cache/openmail/mail.db", new Uint8Array([2]));
  prepareMailDirectory();
  expect(native.directories.has("file:///sandbox/documents/openmail")).toBe(false);
  expect(native.files.get("file:///sandbox/cache/openmail/mail.db")).toEqual(new Uint8Array([2]));
  expect(
    native.files.get("file:///sandbox/cache/openmail/legacy-unique-migration/mail.db"),
  ).toEqual(new Uint8Array([1]));
});
