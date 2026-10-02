import { Effect, Stream } from "effect";
import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Mailbox } from "../../../../packages/core/src/mailbox.js";
import { fakeServer, TestMailbox } from "../../../../packages/core/src/testing.js";
import {
  FakeModelLayer,
  type ModelRequest,
  type ModelOutput,
} from "../../../../packages/core/src/model.js";

const id = "00000000-0000-4000-8000-000000000001:ABPerson";
const native = vi.hoisted(() => ({
  calls: vi.fn<(binary: string, args: string[]) => void>(),
  open: vi.fn(async (_url: string) => {
    /* OS navigation is intercepted. */
  }),
  authorized: false,
  timeout: false,
  temp: "",
  quits: Array.of<() => void>(),
}));
vi.mock("@openmail/core", () => import("../../../../packages/core/src/index.js"));
vi.mock("node:child_process", () => ({
  execFile: (
    binary: string,
    args: string[],
    _options: unknown,
    callback: (error: Error | null, output: string) => void,
  ) => {
    native.calls(binary, args);
    if (binary === "/usr/bin/open") {
      callback(null, "");
      return;
    }
    if (args[0] === "--request") {
      if (native.timeout) {
        callback(
          Object.assign(new Error("Private OS detail"), { killed: true, signal: "SIGTERM" }),
          "",
        );
        return;
      }
      native.authorized = true;
    }
    const status = native.authorized ? "authorized" : "notDetermined";
    callback(
      null,
      JSON.stringify(
        args[0] === "--read"
          ? {
              status,
              contacts: [
                {
                  id: "00000000-0000-4000-8000-000000000001:ABPerson",
                  name: "Apple Name",
                  company: "Private Organization",
                  emails: ["person@example.com", "work@example.com"],
                  thumbnail: null,
                },
              ],
              groups: [
                {
                  id: "team",
                  name: "Local Team",
                  members: [
                    {
                      id: "00000000-0000-4000-8000-000000000001:ABPerson",
                      address: "work@example.com",
                    },
                  ],
                },
              ],
            }
          : { status },
      ),
    );
  },
}));
vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    once: (_event: string, callback: () => void) => native.quits.push(callback),
    getPath: () => native.temp,
  },
  shell: { openExternal: native.open },
}));
import { desktopAppleContacts } from "./apple-contacts";

afterEach(async () => {
  for (const quit of native.quits.splice(0)) quit();
  if (native.temp) {
    await rm(native.temp, { recursive: true, force: true });
    native.temp = "";
  }
  native.timeout = false;
});

