import type { BrowserWindowConstructorOptions, Session } from "electron";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, expect, it, vi } from "vitest";
import { Effect } from "effect";
import { Mailbox } from "../../../../../packages/core/src/mailbox/mailbox.js";
import { fakeServer, TestMailbox } from "../../../../../packages/core/src/platform/node/testing.js";
import { APP_SCHEME, WINDOW_SECURITY } from "../security/security-policy";

const native = vi.hoisted(() => {
  vi.resetModules();
  return {
    directory: "",
    options: new Array<BrowserWindowConstructorOptions>(),
    html: "",
    file: "",
    modes: { file: 0, folder: 0 },
    destroyed: vi.fn(),
    sandbox: vi.fn(),
    appendSwitch: vi.fn(),
    schemes: vi.fn(),
    requests: vi.fn<Session["setPermissionRequestHandler"]>(),
    checks: vi.fn<Session["setPermissionCheckHandler"]>(),
    devices: vi.fn<Session["setDevicePermissionHandler"]>(),
    beforeRequest: vi.fn<Session["webRequest"]["onBeforeRequest"]>(),
    handle: vi.fn<Session["protocol"]["handle"]>(),
    spelling: vi.fn(),
  };
});
vi.mock("@openmail/core", () => import("../../../../../packages/core/src/index.js"));
vi.mock("electron", () => {
  const ses = {
    setPermissionRequestHandler: native.requests,
    setPermissionCheckHandler: native.checks,
    setDevicePermissionHandler: native.devices,
    setSpellCheckerEnabled: native.spelling,
    webRequest: { onBeforeRequest: native.beforeRequest },
    protocol: { handle: native.handle },
  };
  return {
    app: Object.assign(new EventEmitter(), {
      getPath: () => native.directory,
      isPackaged: true,
      enableSandbox: native.sandbox,
      commandLine: { appendSwitch: native.appendSwitch },
    }),
    protocol: { registerSchemesAsPrivileged: native.schemes },
    session: { defaultSession: ses, fromPartition: () => ses },
    dialog: {},
    shell: {},
    BrowserWindow: class extends EventEmitter {
      webContents = Object.assign(new EventEmitter(), {
        setWindowOpenHandler: vi.fn(),
        print: (_options: unknown, callback: (success: boolean, reason: string) => void) =>
          callback(true, ""),
      });
      constructor(options: BrowserWindowConstructorOptions) {
        super();
        native.options.push(options);
      }
      isDestroyed = () => false;
      destroy = native.destroyed;
      loadFile = async (file: string) => {
        native.file = file;
        native.html = await readFile(file, "utf8");
        native.modes = {
          file: (await stat(file)).mode & 0o777,
          folder: (await stat(path.dirname(file))).mode & 0o777,
        };
      };
    },
  };
});
import { app } from "electron";
import { printThread } from "./files";
import { prepareSessionSecurity, registerSecuritySchemes } from "../security/security-bootstrap";

afterAll(() => {
  vi.doUnmock("electron");
  vi.doUnmock("@openmail/core");
  vi.resetModules();
});

it("registers the app protocol before ready with minimal privileges and denies future sessions", () => {
  registerSecuritySchemes();
  expect(native.sandbox).toHaveBeenCalledOnce();
  expect(native.appendSwitch).toHaveBeenCalledWith("disable-breakpad");
  expect(native.schemes).toHaveBeenCalledWith([
    {
      scheme: APP_SCHEME,
      privileges: { standard: true, secure: true, corsEnabled: true, codeCache: true },
    },
  ]);
  const ses = {
    setPermissionRequestHandler: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
    setDevicePermissionHandler: vi.fn(),
  };
  app.emit("session-created", ses);
  expect(ses.setPermissionRequestHandler).toHaveBeenCalledOnce();
  expect(ses.setPermissionCheckHandler).toHaveBeenCalledOnce();
  expect(ses.setDevicePermissionHandler).toHaveBeenCalledOnce();
  prepareSessionSecurity();
  expect(native.handle).toHaveBeenCalledWith(APP_SCHEME, expect.any(Function));
});

it("prints untrusted mail in a scriptless private window and restricts local loads to its owned file", async () => {
  native.directory = await mkdtemp(path.join(tmpdir(), "openmail-print-security-"));
  const server = fakeServer("me@gmail.com", [
    {
      providerId: "one",
      threadId: "one",
      subject: "Private subject",
      from: { name: "", address: "a@example.com" },
      to: [],
      cc: [],
      date: 1,
      snippet: "",
      bodyText: "",
      labels: ["INBOX"],
      attachments: [],
      isUnread: false,
      isStarred: false,
      bodyHtml:
        '<script>alert(1)</script><iframe src="file:///etc/passwd"></iframe><img src="https://tracker.test/pixel"><form action="file:///etc/passwd">mail</form>',
    },
  ]);
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const mailbox = yield* Mailbox;
        const account = yield* mailbox.accounts.connect({ provider: "gmail" });
        yield* mailbox.sync.sync();
        expect(
          yield* printThread(mailbox, null, {
            id: `${account.id}/one`,
            pdf: false,
            locale: "en",
            headings: { from: "From", to: "To", cc: "Cc", date: "Date" },
          }),
        ).toBe(true);
      }).pipe(Effect.provide(TestMailbox({ gmail: server }))),
    );
    expect(native.options.at(-1)).toMatchObject({
      show: false,
      title: "OpenMail",
      webPreferences: {
        ...WINDOW_SECURITY,
        javascript: false,
        spellcheck: false,
        devTools: false,
      },
    });
    expect(native.modes).toEqual({ file: 0o600, folder: 0o700 });
    expect(native.html).toContain("default-src 'none'");
    expect(native.html).not.toMatch(/<script|<iframe/);
    expect(native.spelling).toHaveBeenCalledWith(false);
    expect(native.destroyed).toHaveBeenCalledOnce();
    await expect(stat(native.file)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(path.dirname(native.file))).rejects.toMatchObject({ code: "ENOENT" });
    const gate = native.beforeRequest.mock.calls.at(-1)?.[0];
    if (!gate) throw new Error("Missing print resource gate");
    for (const url of [
      "https://tracker.test/pixel",
      "file:///etc/passwd",
      pathToFileURL(native.file).href,
    ]) {
      const answer = vi.fn();
      // The test exercises the registered handler without Chromium's network service.
      gate(
        {
          id: 1,
          url,
          method: "GET",
          webContentsId: 1,
          resourceType: "image",
          referrer: "",
          timestamp: 0,
          uploadData: [],
        },
        answer,
      );
      expect(answer).toHaveBeenCalledWith({ cancel: true });
    }
  } finally {
    await rm(native.directory, { recursive: true, force: true });
  }
});
