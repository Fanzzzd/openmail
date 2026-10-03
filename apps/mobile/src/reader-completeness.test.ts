import { beforeEach, expect, it, vi } from "vitest";
import { mailboxTree } from "./mailbox-tree";

const native = vi.hoisted(() => ({
  files: new Map<string, { data: Uint8Array; modified: number }>(),
  directories: new Set<string>(),
  share: vi.fn(),
  available: true,
  id: 0,
  os: "ios",
}));
vi.mock("react-native", () => ({
  Platform: {
    get OS() {
      return native.os;
    },
  },
}));
vi.mock("expo-crypto", () => ({ randomUUID: () => `share-${++native.id}` }));
vi.mock("expo-sharing", () => ({
  isAvailableAsync: async () => native.available,
  shareAsync: native.share,
}));
vi.mock("expo-file-system", () => {
  const uriOf = (parts: (string | { uri: string })[]) =>
    parts.map((part) => (typeof part === "string" ? part : part.uri)).join("/");
  class File {
    uri: string;
    constructor(...parts: (string | { uri: string })[]) {
      this.uri = uriOf(parts);
    }
    get name() {
      return this.uri.split("/").at(-1) ?? "";
    }
    get exists() {
      return native.files.has(this.uri);
    }
    get size() {
      return native.files.get(this.uri)?.data.length ?? 0;
    }
    get modificationTime() {
      return native.files.get(this.uri)?.modified ?? 0;
    }
    write(data: Uint8Array) {
      native.files.set(this.uri, { data: new Uint8Array(data), modified: Date.now() });
    }
    async bytes() {
      const entry = native.files.get(this.uri);
      if (!entry) throw new Error("missing file");
      return new Uint8Array(entry.data);
    }
    delete() {
      native.files.delete(this.uri);
    }
  }
  class Directory {
    uri: string;
    constructor(...parts: (string | { uri: string })[]) {
      this.uri = uriOf(parts);
    }
    get name() {
      return this.uri.split("/").at(-1) ?? "";
    }
    get exists() {
      return native.directories.has(this.uri);
    }
    create() {
      const parts = this.uri.split("/");
      for (let i = 3; i <= parts.length; i++) native.directories.add(parts.slice(0, i).join("/"));
    }
    list() {
      const entries: (Directory | File)[] = [...native.directories]
        .filter(
          (uri) => uri.startsWith(`${this.uri}/`) && !uri.slice(this.uri.length + 1).includes("/"),
        )
        .map((uri) => new Directory(uri));
      entries.push(
        ...[...native.files.keys()]
          .filter(
            (uri) =>
              uri.startsWith(`${this.uri}/`) && !uri.slice(this.uri.length + 1).includes("/"),
          )
          .map((uri) => new File(uri)),
      );
      return entries;
    }
    delete() {
      for (const uri of native.files.keys())
        if (uri.startsWith(`${this.uri}/`)) native.files.delete(uri);
      for (const uri of native.directories)
        if (uri === this.uri || uri.startsWith(`${this.uri}/`)) native.directories.delete(uri);
    }
  }
  return { Paths: { cache: "file:///sandbox/cache" }, File, Directory };
});
import { MobileAttachmentCache } from "./platform/attachment-cache";
import {
  clearShareCopies,
  shareReceivedAttachment,
  evictShareCopies,
  SHARE_CACHE_AGE,
  SHARE_CACHE_BYTES,
} from "./received-attachments";

