import { expect, it, vi } from "vitest";
import { Schema } from "effect";
import {
  appleContactUrl,
  ContactsPermissionTimeout,
  createAppleContactsController,
} from "./apple-contacts-policy";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const snapshot = {
  status: "authorized",
  contacts: [
    {
      id: "00000000-0000-4000-8000-000000000001:ABPerson",
      name: "Local Name",
      company: "Local Org",
      emails: ["local@example.com"],
      thumbnail: "data:image/png;base64,AAAA",
    },
  ],
  groups: [],
};
function fixture(platform = "darwin") {
  const prefs = { useAppleContacts: false, contactPhotos: false };
  const calls: string[][] = [];
  let authorization = "notDetermined";
  let clock = 0;
  const controller = createAppleContactsController({
    platform,
    prefs: async () => prefs,
    setEnabled: async (enabled) => {
      prefs.useAppleContacts = enabled;
    },
    now: () => clock,
    execute: async (args) => {
      calls.push(args);
      if (args[0] === "--request" && authorization === "notDetermined")
        authorization = "authorized";
      return JSON.stringify(
        args[0] === "--read" ? { ...snapshot, status: authorization } : { status: authorization },
      );
    },
  });
  return {
    controller,
    prefs,
    calls,
    authorize: (value: string) => {
      authorization = value;
    },
    advance: (ms = 10_001) => {
      clock += ms;
    },
  };
}
async function loaded(controller: ReturnType<typeof createAppleContactsController>) {
  await vi.waitFor(() => expect(controller.cache.identifier("local@example.com")).not.toBeNull());
}

it("off/unsupported never launch the helper; only explicit enabling requests permission", async () => {
  const f = fixture();
  expect(await f.controller.read()).toBe("off");
  expect(f.calls).toEqual([]);
  f.prefs.useAppleContacts = true;
  expect(await f.controller.poll()).toMatchObject({ status: "notDetermined" });
  expect(f.calls).toEqual([["--status"]]);
  expect(await f.controller.setEnabled(true)).toBe("authorized");
  await loaded(f.controller);
  expect(f.calls).toEqual([["--status"], ["--request"], ["--read"]]);
  expect(await f.controller.setEnabled(false)).toBe("off");
  expect(f.controller.cache.identifier("local@example.com")).toBeNull();
  await f.controller.read();
  expect(f.calls).toHaveLength(3);
  const other = fixture("linux");
  expect(await other.controller.read()).toBe("unsupported");
  expect(await other.controller.setEnabled(true)).toBe("unsupported");
  expect(other.calls).toEqual([]);
});

it.each(["denied", "restricted"])(
  "%s is visible, clears data, and never enumerates without access",
  async (authorization) => {
    const f = fixture();
    await f.controller.setEnabled(true);
    await loaded(f.controller);
    const before = await f.controller.poll();
    f.authorize(authorization);
    f.advance();
    const after = await f.controller.poll();
    expect(after.status).toBe(authorization);
    expect(after.revision).toBeGreaterThan(before.revision);
    expect(f.controller.cache.identifier("local@example.com")).toBeNull();
    expect(f.calls.at(-1)).toEqual(["--status"]);
    const denied = fixture();
    denied.authorize(authorization);
    expect(await denied.controller.setEnabled(true)).toBe(authorization);
    expect(denied.calls).toEqual([["--request"]]);
  },
);

it("cached reads throttle authorization to ten seconds, coalesce work and honor the photo setting", async () => {
  const f = fixture();
  await f.controller.setEnabled(true);
  await loaded(f.controller);
  f.calls.length = 0;
  for (let i = 0; i < 100; i++) await f.controller.read();
  expect(f.calls).toEqual([]);
  f.advance();
  await Promise.all(Array.from({ length: 100 }, () => f.controller.read()));
  await f.controller.poll();
  expect(f.calls).toEqual([["--status"]]);
  f.prefs.contactPhotos = true;
  await f.controller.read();
  await vi.waitFor(() => expect(f.controller.cache.photo("local@example.com")).not.toBeNull());
  expect(f.calls.at(-1)).toEqual(["--read", "--photos"]);
  f.prefs.contactPhotos = false;
  await f.controller.read();
  expect(f.controller.cache.photo("local@example.com")).toBeNull();
  await vi.waitFor(() => expect(f.calls.at(-1)).toEqual(["--read"]));
  f.advance(60_001);
  await f.controller.poll();
  await vi.waitFor(() => expect(f.calls.filter((args) => args[0] === "--read")).toHaveLength(3));
});

