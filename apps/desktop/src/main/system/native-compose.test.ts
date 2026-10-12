import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { Effect, Schema } from "effect";
import { expect, it, vi, afterAll, beforeEach } from "vitest";
import { Mailbox, type IncomingMessage, parseAppLink } from "@openmail/core";
import { fakeServer, TestMailbox } from "@openmail/core/testing/node";
import { GrammarIssue, GrammarText, validateGrammarIssues } from "../../shared/native-compose";
import { BrowserWindow } from "electron";
import { shareMessageLink } from "./share-message-link";
import {
  decodeNativeImages,
  checkNativeGrammar,
  nativeComposeCapabilities,
  pickNativeImages,
} from "./native-compose";
import { desktopRoot } from "../../renderer/src/test-support/paths";
const native = vi.hoisted(() => {
  vi.resetModules();
  return {
    version: "13.0.0",
    share: vi.fn(),
    popup: vi.fn(),
    calls: new Array<{
      binary: string;
      args: string[];
      callback: (error: Error | null, output: string) => void;
      end: ReturnType<typeof vi.fn>;
      kill: ReturnType<typeof vi.fn>;
    }>(),
  };
});
vi.mock("electron", () => ({
  app: Object.assign(new EventEmitter(), {
    isPackaged: false,
  }),
  ShareMenu: class {
    constructor(value: unknown) {
      native.share(value);
    }
    popup = native.popup;
  },
  BrowserWindow: class extends EventEmitter {
    isDestroyed() {
      return false;
    }
    focus = vi.fn();
  },
}));
vi.mock("node:child_process", async () => ({
  ...(await vi.importActual<typeof import("node:child_process")>("node:child_process")),
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

it.skipIf(process.platform !== "darwin")(
  "shares only the chosen core-resolved URL, with the requesting window",
  async () => {
    native.share.mockClear();
    native.popup.mockClear();
    const message: IncomingMessage = {
      providerId: "0123456789abcdef",
      threadId: "fedcba9876543210",
      subject: "Private subject",
      date: 1000,
      from: { name: "Alice", address: "alice@example.com" },
      to: [],
      cc: [],
      snippet: "Private body",
      bodyText: "Private body",
      bodyHtml: "",
      attachments: [],
      labels: ["INBOX"],
      isUnread: false,
      isStarred: false,
    };
    const server = fakeServer("me@example.com", [message]);
    const parent = new BrowserWindow();
    await Effect.runPromise(
      Effect.gen(function* () {
        const mailbox = yield* Mailbox;
        const account = yield* mailbox.connect({ provider: "gmail" });
        yield* mailbox.sync();
        const id = `${account.id}/${message.providerId}`;
        for (const kind of ["message", "thread", "web"] as const) {
          yield* shareMessageLink(mailbox, parent, { id, kind });
          const sharing = Schema.decodeUnknownSync(
            Schema.Struct({ urls: Schema.Array(Schema.String) }),
          )(native.share.mock.lastCall?.[0]);
          expect(sharing.urls).toHaveLength(1);
          if (kind === "web") expect(sharing.urls[0]).toBe(yield* mailbox.messageWebUrl(id));
          else {
            const link = parseAppLink(sharing.urls[0] ?? "");
            expect(link?.kind).toBe("message");
            expect(sharing.urls[0]).toBe(yield* mailbox.privateMailLink(id, kind));
          }
          expect(native.popup.mock.lastCall).toEqual([{ window: parent }]);
        }
        expect(JSON.stringify(native.share.mock.calls)).not.toMatch(
          /Private subject|Private body|token/,
        );
        yield* shareMessageLink(mailbox, null, { id, kind: "message" }).pipe(Effect.result);
        expect(native.share).toHaveBeenCalledTimes(3);
        const missing = yield* shareMessageLink(mailbox, parent, {
          id: "unknown",
          kind: "message",
        }).pipe(Effect.result);
        expect(missing._tag).toBe("Failure");
        expect(native.share).toHaveBeenCalledTimes(3);
      }).pipe(Effect.provide(TestMailbox({ gmail: server }))),
    );
  },
);

it("rejects invalid helper payloads before attachments or grammar ranges reach the editor", () => {
  const file = { filename: "photo.jpg", mimeType: "image/jpeg", content: "YWJj" };
  expect(
    decodeNativeImages(JSON.stringify({ status: "ok", files: [file], skipped: 0 }), "photos").files,
  ).toEqual([file]);
  expect(
    decodeNativeImages(JSON.stringify({ status: "ok", files: [], skipped: 0 }), "photos").files,
  ).toEqual([]);
  for (const files of [
    [{ ...file, mimeType: "application/pdf" }],
    [{ ...file, mimeType: "application/javascript" }],
    [{ ...file, content: "file:///private/photo" }],
    [{ ...file, content: "a" }],
    [{ ...file, contentId: "" }],
    [{ ...file, sourceMessageId: "other" }],
    Array.from({ length: 17 }, () => file),
  ])
    expect(() =>
      decodeNativeImages(JSON.stringify({ status: "ok", files, skipped: 0 }), "photos"),
    ).toThrow();
  expect(() => decodeNativeImages("not json", "photos")).toThrow();
  const text = "😀 He are here.";
  const issues = Schema.decodeUnknownSync(Schema.Array(GrammarIssue))([
    { start: 6, end: 9, description: "Agreement", suggestions: ["is"] },
  ]);
  expect(validateGrammarIssues(text, issues)).toEqual(issues);
  for (const range of [
    { start: -1, end: 1 },
    { start: 0.5, end: 2 },
    { start: 2, end: 0 },
  ])
    expect(() => Schema.decodeUnknownSync(GrammarIssue)({ ...issues[0], ...range })).toThrow();
  for (const range of [
    { start: 3, end: 3 },
    { start: 10, end: 3 },
    { start: 0, end: text.length + 1 },
  ])
    expect(() =>
      validateGrammarIssues(text, [{ description: "", suggestions: [], ...range }]),
    ).toThrow();
  expect(() => Schema.decodeUnknownSync(GrammarText)("a".repeat(100_001))).toThrow();
});

it.skipIf(process.platform !== "darwin")(
  "universal native helpers self-test without windows or authorization",
  () => {
    for (const name of ["photos", "grammar"]) {
      const executable = name === "photos" ? "OpenMailPhotos.app/Contents/MacOS/photos" : "grammar";
      const binary = path.join(desktopRoot, `out/native/${executable}`);
      expect(execFileSync("/usr/bin/lipo", ["-archs", binary], { encoding: "utf8" })).toMatch(
        /x86_64.*arm64|arm64.*x86_64/,
      );
      execFileSync("/usr/bin/codesign", ["--verify", "--strict", binary]);
      if (name === "photos")
        execFileSync("/usr/bin/codesign", [
          "--verify",
          "--strict",
          path.join(desktopRoot, "out/native/OpenMailPhotos.app"),
        ]);
      const output = execFileSync(binary, ["--self-test"], { encoding: "utf8", timeout: 30_000 });
      expect(() => JSON.parse(output)).not.toThrow();
    }
  },
);

it("Photos and grammar helpers have independent minimal signing options", () => {
  const require = createRequire(import.meta.url);
  const script: unknown = require(path.join(desktopRoot, "build/sign-contacts.cjs"));
  const signing = Schema.decodeUnknownSync(
    Schema.Struct({ contactsSigningOptions: Schema.Unknown }),
  )(script);
  if (typeof signing.contactsSigningOptions !== "function") throw new Error("Missing signer");
  const options: unknown = signing.contactsSigningOptions({
    app: "/tmp/OpenMail.app",
    optionsForFile: () => ({ entitlements: "electron.plist", hardenedRuntime: true }),
  });
  const result = Schema.decodeUnknownSync(Schema.Struct({ optionsForFile: Schema.Unknown }))(
    options,
  );
  if (typeof result.optionsForFile !== "function") throw new Error("Missing options");
  for (const name of ["photos", "grammar"]) {
    const executable = name === "photos" ? "OpenMailPhotos.app/Contents/MacOS/photos" : "grammar";
    const selected: unknown = result.optionsForFile(
      `/tmp/OpenMail.app/Contents/Resources/native/${executable}`,
    );
    const config = Schema.decodeUnknownSync(
      Schema.Struct({ entitlements: Schema.String, hardenedRuntime: Schema.Boolean }),
    )(selected);
    expect(config.hardenedRuntime).toBe(true);
    expect(config.entitlements).toMatch(new RegExp(`entitlements\\.${name}\\.plist$`));
    expect(readFileSync(config.entitlements, "utf8")).not.toContain("<key>");
  }
  const bundle: unknown = result.optionsForFile(
    "/tmp/OpenMail.app/Contents/Resources/native/OpenMailPhotos.app",
  );
  const config = Schema.decodeUnknownSync(Schema.Struct({ entitlements: Schema.String }))(bundle);
  expect(config.entitlements).toMatch(/entitlements\.photos\.plist$/);
});

it("packaging includes the complete Photos app bundle and its executable under the host's namespace", () => {
  const require = createRequire(import.meta.url);
  const config = Schema.decodeUnknownSync(
    Schema.Struct({
      appId: Schema.String,
      extraResources: Schema.Array(
        Schema.Struct({
          from: Schema.String,
          filter: Schema.optionalKey(Schema.Array(Schema.String)),
        }),
      ),
      mac: Schema.Struct({ binaries: Schema.Array(Schema.String) }),
    }),
  )(require(path.join(desktopRoot, "electron-builder.config.cjs")));
  const bundle = "Contents/Resources/native/OpenMailPhotos.app/Contents/MacOS/photos";
  expect(config.mac.binaries).toContain(bundle);
  expect(config.extraResources.find((entry) => entry.from === "out/native")?.filter).toContain(
    "OpenMailPhotos.app/**/*",
  );
  const info = readFileSync(path.join(desktopRoot, "build/Info.photos.plist"), "utf8");
  expect(info).toContain(`<string>${config.appId}.photos</string>`);
  expect(info).toContain("<key>CFBundleExecutable</key><string>photos</string>");
  expect(info).toContain("<key>LSMinimumSystemVersion</key><string>13.0</string>");
  expect(info).not.toMatch(/NSCameraUsageDescription|NSPhotoLibraryUsageDescription/);
});
