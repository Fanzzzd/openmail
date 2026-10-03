import { EventEmitter } from "node:events";
import { Effect } from "effect";
import { afterAll, beforeEach, expect, it, vi } from "vitest";

const native = vi.hoisted(() => {
  vi.resetModules();
  return {
    version: "13.0.0",
    calls: new Array<{
      binary: string;
      args: string[];
      callback: (error: Error | null, output: string) => void;
      end: ReturnType<typeof vi.fn>;
      kill: ReturnType<typeof vi.fn>;
    }>(),
  };
});
vi.mock("@openmail/core", () => import("../../../../packages/core/src/index.js"));
vi.mock("electron", () => ({
  app: Object.assign(new EventEmitter(), {
    isPackaged: false,
  }),
  BrowserWindow: class extends EventEmitter {
    isDestroyed() {
      return false;
    }
    focus = vi.fn();
  },
}));
vi.mock("node:child_process", () => ({
  execFile: (
    binary: string,
    args: string[],
    _options: unknown,
    callback: (error: Error | null, output: string) => void,
  ) => {
    const end = vi.fn();
    const kill = vi.fn();
    native.calls.push({ binary, args, callback, end, kill });
    return { stdin: Object.assign(new EventEmitter(), { end }), kill };
  },
}));
import { BrowserWindow } from "electron";
import {
  checkNativeGrammar,
  decodeNativeImages,
  nativeComposeCapabilities,
  pickNativeImages,
} from "./native-compose";

const systemVersion = Object.getOwnPropertyDescriptor(process, "getSystemVersion");
afterAll(() => {
  if (systemVersion) Object.defineProperty(process, "getSystemVersion", systemVersion);
  else Reflect.deleteProperty(process, "getSystemVersion");
});
beforeEach(() => {
  Object.defineProperty(process, "getSystemVersion", {
    configurable: true,
    value: () => native.version,
  });
  native.version = "13.0.0";
  native.calls.length = 0;
});

it("preserves accepted JPEGs when an oversized selection is reported, and rejects an error status", () => {
  const file = { filename: "photo-1.jpg", mimeType: "image/jpeg", content: "YWJj" };
  const result = { status: "tooLarge", files: [file], skipped: 1 };
  expect(decodeNativeImages(JSON.stringify(result), "photos")).toEqual(result);
  expect(
    decodeNativeImages(JSON.stringify({ status: "tooLarge", files: [], skipped: 1 }), "photos")
      .status,
  ).toBe("tooLarge");
  expect(() =>
    decodeNativeImages(JSON.stringify({ status: "error", files: [], skipped: 0 }), "continuity"),
  ).toThrow();
});

it("requires macOS 13 for all native compose helpers", () => {
  for (const version of ["12.7.6", "11.0", "", "unknown"])
    expect(nativeComposeCapabilities("darwin", version)).toEqual({
      photos: false,
      continuity: false,
      grammar: false,
    });
  expect(nativeComposeCapabilities("darwin", "13.0")).toEqual({
    photos: true,
    continuity: true,
    grammar: true,
  });
  expect(nativeComposeCapabilities("darwin", "26.2.1").photos).toBe(true);
  expect(nativeComposeCapabilities("linux", "26.2.1").photos).toBe(false);
});

it.skipIf(process.platform !== "darwin")(
  "Photos and grammar can run concurrently, while each helper stays exclusive per window",
  async () => {
    const parent = new BrowserWindow();
    const labels = { title: "Photos", instruction: "Choose", cancel: "Cancel" };
    const picker = Effect.runPromise(
      pickNativeImages(parent, "photos", labels).pipe(Effect.result),
    );
    const grammar = Effect.runPromise(
      checkNativeGrammar(parent, "Private message text").pipe(Effect.result),
    );
    try {
      expect(native.calls).toHaveLength(2);
      expect(native.calls[0]?.binary).toContain("OpenMailPhotos.app/Contents/MacOS/photos");
      expect(native.calls[1]?.args).toEqual(["--check"]);
      expect(native.calls[1]?.end).toHaveBeenCalledWith("Private message text");
      const second = await Effect.runPromise(
        pickNativeImages(parent, "continuity", labels).pipe(Effect.result),
      );
      expect(second._tag).toBe("Failure");
      expect(native.calls).toHaveLength(2);
      native.calls[1]?.callback(null, "[]");
      expect((await grammar)._tag).toBe("Success");
      const retry = Effect.runPromise(
        checkNativeGrammar(parent, "Second text").pipe(Effect.result),
      );
      expect(native.calls).toHaveLength(3);
      native.calls[2]?.callback(null, "[]");
      expect((await retry)._tag).toBe("Success");
      native.calls[0]?.callback(null, JSON.stringify({ status: "ok", files: [], skipped: 0 }));
      expect((await picker)._tag).toBe("Success");
      expect(parent.listenerCount("closed")).toBe(0);
    } finally {
      for (const call of native.calls) call.callback(new Error("Fixture cleanup"), "");
      await Promise.allSettled([picker, grammar]);
    }
  },
);

it.skipIf(process.platform !== "darwin")(
  "a Continuity decode error releases the helper and reports failure instead of staying pending",
  async () => {
    const parent = new BrowserWindow();
    const labels = { title: "Import", instruction: "Choose", cancel: "Cancel" };
    const first = Effect.runPromise(
      pickNativeImages(parent, "continuity", labels).pipe(Effect.result),
    );
    native.calls[0]?.callback(null, JSON.stringify({ status: "error", files: [], skipped: 0 }));
    expect((await first)._tag).toBe("Failure");
    expect(parent.listenerCount("closed")).toBe(0);
    const retry = Effect.runPromise(
      pickNativeImages(parent, "continuity", labels).pipe(Effect.result),
    );
    native.calls[1]?.callback(null, JSON.stringify({ status: "tooLarge", files: [], skipped: 1 }));
    const result = await retry;
    expect(result._tag).toBe("Success");
    if (result._tag === "Success") expect(result.success.status).toBe("tooLarge");
    expect(native.calls).toHaveLength(2);
    expect(parent.listenerCount("closed")).toBe(0);
  },
);

it.skipIf(process.platform !== "darwin")(
  "macOS 12 rejects helper execution before spawning a process",
  async () => {
    native.version = "12.7.6";
    const parent = new BrowserWindow();
    const result = await Effect.runPromise(
      checkNativeGrammar(parent, "Private text").pipe(Effect.result),
    );
    expect(result._tag).toBe("Failure");
    expect(native.calls).toEqual([]);
  },
);