it("a blocked whole-store refresh retains the snapshot and never delays suggestions or status polling", async () => {
  let finish: ((value: string) => void) | undefined;
  let blockRead = false;
  let clock = 0;
  const calls: string[][] = [];
  const controller = createAppleContactsController({
    platform: "darwin",
    prefs: async () => ({ useAppleContacts: true, contactPhotos: false }),
    setEnabled: async () => {
      /* Fixed preference. */
    },
    now: () => clock,
    execute: async (args) => {
      calls.push(args);
      if (args[0] !== "--read") return JSON.stringify({ status: "authorized" });
      if (blockRead)
        return new Promise<string>((resolve) => {
          finish = resolve;
        });
      return JSON.stringify(snapshot);
    },
  });
  await controller.poll();
  await loaded(controller);
  const before = await controller.poll();
  blockRead = true;
  clock = 60_001;
  await controller.poll();
  await vi.waitFor(() => expect(finish).toBeDefined());
  const read = await controller.read();
  expect(read).toBe("authorized");
  expect(controller.cache.alternatives("local@example.com")[0]?.name).toBe("Local Name");
  expect(await controller.poll()).toEqual(before);
  for (let i = 0; i < 20; i++) await controller.read();
  expect(calls.filter((args) => args[0] === "--read")).toHaveLength(2);
  finish?.(
    JSON.stringify({
      ...snapshot,
      contacts: snapshot.contacts.map((contact) => ({ ...contact, name: "Updated" })),
    }),
  );
  await vi.waitFor(() =>
    expect(controller.cache.alternatives("local@example.com")[0]?.name).toBe("Updated"),
  );
  expect((await controller.poll()).revision).toBeGreaterThan(before.revision);
});

it.each(["request", "read"])("late %s results cannot restore disabled data", async (mode) => {
  let finish: ((value: string) => void) | undefined;
  const prefs = { useAppleContacts: mode === "read", contactPhotos: true };
  const controller = createAppleContactsController({
    platform: "darwin",
    prefs: async () => prefs,
    setEnabled: async (enabled) => {
      prefs.useAppleContacts = enabled;
    },
    execute: async (args) => {
      if (args[0] === `--${mode}`)
        return new Promise<string>((resolve) => {
          finish = resolve;
        });
      return JSON.stringify({ status: "authorized" });
    },
  });
  const late = mode === "request" ? controller.setEnabled(true) : controller.read();
  await vi.waitFor(() => expect(finish).toBeDefined());
  expect(await controller.setEnabled(false)).toBe("off");
  finish?.(JSON.stringify(mode === "read" ? snapshot : { status: "authorized" }));
  await late;
  expect(await controller.read()).toBe("off");
  expect(controller.cache.identifier("local@example.com")).toBeNull();
});

it("revocation beats an earlier snapshot still loading", async () => {
  let finish: ((value: string) => void) | undefined;
  let clock = 0;
  let authorization = "authorized";
  const controller = createAppleContactsController({
    platform: "darwin",
    prefs: async () => ({ useAppleContacts: true, contactPhotos: true }),
    setEnabled: async () => {
      /* Fixed preference. */
    },
    now: () => clock,
    execute: async (args) =>
      args[0] === "--read"
        ? new Promise<string>((resolve) => {
            finish = resolve;
          })
        : JSON.stringify({ status: authorization }),
  });
  await controller.poll();
  await vi.waitFor(() => expect(finish).toBeDefined());
  authorization = "denied";
  clock = 10_001;
  expect((await controller.poll()).status).toBe("denied");
  finish?.(JSON.stringify(snapshot));
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  expect(controller.cache.identifier("local@example.com")).toBeNull();
});

it("a request timeout stays waiting and recovers by polling without asking again", async () => {
  let authorization = "notDetermined";
  let clock = 0;
  const prefs = { useAppleContacts: false, contactPhotos: false };
  const calls: string[][] = [];
  const controller = createAppleContactsController({
    platform: "darwin",
    prefs: async () => prefs,
    now: () => clock,
    setEnabled: async (enabled) => {
      prefs.useAppleContacts = enabled;
    },
    execute: async (args) => {
      calls.push(args);
      if (args[0] === "--request") throw new ContactsPermissionTimeout();
      return JSON.stringify(args[0] === "--read" ? snapshot : { status: authorization });
    },
  });
  expect(await controller.setEnabled(true)).toBe("waiting");
  expect((await controller.poll()).status).toBe("waiting");
  authorization = "authorized";
  clock = 10_001;
  expect((await controller.poll()).status).toBe("authorized");
  await loaded(controller);
  expect(calls.filter((args) => args[0] === "--request")).toHaveLength(1);
});

it("malformed helper output clears data and generic request errors remain errors", async () => {
  let output = JSON.stringify(snapshot);
  const controller = createAppleContactsController({
    platform: "darwin",
    prefs: async () => ({ useAppleContacts: true, contactPhotos: true }),
    setEnabled: async () => {
      /* Fixed preference. */
    },
    execute: async (args) =>
      args[0] === "--status" ? JSON.stringify({ status: "authorized" }) : output,
  });
  await controller.poll();
  await loaded(controller);
  output = "private non-JSON data";
  await controller.refresh();
  await vi.waitFor(() => expect(controller.cache.identifier("local@example.com")).toBeNull());
  expect(await controller.read()).toBe("error");
  expect(await controller.setEnabled(true)).toBe("error");
});

