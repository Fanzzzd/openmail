import { Effect, Schema } from "effect";
import type { Account, Provider } from "../domain/domain.js";
import { FeatureScopeMissing, SettingsScopeMissing } from "../domain/errors.js";
import type { ProviderAdapter, Store } from "../services.js";

export const OptionalService = Schema.Literals(["contacts", "calendar", "settings"]);
export type OptionalService = typeof OptionalService.Type;
export const AuthorizationFeature = Schema.Literals([
  "permanentDelete",
  "focusedInbox",
  ...OptionalService.literals,
]);
export type AuthorizationFeature = typeof AuthorizationFeature.Type;
export const isOptionalService = (
  feature: AuthorizationFeature | undefined,
): feature is OptionalService => OptionalService.literals.some((service) => service === feature);
export const ServiceGrant = Schema.Struct({
  service: OptionalService,
  state: Schema.Literals(["notGranted", "granted", "turnedOff"]),
  /** Not granted, but the person turned it on earlier: a new consent asks for it again. */
  wanted: Schema.optionalKey(Schema.Literal(true)),
});
export type ServiceGrant = typeof ServiceGrant.Type;

const GOOGLE = "https://www.googleapis.com/auth/";
export const BASE_SCOPES = {
  gmail: [`${GOOGLE}gmail.modify`, `${GOOGLE}gmail.send`],
  outlook: [
    "offline_access",
    "User.Read",
    "Mail.ReadWrite",
    "Mail.Send",
    "MailboxSettings.ReadWrite",
  ],
} satisfies Record<Exclude<Provider, "imap">, readonly string[]>;
export const OPTIONAL_SCOPES = {
  gmail: {
    contacts: [`${GOOGLE}contacts.readonly`, `${GOOGLE}contacts.other.readonly`],
    calendar: [`${GOOGLE}calendar.events`],
    settings: [`${GOOGLE}gmail.settings.basic`],
  },
  outlook: {
    contacts: ["Contacts.Read", "People.Read"],
    calendar: ["Calendars.ReadWrite"],
    settings: ["MailboxSettings.ReadWrite"],
  },
} satisfies Record<Exclude<Provider, "imap">, Record<OptionalService, readonly string[]>>;

/** Graph message classification and sender overrides both require the base Mail.ReadWrite grant. */
export const focusedInboxGranted = (scopes: readonly string[]) =>
  scopes.some(
    (scope) =>
      scope.replace(/^https:\/\/graph.microsoft.com\//i, "").toLowerCase() === "mail.readwrite",
  );
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

/** Compatibility baseline only for accounts whose scope metadata predates migration 19/Outlook reporting. */
export function legacyScopes(provider: Provider): readonly string[] {
  return provider === "imap"
    ? []
    : [...new Set([...BASE_SCOPES[provider], ...Object.values(OPTIONAL_SCOPES[provider]).flat()])];
}

export function serviceGranted(
  provider: Provider,
  service: OptionalService,
  scopes: readonly string[],
) {
  if (provider === "imap") return false;
  const grants = scopes.map((scope) =>
    scope.replace(/^https:\/\/graph.microsoft.com\//i, "").toLowerCase(),
  );
  // Contacts.Read/contacts.readonly is sufficient for saved contacts. The second scope adds suggestions.
  return (
    grants.includes((OPTIONAL_SCOPES[provider][service][0] ?? "").toLowerCase()) ||
    (provider === "gmail" && scopes.includes("https://mail.google.com/") && service === "settings")
  );
}

export function serviceGrants(
  provider: Provider,
  scopes: readonly string[],
  disabled: readonly OptionalService[],
  enabled: readonly OptionalService[] = [],
): ServiceGrant[] {
  if (provider === "imap") return [];
  return OptionalService.literals.map((service): ServiceGrant => {
    if (disabled.includes(service)) return { service, state: "turnedOff" };
    if (serviceGranted(provider, service, scopes)) return { service, state: "granted" };
    return enabled.includes(service)
      ? { service, state: "notGranted", wanted: true }
      : { service, state: "notGranted" };
  });
}

/**
 * The services one consent page asks for when the person connects `service`: that one,
 * plus services they turned on earlier that lost their grant. Never untouched services.
 */
export const consentBatch = (
  grants: readonly ServiceGrant[],
  service: OptionalService,
): OptionalService[] => [
  service,
  ...grants
    .filter((grant) => grant.service !== service && grant.wanted === true)
    .map((grant) => grant.service),
];

export function serviceAvailable(
  store: Store["Service"],
  account: Account,
  service: OptionalService,
) {
  return Effect.gen(function* () {
    if (account.provider === "imap") return true;
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
