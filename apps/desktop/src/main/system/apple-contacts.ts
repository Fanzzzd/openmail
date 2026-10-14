import { execFile } from "node:child_process";
import { nativeBinary } from "../app/native-binary";
import { app, shell } from "electron";
import { Effect } from "effect";
import { appleContactVCard, DeviceError, type Address, type Mailbox } from "@openmail/core";
import {
  appleContactUrl,
  ContactsPermissionTimeout,
  createAppleContactsController,
} from "./apple-contacts-policy";
import { AttachmentTemp } from "../files/attachment-temp";

const failed = () => new DeviceError({ message: "Contacts operation failed." });
export function desktopAppleContacts(mailbox: Mailbox["Service"]) {
  const binary = nativeBinary("contacts");
  const contacts = createAppleContactsController({
    platform: process.platform,
    prefs: () => Effect.runPromise(mailbox.prefs),
    setEnabled: (enabled) => Effect.runPromise(mailbox.setPrefs({ useAppleContacts: enabled })),
    execute: (args) =>
      new Promise<string>((resolve, reject) => {
        execFile(
          binary,
          args,
          { timeout: args[0] === "--request" ? 120_000 : 30_000, maxBuffer: 32 * 1024 * 1024 },
          (error, output) => {
            if (error) {
              reject(
                args[0] === "--request" && error.killed && error.signal === "SIGTERM"
                  ? new ContactsPermissionTimeout()
                  : new Error("Contacts helper failed"),
              );
            } else resolve(output);
          },
        );
      }),
  });
  let temp: AttachmentTemp | undefined;
  app.once("will-quit", () => temp?.disposeSync());
  const available = (accountIds?: readonly string[]) =>
    Effect.map(mailbox.accounts, (accounts) =>
      accounts.some(
        (account) =>
          account.enabled && (accountIds === undefined || accountIds.includes(account.id)),
      ),
    );
  const read = Effect.promise(() => contacts.read());
  return {
    status: Effect.promise(contacts.poll),
    refresh: () => Effect.promise(() => contacts.refresh()),
    setEnabled: (enabled: boolean) =>
      Effect.tryPromise({ try: () => contacts.setEnabled(enabled), catch: failed }),
    setPrefs: (patch: Partial<import("@openmail/core").Prefs>) =>
      Effect.gen(function* () {
        if (patch.useAppleContacts !== undefined || patch.contactPhotos !== undefined)
          contacts.invalidate();
        yield* mailbox.setPrefs(patch);
        if (patch.useAppleContacts !== undefined || patch.contactPhotos !== undefined)
          contacts.invalidate();
      }),
    suggest: (query: string, options: { exclude?: string; accountIds?: readonly string[] }) =>
      Effect.gen(function* () {
        yield* read;
        return contacts.cache.suggest(query, yield* mailbox.suggestContacts(query, options), {
          ...options,
          hidden: yield* mailbox.hiddenContacts,
          available: yield* available(options.accountIds),
        });
      }),
    groups: (query: string, accountIds?: readonly string[]) =>
      Effect.gen(function* () {
        yield* read;
        const local = (yield* available(accountIds))
          ? contacts.cache.groups(query, yield* mailbox.hiddenContacts)
          : [];
        return [...local, ...(yield* mailbox.contactGroups(query, accountIds))];
      }),
    alternatives: (address: string) =>
      Effect.gen(function* () {
        yield* read;
        const local = contacts.cache.alternatives(address);
        return local.length ? local : yield* mailbox.contactAlternatives(address);
      }),
    photo: (accountId: string, address: string) =>
      Effect.gen(function* () {
        yield* read;
        if (!(yield* mailbox.prefs).contactPhotos || !(yield* available([accountId]))) return null;
        return (
          contacts.cache.photo(address) ??
          (yield* mailbox.calendar.contactPhoto(accountId, address))
        );
      }),
    identifier: (address: string) =>
      Effect.gen(function* () {
        yield* read;
        return contacts.cache.identifier(address);
      }),
    /** Known senders from the mail store plus addresses on an Apple Contacts card. */
    knownSenders: (accountId: string, addresses: readonly string[]) =>
      Effect.gen(function* () {
        const known = yield* mailbox.knownSenders(accountId, addresses);
        yield* read;
        if (!(yield* available([accountId]))) return known;
        const cards = addresses
          .map((address) => address.trim().toLowerCase())
          .filter((address) => contacts.cache.identifier(address) !== null);
        return [...new Set([...known, ...cards])];
      }),
    open: (address: string) =>
      Effect.gen(function* () {
        yield* read;
        const identifier = contacts.cache.identifier(address);
        if (!identifier) return yield* failed();
        return yield* Effect.tryPromise({
          try: () => shell.openExternal(appleContactUrl(identifier)),
          catch: failed,
        });
      }),
    add: (address: Address) =>
      Effect.tryPromise({
        try: async () => {
          if (process.platform !== "darwin") throw new Error("Unsupported");
          const data = Buffer.from(appleContactVCard(address));
          temp ??= new AttachmentTemp(app.getPath("temp"));
          const [file] = await temp.write([{ filename: "contact.vcf", data }]);
          if (!file) throw new Error("Could not create vCard");
          await new Promise<void>((resolve, reject) => {
            execFile(
              "/usr/bin/open",
              ["-b", "com.apple.AddressBook", file],
              { timeout: 15_000 },
              (error) => (error ? reject(new Error("Could not open vCard")) : resolve()),
            );
          });
        },
        catch: failed,
      }),
    openSettings: () =>
      Effect.tryPromise({
        try: () =>
          shell.openExternal(
            "x-apple.systempreferences:com.apple.preference.security?Privacy_Contacts",
          ),
        catch: failed,
      }),
  };
}