it("contact URLs preserve :ABPerson and reject URL syntax, non-UUID identifiers and other record types", () => {
  const id = "00000000-0000-4000-8000-000000000001";
  expect(appleContactUrl(`${id}:ABPerson`)).toBe(`addressbook://${id}:ABPerson`);
  expect(appleContactUrl(id)).toBe(`addressbook://${id}`);
  for (const value of [
    `${id}:ABGroup`,
    `${id}:abperson`,
    `${id}?edit`,
    `${id}#fragment`,
    `${id}/path`,
    `${id}%3AABPerson`,
    "user@host",
    "UUID:ABPerson",
    `\n${id}`,
  ])
    expect(() => appleContactUrl(value)).toThrow();
});

it("packaging grants contacts only to the app and helper, preserves per-file signing options and supplies both Chinese locale paths", () => {
  const require = createRequire(import.meta.url);
  const input: unknown = require("../../electron-builder.config.cjs");
  const config = Schema.decodeUnknownSync(
    Schema.Struct({
      mac: Schema.Struct({
        extendInfo: Schema.Struct({ NSContactsUsageDescription: Schema.String }),
        binaries: Schema.Array(Schema.String),
        entitlementsInherit: Schema.String,
        sign: Schema.Unknown,
      }),
      extraResources: Schema.Array(
        Schema.Struct({
          from: Schema.String,
          to: Schema.String,
          filter: Schema.optionalKey(Schema.Array(Schema.String)),
        }),
      ),
    }),
  )(input);
  expect(config.mac.extendInfo.NSContactsUsageDescription).toContain("never sent to AI");
  expect(config.extraResources.find((entry) => entry.from === "out/native")?.filter).toContain(
    "contacts",
  );
  expect(config.mac.binaries).toContain("Contents/Resources/native/contacts");
  expect(typeof config.mac.sign).toBe("function");
  for (const file of ["entitlements.mac.inherit.plist", "entitlements.mac.unsigned.inherit.plist"])
    expect(readFileSync(new URL(`../../build/${file}`, import.meta.url), "utf8")).not.toContain(
      "personal-information.addressbook",
    );
  for (const file of [
    "entitlements.mac.plist",
    "entitlements.mac.unsigned.plist",
    "entitlements.contacts.plist",
  ])
    expect(readFileSync(new URL(`../../build/${file}`, import.meta.url), "utf8")).toContain(
      "personal-information.addressbook",
    );
  expect(config.mac.entitlementsInherit).toBe("build/entitlements.mac.unsigned.inherit.plist");
  const script = Schema.decodeUnknownSync(
    Schema.Struct({ contactsSigningOptions: Schema.Unknown }),
  )(require("../../build/sign-contacts.cjs"));
  if (typeof script.contactsSigningOptions !== "function")
    throw new Error("Missing signing adapter");
  const result: unknown = script.contactsSigningOptions({
    app: "/tmp/OpenMail.app",
    identity: "-",
    optionsForFile: () => ({
      entitlements: "inherited.plist",
      hardenedRuntime: true,
      additionalArguments: ["--preserve-metadata=identifier"],
    }),
  });
  const options = Schema.decodeUnknownSync(Schema.Struct({ optionsForFile: Schema.Unknown }))(
    result,
  );
  if (typeof options.optionsForFile !== "function") throw new Error("Missing per-file options");
  const decode = Schema.decodeUnknownSync(
    Schema.Struct({
      entitlements: Schema.String,
      hardenedRuntime: Schema.Boolean,
      additionalArguments: Schema.Array(Schema.String),
    }),
  );
  expect(
    path.basename(
      decode(options.optionsForFile("/tmp/OpenMail.app/Contents/Resources/native/contacts"))
        .entitlements,
    ),
  ).toBe("entitlements.contacts.plist");
  for (const file of [
    "/tmp/OpenMail.app",
    "/tmp/OpenMail.app/Contents/Frameworks/Electron Helper (Renderer).app",
    "/tmp/other.app/Contents/Resources/native/contacts",
  ])
    expect(decode(options.optionsForFile(file))).toEqual({
      entitlements: "inherited.plist",
      hardenedRuntime: true,
      additionalArguments: ["--preserve-metadata=identifier"],
    });
  const zhCN = readFileSync(
    new URL("../../build/contacts-locales/zh_CN.lproj/InfoPlist.strings", import.meta.url),
    "utf8",
  );
  expect(zhCN).toBe(
    readFileSync(
      new URL("../../build/contacts-locales/zh-CN.lproj/InfoPlist.strings", import.meta.url),
      "utf8",
    ),
  );
  expect(config.extraResources.find((entry) => entry.from === "build/contacts-locales")?.to).toBe(
    ".",
  );
  const source = readFileSync(new URL("../../native/ContactsCLI.swift", import.meta.url), "utf8");
  expect(source).toContain("keysToFetch: memberKeys");
  expect(source).toContain(
    "let memberKeys: [CNKeyDescriptor] = [CNContactIdentifierKey as CNKeyDescriptor, CNContactEmailAddressesKey as CNKeyDescriptor]",
  );
});
