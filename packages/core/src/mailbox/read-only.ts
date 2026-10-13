import { Effect } from "effect";
import { ProviderError } from "../domain/errors.js";
import type { ProviderAdapter } from "../services.js";

export const READ_ONLY_MESSAGE = "Remote writes are disabled in this read-only session";

export const refused = () => Effect.fail(new ProviderError({ message: READ_ONLY_MESSAGE }));

export const READ_ONLY_METHODS = Object.freeze([
  // Sync health only reads server counts through GET or IMAP STATUS.
  "folderStatus",
  "closeSessions",
  "resetConnectivity",
  // A token refresh, not a mailbox write: keeps idle refresh tokens alive in read-only sessions too.
  "keepAlive",
  "fetchMessage",
  "fetchCachedHeaders",
  "verifyResetCandidates",
  "draftMessageIds",
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
  "draftVersion",
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

export const OFFLINE_MESSAGE = "Network calls are disabled in this offline session";

const offline = () => Effect.fail(new ProviderError({ message: OFFLINE_MESSAGE }));

/**
 * OPENMAIL_OFFLINE=1 (the desktop smoke's default): every provider method fails without
 * running, reads and token refreshes included, so the session makes no provider calls.
 * Local mail, search and settings keep working from the database.
 */
export function offlineAdapter(adapter: ProviderAdapter): ProviderAdapter {
  return new Proxy(adapter, {
    // Never evaluate the adapter's own value, so a getter cannot reach the network either.
    get: (target, key) => (key in target ? offline : undefined),
    getOwnPropertyDescriptor(target, key) {
      const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
      if (!descriptor) return descriptor;
      return {
        configurable: descriptor.configurable,
        enumerable: descriptor.enumerable,
        value: offline,
        writable: false,
      };
    },
  });
}
