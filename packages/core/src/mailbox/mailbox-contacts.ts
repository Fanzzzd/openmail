import { Clock, Effect, Semaphore } from "effect";
import { CONTACT_PHOTO_LIMIT } from "../compose/compose-images.js";
import type { ImageDownloader } from "../platform/runtime.js";
import type { Providers } from "../providers/adapter.js";
import { providerCapabilities } from "../providers/capabilities.js";
import { serviceAvailable } from "../providers/scoped-adapter.js";
import type { Store } from "../store/service.js";
import type { MailboxContacts } from "./mailbox.js";

const DEFAULT_SUGGESTIONS = 8;

/**
 * Contacts: recipient suggestions from local mail history, hidden addresses, and the server
 * contacts, groups and photos of the optional contacts service.
 */
export function makeContactsMailbox(
  store: Store["Service"],
  providers: Providers["Service"],
  changed: Effect.Effect<unknown>,
  mutate: <A, E>(effect: Effect.Effect<A, E>) => Effect.Effect<A, E>,
  downloadImage: ImageDownloader,
) {
  const contactsLock = Semaphore.makeUnsafe(1);
  const photoLock = Semaphore.makeUnsafe(1);
  const refreshContacts = (accountId: string, force = true, retryPermission = false) =>
    contactsLock.withPermit(
      Effect.gen(function* () {
        const account = yield* store.getAccount(accountId);
        if (account.enabled === false || !providerCapabilities(account.provider).optionalServices)
          return yield* Effect.void;
        const now = yield* Clock.currentTimeMillis;
        const previous = (yield* store.contactSync).find((s) => s.accountId === accountId);
        if (previous?.scopeMissing && !retryPermission) return yield* Effect.void;
        const interval = previous?.error ? 3600000 : 6 * 3600000;
        if (!force && previous && now - previous.attemptedAt < interval) return yield* Effect.void;
        const provider = providers.get(account.provider);
        const result = yield* (
          provider.contactSnapshot
            ? provider.contactSnapshot(account)
            : provider
                .contacts(account)
                .pipe(Effect.map((contacts) => ({ contacts, groups: [], photos: [] })))
        ).pipe(Effect.result);
        if (result._tag === "Failure") {
          yield* store.setContactSyncError(
            accountId,
            now,
            result.failure.message,
            result.failure._tag === "FeatureScopeMissing",
          );
          yield* changed;
          if (result.failure._tag === "FeatureScopeMissing") return yield* Effect.void;
          return yield* result.failure;
        }
        // Check and replace atomically with local service switches.
        yield* store.transaction(
          Effect.gen(function* () {
            if (!(yield* serviceAvailable(store, account, "contacts"))) return yield* Effect.void;
            yield* store.replaceServerContacts(accountId, result.success.contacts, now);
            yield* store.replaceContactExtras(accountId, result.success);
            return yield* Effect.void;
          }),
        );
        yield* changed;
        return yield* Effect.void;
      }),
    );

  return {
    refreshContacts,
    contacts: {
      suggestContacts: (query, { limit = DEFAULT_SUGGESTIONS, exclude, accountIds } = {}) =>
        store.suggestContacts(query, limit, exclude, accountIds),

      contactAlternatives: (address) => store.contactAlternatives(address),

      hiddenContacts: store.hiddenContacts,

      setContactHidden: (address, hidden) => mutate(store.setContactHidden(address, hidden)),

      contactGroups: (query, accountIds) => store.contactGroups(query, accountIds),

      contactPhoto: (accountId: string, address: string) =>
        photoLock.withPermit(
          Effect.gen(function* () {
            if (!(yield* store.prefs).contactPhotos) return null;
            const source = yield* store.contactPhotoSource(accountId, address);
            if (!source || !googleContactPhotoUrl(source.url)) return null;
            if (
              (yield* store.contactSync).some(
                (status) => status.accountId === accountId && status.scopeMissing,
              )
            )
              return null;
            if (source.dataUrl) return (yield* store.prefs).contactPhotos ? source.dataUrl : null;
            const image = yield* downloadImage(source.url, CONTACT_PHOTO_LIMIT);
            const dataUrl = `data:${image.mimeType};base64,${image.content}`;
            if (!(yield* store.prefs).contactPhotos) return null;
            yield* store.cacheContactPhoto(accountId, address, source.url, dataUrl);
            return dataUrl;
          }).pipe(Effect.catch(() => Effect.succeed(null))),
        ),

      contactSync: store.contactSync,

      refreshContacts,
    } satisfies MailboxContacts,
  };
}

function googleContactPhotoUrl(input: string): boolean {
  try {
    const url = new URL(input);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      (url.hostname === "googleusercontent.com" || url.hostname.endsWith(".googleusercontent.com"))
    );
  } catch {
    return false;
  }
}
