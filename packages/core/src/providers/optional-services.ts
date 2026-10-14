import { Schema } from "effect";
import type { Provider } from "../domain/account.js";
import { oauthProvider, providerCapabilities, type OAuthProvider } from "./capabilities.js";

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
} satisfies Record<OAuthProvider, readonly string[]>;
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
} satisfies Record<OAuthProvider, Record<OptionalService, readonly string[]>>;
/** Broader scopes that also grant a service: Gmail's full mail scope covers settings. */
const ALSO_GRANTED_BY: Record<
  OAuthProvider,
  Partial<Record<OptionalService, readonly string[]>>
> = {
  gmail: { settings: ["https://mail.google.com/"] },
  outlook: {},
};

/** The account asks for contacts, calendar and settings as separate OAuth grants. */
const offersOptionalServices = (provider: Provider): provider is OAuthProvider =>
  oauthProvider(provider) && providerCapabilities(provider).optionalServices;

/** Graph message classification and sender overrides both require the base Mail.ReadWrite grant. */
export const focusedInboxGranted = (scopes: readonly string[]) =>
  scopes.some(
    (scope) =>
      scope.replace(/^https:\/\/graph.microsoft.com\//i, "").toLowerCase() === "mail.readwrite",
  );

/** Compatibility baseline only for accounts whose scope metadata predates migration 19/Outlook reporting. */
export function legacyScopes(provider: Provider): readonly string[] {
  if (!oauthProvider(provider)) return [];
  const optional = offersOptionalServices(provider)
    ? Object.values(OPTIONAL_SCOPES[provider]).flat()
    : [];
  return [...new Set([...BASE_SCOPES[provider], ...optional])];
}

export function serviceGranted(
  provider: Provider,
  service: OptionalService,
  scopes: readonly string[],
) {
  if (!offersOptionalServices(provider)) return false;
  const grants = scopes.map((scope) =>
    scope.replace(/^https:\/\/graph.microsoft.com\//i, "").toLowerCase(),
  );
  // Contacts.Read/contacts.readonly is sufficient for saved contacts. The second scope adds suggestions.
  return (
    grants.includes((OPTIONAL_SCOPES[provider][service][0] ?? "").toLowerCase()) ||
    (ALSO_GRANTED_BY[provider][service] ?? []).some((scope) => scopes.includes(scope))
  );
}

export function serviceGrants(
  provider: Provider,
  scopes: readonly string[],
  disabled: readonly OptionalService[],
  enabled: readonly OptionalService[] = [],
): ServiceGrant[] {
  if (!offersOptionalServices(provider)) return [];
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