beforeEach(() => {
  native.files.clear();
  native.directories.clear();
  native.share.mockReset();
  native.available = true;
  native.os = "ios";
});
it("isolates accounts, persists cache entries across adapter rebuilds and evicts least-used bytes", async () => {
  const cache = new MobileAttachmentCache();
  await cache.set("first", "../../secret", new Uint8Array([1, 2, 3]), 6);
  await cache.set("second", "same", new Uint8Array([4, 5, 6]), 6);
  expect(
    [...native.files.keys()].every((path) =>
      /^file:\/\/\/sandbox\/cache\/openmail-attachments\/[a-f0-9]{64}\/[a-f0-9]{64}\.bin$/.test(
        path,
      ),
    ),
  ).toBe(true);
  expect(await new MobileAttachmentCache().get("first", "../../secret", 6)).toEqual(
    new Uint8Array([1, 2, 3]),
  );
  expect(await cache.get("second", "../../secret", 6)).toBeNull();
  expect(await cache.get("first", "../../secret", 2)).toBeNull();
  await cache.trim(3);
  expect(await cache.size()).toBe(3);
  expect(native.files.size).toBe(1);
  const epoch = cache.version();
  await cache.clear();
  await cache.set("first", "stale", new Uint8Array([1]), 6, epoch);
  expect(await cache.size()).toBe(0);
});
it("keeps a share copy while the native sheet owns it, then deletes it on success or failure", async () => {
  let release: () => void = () => {
    throw new Error("Share sheet is not open");
  };
  native.share.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const sharing = shareReceivedAttachment({
    filename: "../../report.pdf",
    mimeType: "application/pdf",
    data: new Uint8Array([1, 2, 3]),
  });
  await vi.waitFor(() => expect(native.share).toHaveBeenCalledTimes(1));
  expect(native.files.size).toBe(1);
  expect(native.share.mock.calls[0]?.[0]).toMatch(
    /^file:\/\/\/sandbox\/cache\/openmail-share\/share-\d+\/[^/]+$/,
  );
  release();
  await sharing;
  expect(native.files.size).toBe(0);
  native.share.mockRejectedValue(new Error("native sheet failed"));
  await expect(
    shareReceivedAttachment({
      filename: "file.txt",
      mimeType: "text/plain",
      data: new Uint8Array([1]),
    }),
  ).rejects.toThrow();
  expect(native.files.size).toBe(0);
});
it("removes interrupted share copies at startup and reports unavailable native sharing", async () => {
  native.directories.add("file:///sandbox/cache/openmail-share");
  native.files.set("file:///sandbox/cache/openmail-share/old/file.txt", {
    data: new Uint8Array([1]),
    modified: 0,
  });
  clearShareCopies();
  expect(native.files.size).toBe(0);
  native.available = false;
  await expect(
    shareReceivedAttachment({
      filename: "file.txt",
      mimeType: "text/plain",
      data: new Uint8Array([1]),
    }),
  ).rejects.toThrow("unavailable");
});
it("keeps nested folders together and uses full names when parents are missing", () => {
  const label = (name: string) => ({ id: name, accountId: "account", name, color: null });
  const rows = mailboxTree([
    label("Projects/Child/Sub"),
    label("Projects-X"),
    label("Missing/Leaf"),
    label("Projects"),
    label("Projects/Child"),
  ]);
  expect(rows.map((row) => [row.label.id, row.name, row.depth])).toEqual([
    ["Missing/Leaf", "Missing/Leaf", 0],
    ["Projects", "Projects", 0],
    ["Projects/Child", "Child", 1],
    ["Projects/Child/Sub", "Sub", 2],
    ["Projects-X", "Projects-X", 0],
  ]);
});

it("keeps Android share copies after handoff and restart, then evicts expired or over-budget copies", async () => {
  native.os = "android";
  await shareReceivedAttachment({
    filename: "report.pdf",
    mimeType: "application/pdf",
    data: new Uint8Array([1, 2, 3]),
  });
  const shared = native.share.mock.calls[0]?.[0];
  expect(native.files.has(shared)).toBe(true);
  clearShareCopies();
  expect(native.files.has(shared)).toBe(true);
  evictShareCopies(Date.now() + SHARE_CACHE_AGE + 1);
  expect(native.files.has(shared)).toBe(false);
  for (const id of ["older", "newer"]) {
    const directory = `file:///sandbox/cache/openmail-share/${id}`;
    native.directories.add(directory);
    native.files.set(`${directory}/large.bin`, {
      data: new Uint8Array(SHARE_CACHE_BYTES / 2 + 1),
      modified: Date.now() - (id === "older" ? 100 : 0),
    });
  }
  evictShareCopies();
  expect(native.files.has("file:///sandbox/cache/openmail-share/older/large.bin")).toBe(false);
  expect(native.files.has("file:///sandbox/cache/openmail-share/newer/large.bin")).toBe(true);
});
