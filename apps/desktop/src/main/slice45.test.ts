import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { Effect, Schema } from "effect";
import { expect, it, vi } from "vitest";
import { Mailbox } from "../../../../packages/core/src/mailbox.js";
import { fakeServer, TestMailbox } from "../../../../packages/core/src/platform/node/testing.js";
import type { IncomingMessage } from "../../../../packages/core/src/domain.js";
import { parseAppLink } from "../../../../packages/core/src/system.js";
import { GrammarIssue, GrammarText, validateGrammarIssues } from "../shared/native-compose";

const native = vi.hoisted(() => ({ share: vi.fn(), popup: vi.fn() }));
vi.mock("@openmail/core", () => import("../../../../packages/core/src/index.js"));
vi.mock("electron", () => ({
  app: {},
  BrowserWindow: class {
    isDestroyed() {
      return false;
    }
  },
  ShareMenu: class {
    constructor(value: unknown) {
      native.share(value);
    }
    popup = native.popup;
  },
}));
import { BrowserWindow } from "electron";
import { shareMessageLink } from "./share-message-link";
import { decodeNativeImages } from "./native-compose";

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
      const binary = fileURLToPath(new URL(`../../out/native/${executable}`, import.meta.url));
      expect(execFileSync("/usr/bin/lipo", ["-archs", binary], { encoding: "utf8" })).toMatch(
        /x86_64.*arm64|arm64.*x86_64/,
      );
      execFileSync("/usr/bin/codesign", ["--verify", "--strict", binary]);
      if (name === "photos")
        execFileSync("/usr/bin/codesign", [
          "--verify",
          "--strict",
          fileURLToPath(new URL("../../out/native/OpenMailPhotos.app", import.meta.url)),
        ]);
      const output = execFileSync(binary, ["--self-test"], { encoding: "utf8", timeout: 30_000 });
      expect(() => JSON.parse(output)).not.toThrow();
    }
  },
);

it("Photos and grammar helpers have independent minimal signing options", () => {
  const require = createRequire(import.meta.url);
  const script: unknown = require("../../build/sign-contacts.cjs");
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
  )(require("../../electron-builder.config.cjs"));
  const bundle = "Contents/Resources/native/OpenMailPhotos.app/Contents/MacOS/photos";
  expect(config.mac.binaries).toContain(bundle);
  expect(config.extraResources.find((entry) => entry.from === "out/native")?.filter).toContain(
    "OpenMailPhotos.app/**/*",
  );
  const info = readFileSync(new URL("../../build/Info.photos.plist", import.meta.url), "utf8");
  expect(info).toContain(`<string>${config.appId}.photos</string>`);
  expect(info).toContain("<key>CFBundleExecutable</key><string>photos</string>");
  expect(info).toContain("<key>LSMinimumSystemVersion</key><string>13.0</string>");
  expect(info).not.toMatch(/NSCameraUsageDescription|NSPhotoLibraryUsageDescription/);
});
