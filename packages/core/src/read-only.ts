import { Effect } from "effect";
import { ProviderError } from "./errors.js";
import type { ProviderAdapter } from "./services.js";

export const READ_ONLY_MESSAGE = "Remote writes are disabled in this read-only session";

export const refused = () => Effect.fail(new ProviderError({ message: READ_ONLY_MESSAGE }));

export const READ_ONLY_METHODS = Object.freeze([
  // Sync health only reads server counts through GET or IMAP STATUS.
  "folderStatus",
  "closeSessions",
  "fetchMessage",
  "fetchRaw",
  "fetchAttachment",
  "pull",
  "backfill",
  "search",
  "connect",
  "checkPermanentDelete",
  "contacts",
  "contactSnapshot",
  "watchInbox",
  "calendarEvents",
  "listFolderMessages",
  "filters",
  "vacation",
  "sendAs",
  "getDraftOrganization",
  "draftMarkdownSource",
] satisfies (keyof ProviderAdapter)[]);

/** Unknown methods fail closed, including methods added by future adapters. */
export function readOnlyAdapter(adapter: ProviderAdapter): ProviderAdapter {
  return new Proxy(adapter, {
    get(target, key, receiver) {
      if (READ_ONLY_METHODS.some((method) => method === key))
        return Reflect.get(target, key, receiver);
      // Do not evaluate an unknown accessor before deciding whether it is safe.
      return key in target ? refused : undefined;
    },
    getOwnPropertyDescriptor(target, key) {
      const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
      if (!descriptor || READ_ONLY_METHODS.some((method) => method === key)) return descriptor;
      return "value" in descriptor
        ? { ...descriptor, value: refused }
        : {
            configurable: descriptor.configurable,
            enumerable: descriptor.enumerable,
            value: refused,
            writable: false,
          };
    },
  });
}
