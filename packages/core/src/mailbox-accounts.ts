import { Clock, Effect, FiberSet, Schema } from "effect";
import { AccountSettings } from "./domain/domain.js";
import { AuthError, FeatureScopeMissing, InvalidInput } from "./domain/errors.js";
import { GMAIL_PERMANENT_DELETE_SCOPE } from "./domain/folder-actions.js";
import { type makeFeatureMailbox } from "./mailbox-features.js";
import { type MailboxDependencies, type MailboxRuntimeState } from "./mailbox-runtime.js";
import { type Mailbox } from "./mailbox.js";
import {
  type AuthorizationFeature,
  serviceGranted,
  focusedInboxGranted,
  isOptionalService,
  consentBatch,
  OPTIONAL_SCOPES,
  serviceGrants,
} from "./optional-services.js";
import { activeClient } from "./oauth-clients.js";
import { type ConnectInput } from "./services.js";

const accountMismatch = (signedInAs: string, expected: string) =>
  new AuthError({
    accountId: "",
    message: `Signed in as ${signedInAs}, expected ${expected}.`,
    reason: "account_mismatch",
    signedInAs,
    expected,
  });

export const makeAccountsMailbox = (
  deps: MailboxDependencies & {
    features: () => ReturnType<typeof makeFeatureMailbox>;
    sync: Mailbox["Service"]["sync"];
  },
  runtime: MailboxRuntimeState,
) => {
  const { store, providers, secrets, changed, sync, mutate, config, issuers } = deps;

  // Accounts

  const connect = Effect.fn("Mailbox.connect")(function* (input: ConnectInput, expect?: string) {
    const accounts = yield* store.listAccounts;
    const hinted =
      input.provider === "imap"
        ? undefined
        : accounts.find(
            (account) =>
              account.provider === input.provider &&
              account.email.toLowerCase() === (input.loginHint ?? expect)?.toLowerCase(),
          );
    // A known account keeps its stored grant; scopes the caller adds (a batch of
    // optional services) come on top of it.
    const scopes = hinted
      ? [
          ...new Set([
            ...(yield* store.grantedScopes(hinted.id)),
            ...(input.provider === "imap" ? [] : (input.grantedScopes ?? [])),
          ]),
        ]
      : input.provider === "imap"
        ? []
        : (input.grantedScopes ?? []);
    let connected = yield* providers
      .get(input.provider)
      .connect(
        input.provider === "imap" || scopes.length === 0
          ? input
          : { ...input, grantedScopes: scopes },
      );
    // Re-add without a login hint discovers the identity before requesting its saved grant.
    const existing = accounts.find(
      (account) =>
        account.provider === input.provider &&
        account.email.toLowerCase() === connected.email.toLowerCase(),
    );
    if (!hinted && existing && input.provider !== "imap" && input.grantedScopes === undefined) {
      const previous = yield* store.grantedScopes(existing.id);
      connected = yield* providers
        .get(input.provider)
        .connect({ ...input, loginHint: existing.email, grantedScopes: previous });
      if (connected.email.toLowerCase() !== existing.email.toLowerCase())
        return yield* accountMismatch(connected.email, existing.email);
    }
    if (expect && connected.email.toLowerCase() !== expect.toLowerCase())
      return yield* accountMismatch(connected.email, expect);
    const account = yield* store.upsertAccount(input.provider, connected.email);
    yield* secrets.set(account.id, connected.secret);
    if (connected.clientId) yield* issuers.set(account.id, connected.clientId);
    if (input.provider !== "imap")
      yield* issuers.setIssuedAt(account.id, yield* Clock.currentTimeMillis);
    if (input.provider !== "imap")
      yield* store.setGrantedScopes(account.id, connected.scopes ?? []);
    if (connected.imap) yield* store.setImapSettings(account.id, connected.imap);
    yield* providers.get(account.provider).closeSessions?.(account.id) ?? Effect.void;
    yield* store.clearReauth(account.id);
    yield* store.setSyncError(account.id, null);
    yield* store.appendAudit({
      actor: { kind: "user", surface: "app" },
      accountId: account.id,
      action: "connect",
      detail: {},
    });
    // New grants must not wait for the optional-feature retry interval.
    yield* FiberSet.run(
      runtime.background,
      deps
        .features()
        .refreshContacts(account.id, true, true)
        .pipe(Effect.catch(() => Effect.void)),
    );
    yield* changed;
    yield* Effect.forkDetach(sync());
    return yield* store.getAccount(account.id).pipe(Effect.orDie);
  });

  const reauth = Effect.fn("Mailbox.reauth")(function* (
    accountId: string,
    feature?: AuthorizationFeature,
  ) {
    const account = yield* store.getAccount(accountId);
    if (feature === "focusedInbox" && account.provider !== "outlook")
      return yield* new InvalidInput({ message: "Focused Inbox requires Outlook." });
    if (feature === "permanentDelete" && account.provider !== "gmail")
      return yield* new InvalidInput({
        message: "Only Gmail requires an extra permanent deletion permission.",
      });
    if (account.provider === "imap") {
      return yield* new InvalidInput({
        message: "IMAP accounts sign in again by adding the address with a new password.",
      });
    }
    const stored = yield* store.grantedScopes(accountId);
    // One consent page for the clicked service and the services the person turned on
    // earlier that lost their grant. Untouched services are never requested.
    const provider = account.provider;
    const batch = isOptionalService(feature)
      ? consentBatch(
          serviceGrants(
            provider,
            stored,
            yield* store.disabledServices(accountId),
            yield* store.enabledServices(accountId),
          ),
          feature,
        )
      : [];
    const grantedScopes = [
      ...stored,
      ...batch.flatMap((service) => OPTIONAL_SCOPES[provider][service]),
    ];
    const result = yield* connect(
      account.provider === "gmail"
        ? {
            provider: "gmail",
            loginHint: account.email,
            grantedScopes,
            ...(feature ? { feature } : {}),
          }
        : {
            provider: "outlook",
            loginHint: account.email,
            grantedScopes,
            ...(isOptionalService(feature) ? { feature } : {}),
          },
      account.email,
    );
    const authorizedScopes = feature ? yield* store.grantedScopes(accountId) : [];
    if (
      feature &&
      !(feature === "focusedInbox"
        ? focusedInboxGranted(authorizedScopes)
        : feature === "permanentDelete"
          ? authorizedScopes.includes(GMAIL_PERMANENT_DELETE_SCOPE)
          : serviceGranted(account.provider, feature, authorizedScopes))
    )
      return yield* new FeatureScopeMissing({
        accountId,
        feature,
        message: "The provider did not grant the requested permission.",
      });
    if (isOptionalService(feature)) yield* store.setServiceEnabled(accountId, feature, true);
    if (feature === "contacts")
      yield* deps
        .features()
        .refreshContacts(accountId, true, true)
        .pipe(Effect.catch(() => Effect.void));
    yield* changed;
    return result;
  });
  return {
    service: {
      closeSessions: () =>
        Effect.gen(function* () {
          for (const provider of new Set(
            (yield* store.listAccounts).map((account) => account.provider),
          ))
            yield* providers.get(provider).closeSessions?.() ?? Effect.void;
        }),

      accounts: store.listAccounts,

      setAccountSettings: (id, input) =>
        Effect.gen(function* () {
          const settings = yield* Schema.decodeUnknownEffect(AccountSettings)(input).pipe(
            Effect.mapError(() => new InvalidInput({ message: "Invalid account settings" })),
          );
          const previous = yield* store.getAccount(id);
          // Local edits and the enabled flag never wait for provider work.
          yield* store.setAccountSettings(id, settings);
          yield* providers.get(previous.provider).closeSessions?.(id) ?? Effect.void;
          runtime.idle?.reconcile(yield* store.listAccounts);
          const resumed = previous.enabled === false && settings.enabled;

          yield* changed;
          if (resumed) {
            runtime.polling.delete(id);
            yield* FiberSet.run(runtime.background, sync(id));
          }
        }),

      moveAccount: (id, input) => mutate(store.moveAccount(id, input)),

      takeNotifications: Clock.currentTimeMillis.pipe(
        Effect.flatMap((now) => store.takeNotifications(now)),
      ),

      connect: (input) => connect(input),

      reauth,

      clientSetup: Effect.map(config.sources, (sources) => {
        const google = activeClient(sources, "google");
        const microsoft = activeClient(sources, "microsoft");
        return {
          googleClient: google,
          microsoftClient: microsoft,
          googleBuiltIn: Boolean(sources.env.google ?? sources.builtIn.google),
          microsoftBuiltIn: Boolean(sources.env.microsoft ?? sources.builtIn.microsoft),
        };
      }),

      setClient: (patch) => mutate(config.write(patch)),

      clearClient: (provider) => mutate(config.clearUser(provider)),

      profiles: store.listProfiles,

      createProfile: (input) => mutate(store.createProfile(input)),

      updateProfile: (id, input) => mutate(store.updateProfile(id, input)),

      deleteProfile: (id) => mutate(store.deleteProfile(id)),

      assignProfile: (accountId, profileId) =>
        mutate(store.setAccountProfile(accountId, profileId)),
    } satisfies Pick<
      Mailbox["Service"],
      | "closeSessions"
      | "accounts"
      | "setAccountSettings"
      | "moveAccount"
      | "takeNotifications"
      | "connect"
      | "reauth"
      | "clientSetup"
      | "setClient"
      | "clearClient"
      | "profiles"
      | "createProfile"
      | "updateProfile"
      | "deleteProfile"
      | "assignProfile"
    >,
  };
};
