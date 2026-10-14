/** Optional-service gates that read the Store: provider calls for contacts, calendar and settings fail fast without the grant or with the service turned off. */

import type { Store } from "../store/service.js";
import { Effect } from "effect";
import { focusedInboxGranted, serviceGranted, type OptionalService } from "./optional-services.js";
import { FeatureScopeMissing, SettingsScopeMissing } from "../domain/errors.js";
import type { Account } from "../domain/account.js";
import type { ProviderAdapter } from "./adapter.js";
import { providerCapabilities } from "./capabilities.js";

export const requireFocusedInboxScope = (store: Store["Service"], accountId: string) =>
  Effect.gen(function* () {
    if (!focusedInboxGranted(yield* store.grantedScopes(accountId)))
      return yield* new FeatureScopeMissing({
        accountId,
        feature: "focusedInbox",
        message: "Sign in again to grant Mail.ReadWrite for Focused Inbox.",
      });
    return yield* Effect.void;
  });

export function serviceAvailable(
  store: Store["Service"],
  account: Account,
  service: OptionalService,
) {
  return Effect.gen(function* () {
    // Without optional grants there is nothing to gate.
    if (!providerCapabilities(account.provider).optionalServices) return true;
    return (
      !(yield* store.disabledServices(account.id)).includes(service) &&
      serviceGranted(account.provider, service, yield* store.grantedScopes(account.id))
    );
  });
}

/** Gate optional provider calls in one place, including automatic refreshes. Mail operations remain independent. */
export function scopedAdapter(adapter: ProviderAdapter, store: Store["Service"]): ProviderAdapter {
  const feature = <A, E>(
    account: Account,
    service: "contacts" | "calendar",
    operation: Effect.Effect<A, E>,
  ) =>
    Effect.gen(function* () {
      if (!(yield* serviceAvailable(store, account, service)))
        return yield* new FeatureScopeMissing({
          accountId: account.id,
          feature: service,
          message: `Connect ${service} in Settings → Accounts → Optional services.`,
        });
      return yield* operation;
    });
  const settings = <A, E>(account: Account, operation: Effect.Effect<A, E>) =>
    Effect.gen(function* () {
      if (!(yield* serviceAvailable(store, account, "settings")))
        return yield* new SettingsScopeMissing({
          accountId: account.id,
          message: "Connect settings in Settings → Accounts → Optional services.",
        });
      return yield* operation;
    });
  const contactSnapshot = adapter.contactSnapshot?.bind(adapter);
  const calendarEvents = adapter.calendarEvents?.bind(adapter);
  const createCalendarEvent = adapter.createCalendarEvent?.bind(adapter);
  const restoreFilter = adapter.restoreFilter?.bind(adapter);
  return {
    ...adapter,
    contacts: (account) => feature(account, "contacts", adapter.contacts(account)),
    ...(contactSnapshot
      ? {
          contactSnapshot: (account: Account) =>
            feature(account, "contacts", contactSnapshot(account)),
        }
      : {}),
    respondInvite: (account, ...args) =>
      feature(account, "calendar", adapter.respondInvite(account, ...args)),
    ...(calendarEvents
      ? {
          calendarEvents: (
            account: Account,
            event: Parameters<NonNullable<ProviderAdapter["calendarEvents"]>>[1],
          ) => feature(account, "calendar", calendarEvents(account, event)),
        }
      : {}),
    ...(createCalendarEvent
      ? {
          createCalendarEvent: (
            account: Account,
            event: Parameters<NonNullable<ProviderAdapter["createCalendarEvent"]>>[1],
          ) => feature(account, "calendar", createCalendarEvent(account, event)),
        }
      : {}),
    createFilter: (account, ...args) => settings(account, adapter.createFilter(account, ...args)),
    updateFilter: (account, ...args) => settings(account, adapter.updateFilter(account, ...args)),
    deleteFilter: (account, ...args) => settings(account, adapter.deleteFilter(account, ...args)),
    ...(restoreFilter
      ? {
          restoreFilter: (
            account: Account,
            definition: Parameters<NonNullable<ProviderAdapter["restoreFilter"]>>[1],
          ) => settings(account, restoreFilter(account, definition)),
        }
      : {}),
    setVacation: (account, ...args) => settings(account, adapter.setVacation(account, ...args)),
  };
}