it.skipIf(process.platform !== "darwin")(
  "desktop merges fake contacts without exposing them to the opted-in composer AI, respects hiding/scopes and opens the exact card URL",
  async () => {
    native.calls.mockClear();
    native.open.mockClear();
    native.authorized = false;
    const server = fakeServer("me@gmail.com", [
      {
        providerId: "m1",
        threadId: "t1",
        subject: "Mail subject",
        from: { name: "Server Name", address: "person@example.com" },
        to: [],
        cc: [],
        date: 1000,
        snippet: "Mail text",
        bodyText: "Mail text",
        bodyHtml: "",
        labels: ["INBOX"],
        attachments: [],
        isUnread: true,
        isStarred: false,
      },
    ]);
    server.contacts = [{ name: "Server Name", address: "person@example.com" }];
    const requests: ModelRequest[] = [];
    await Effect.runPromise(
      Effect.gen(function* () {
        const mailbox = yield* Mailbox;
        const account = yield* mailbox.connect({ provider: "gmail" });
        yield* mailbox.sync();
        yield* mailbox.refreshContacts(account.id);
        const desktop = desktopAppleContacts(mailbox);
        expect((yield* desktop.status).status).toBe("off");
        expect(native.calls).not.toHaveBeenCalled();
        expect((yield* desktop.suggest("person", {}))[0]?.name).toBe("Server Name");
        expect(yield* desktop.setEnabled(true)).toBe("authorized");
        yield* Effect.promise(() =>
          vi.waitFor(async () => {
            const suggestions = await Effect.runPromise(desktop.suggest("person", {}));
            expect(suggestions[0]?.name).toBe("Apple Name");
          }),
        );
        expect((yield* desktop.suggest("person", {}))[0]?.name).toBe("Apple Name");
        expect((yield* mailbox.suggestContacts("person"))[0]?.name).toBe("Server Name");
        expect(yield* mailbox.contactGroups("Local Team")).toEqual([]);
        expect(yield* desktop.groups("local")).toMatchObject([
          { members: [{ address: "work@example.com" }] },
        ]);
        expect(yield* desktop.groups("local", [])).toEqual([]);
        expect(yield* desktop.suggest("Private Organization", { accountIds: [] })).toEqual([]);
        expect(yield* desktop.suggest("person", { exclude: "PERSON@example.com" })).toEqual([]);
        yield* mailbox.setContactHidden("work@example.com", true);
        expect(yield* desktop.groups("local")).toEqual([]);
        yield* desktop.open("person@example.com");
        expect(native.open).toHaveBeenCalledWith(`addressbook://${id}`);
        yield* mailbox.setAiAccount({
          accountId: account.id,
          allowed: true,
          autoSummaries: false,
          autoTriage: false,
        });
        yield* Stream.runDrain(
          mailbox.composeAi({
            accountId: account.id,
            replyTo: `${account.id}/m1`,
            text: "Draft text",
            task: { kind: "rewrite", tone: "proofread" },
          }),
        );
        expect(requests).toHaveLength(1);
        expect(requests[0]?.purpose).toBe("compose");
        expect(requests[0]?.prompt).toContain("Server Name");
        expect(JSON.stringify(requests)).not.toMatch(
          /Apple Name|Private Organization|work@example.com|ABPerson|Local Team|thumbnail/,
        );
        expect(requests[0]?.toolkit).toBeUndefined();
        yield* mailbox.setAccountSettings(account.id, {
          enabled: false,
          description: "",
          color: null,
        });
        expect(yield* desktop.suggest("person", {})).toEqual([]);
        yield* desktop.setEnabled(false);
        expect(yield* desktop.identifier("person@example.com")).toBeNull();
        expect(native.calls.mock.calls.filter(([, args]) => args[0] === "--request")).toHaveLength(
          1,
        );
      }).pipe(
        Effect.provide(
          TestMailbox(
            { gmail: server },
            { backgroundFlush: false },
            {},
            FakeModelLayer((request) => {
              requests.push(request);
              return Stream.fromIterable<ModelOutput>([
                { _tag: "Delta", text: "Replacement" },
                { _tag: "Finished", reason: "stop" },
              ]);
            }),
          ),
        ),
      ),
    );
  },
);

it.skipIf(process.platform !== "darwin")(
  "Add to Contacts opens a private vCard in Contacts while access is off, with no permission request",
  async () => {
    native.calls.mockClear();
    native.authorized = false;
    native.temp = await mkdtemp(path.join(tmpdir(), "om-contacts-import-"));
    await Effect.runPromise(
      Effect.gen(function* () {
        const mailbox = yield* Mailbox;
        const desktop = desktopAppleContacts(mailbox);
        expect((yield* desktop.status).status).toBe("off");
        yield* desktop.add({ name: "Import Name", address: "import@example.com" });
        expect(native.calls).toHaveBeenCalledTimes(1);
        const [binary, args] = native.calls.mock.calls[0] ?? [];
        expect(binary).toBe("/usr/bin/open");
        expect(args?.slice(0, 2)).toEqual(["-b", "com.apple.AddressBook"]);
        const file = args?.[2];
        if (!file) throw new Error("Missing vCard");
        expect(yield* Effect.promise(() => readFile(file, "utf8"))).toContain(
          "EMAIL;TYPE=INTERNET:import@example.com",
        );
      }).pipe(Effect.provide(TestMailbox())),
    );
  },
);

it.skipIf(process.platform !== "darwin")(
  "the real execFile timeout boundary returns waiting instead of exposing OS errors",
  async () => {
    native.calls.mockClear();
    native.authorized = false;
    native.timeout = true;
    await Effect.runPromise(
      Effect.gen(function* () {
        const desktop = desktopAppleContacts(yield* Mailbox);
        expect(yield* desktop.setEnabled(true)).toBe("waiting");
        expect((yield* desktop.status).status).toBe("waiting");
        expect(native.calls.mock.calls.filter(([, args]) => args[0] === "--request")).toHaveLength(
          1,
        );
      }).pipe(Effect.provide(TestMailbox())),
    );
  },
);
