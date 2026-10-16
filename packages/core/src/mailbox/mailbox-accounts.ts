import { Clock, Effect, FiberSet, Schema } from "effect";
import { AccountSettings, PROFILE_NAME_ERRORS, profileNameError } from "../domain/account.js";
import { AuthError, FeatureScopeMissing, InvalidInput } from "../domain/errors.js";
import { GMAIL_PERMANENT_DELETE_SCOPE } from "../domain/folder-actions.js";
import { type makeContactsMailbox } from "./mailbox-contacts.js";
import { type MailboxDependencies, type MailboxRuntimeState } from "./mailbox-runtime.js";
import type { MailboxAccounts, MailboxSync } from "./mailbox.js";
import { makeOptionalServiceMailbox } from "./mailbox-services.js";
import {
  type AuthorizationFeature,
  serviceGranted,
  focusedInboxGranted,
  isOptionalService,
  consentBatch,
  OPTIONAL_SCOPES,
  serviceGrants,
} from "../providers/optional-services.js";
import { activeClient } from "../providers/oauth-clients.js";
import type { ConnectInput } from "../providers/adapter.js";
import {
  oauthProvider,
  providerCapabilities,
  signsInWithOAuth,
} from "../providers/capabilities.js";

const accountMismatch = (signedInAs: string, expected: string) =>
  new AuthError({
    accountId: "",
    message: `Signed in as ${signedInAs}, expected ${expected}.`,
    reason: "account_mismatch",
    signedInAs,
    expected,
  });

/** Fails with InvalidInput when no space may take `name` (see profileNameError). */
const checkProfileNameIn = (store: MailboxDependencies["store"]) =>
  Effect.fn("Mailbox.checkProfileName")(function* (name: string, id?: string) {
    const problem = profileNameError(name, yield* store.listProfiles, id);
    if (problem)
      yield* new InvalidInput({
        message: PROFILE_NAME_ERRORS[problem],
        hint: {
          empty: "Use a name such as Work.",
          control: "Use a name on one line, such as Work.",
          reserved: "`openmail spaces assign <account> none` takes an account out of its space.",
          taken: "`openmail spaces list` shows the spaces.",
          id: "`--space` takes a name or an id, so a name can't be another space's id.",
        }[problem],
      });
  });

export const makeAccountsMailbox = (
  deps: MailboxDependencies & {
    contacts: () => ReturnType<typeof makeContactsMailbox>;
    sync: MailboxSync["sync"];
  },
  runtime: MailboxRuntimeState,
) => {
  const { store, providers, secrets, changed, sync, mutate, config, issuers } = deps;
  const checkProfileName = checkProfileNameIn(store);

  // Accounts

  const connect = Effect.fn("Mailbox.connect")(function* (input: ConnectInput, expect?: string) {
    const accounts = yield* store.listAccounts;
    const oauth = signsInWithOAuth(input) ? input : undefined;
    const hinted = oauth
      ? accounts.find(
          (account) =>
            account.provider === oauth.provider &&
            account.email.toLowerCase() === (oauth.loginHint ?? expect)?.toLowerCase(),
        )
      : undefined;
    // A known account keeps its stored grant; scopes the caller adds (a batch of
    // optional services) come on top of it.
    const scopes = hinted
      ? [...new Set([...(yield* store.grantedScopes(hinted.id)), ...(oauth?.grantedScopes ?? [])])]
      : (oauth?.grantedScopes ?? []);
    let connected = yield* providers
      .get(input.provider)
      .connect(!oauth || scopes.length === 0 ? input : { ...oauth, grantedScopes: scopes });
    // Re-add without a login hint discovers the identity before requesting its saved grant.
    const existing = accounts.find(
      (account) =>
        account.provider === input.provider &&
        account.email.toLowerCase() === connected.email.toLowerCase(),
    );
    if (!hinted && existing && oauth && oauth.grantedScopes === undefined) {
      const previous = yield* store.grantedScopes(existing.id);
      connected = yield* providers
        .get(oauth.provider)
        .connect({ ...oauth, loginHint: existing.email, grantedScopes: previous });
      if (connected.email.toLowerCase() !== existing.email.toLowerCase())
        return yield* accountMismatch(connected.email, existing.email);
    }
    if (expect && connected.email.toLowerCase() !== expect.toLowerCase())
      return yield* accountMismatch(connected.email, expect);
    const account = yield* store.upsertAccount(input.provider, connected.email);
    yield* secrets.set(account.id, connected.secret);
    if (connected.clientId) yield* issuers.set(account.id, connected.clientId);
    if (oauth) yield* issuers.setIssuedAt(account.id, yield* Clock.currentTimeMillis);
    if (oauth) yield* store.setGrantedScopes(account.id, connected.scopes ?? []);
    if (connected.imap) {
      // Sign in again sends only the login; keep the sender name chosen before.
      const senderName = existing?.imap?.senderName;
      yield* store.setImapSettings(
        account.id,
        connected.imap.senderName === undefined && senderName
          ? { ...connected.imap, senderName }
          : connected.imap,
      );
    }
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
        .contacts()
        .refreshContacts(account.id, true, true)
        .pipe(Effect.catch(() => Effect.void)),
    );
    yield* changed;
    // Only the new account needs a pull; a sync(account.id) already running is joined.
    // A held write lock ends it early; the app's timer syncs the account later.
    yield* Effect.forkDetach(sync(account.id).pipe(Effect.ignoreCause));
    return yield* store.getAccount(account.id).pipe(Effect.orDie);
  });

  const reauth = Effect.fn("Mailbox.reauth")(function* (
    accountId: string,
    feature?: AuthorizationFeature,
  ) {
    const account = yield* store.getAccount(accountId);
    const caps = providerCapabilities(account.provider);
    if (feature === "focusedInbox" && caps.inboxTabs !== "focused")
      return yield* new InvalidInput({ message: "Focused Inbox requires Outlook." });
    if (feature === "permanentDelete" && !caps.permanentDeleteScope)
      return yield* new InvalidInput({
        message: "Only Gmail requires an extra permanent deletion permission.",
      });
    const provider = account.provider;
    if (!oauthProvider(provider)) {
      return yield* new InvalidInput({
        message: "IMAP accounts sign in again by adding the address with a new password.",
      });
    }
    const stored = yield* store.grantedScopes(accountId);
    // One consent page for the clicked service and the services the person turned on
    // earlier that lost their grant. Untouched services are never requested.
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
        .contacts()
        .refreshContacts(accountId, true, true)
        .pipe(Effect.catch(() => Effect.void));
    yield* changed;
    return result;
  });
  return {
    accounts: {
      accounts: store.listAccounts,

      ...makeOptionalServiceMailbox(store, changed, (...args) =>
        deps.contacts().refreshContacts(...args),
      ),

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
            yield* FiberSet.run(runtime.background, sync(id).pipe(Effect.ignoreCause));
          }
        }),

      moveAccount: (id, input) => mutate(store.moveAccount(id, input)),

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

      createProfile: (input) =>
        mutate(
          store.transaction(
            checkProfileName(input.name).pipe(Effect.andThen(store.createProfile(input))),
          ),
        ),

      updateProfile: (id, input) =>
        mutate(
          store.transaction(
            checkProfileName(input.name, id).pipe(Effect.andThen(store.updateProfile(id, input))),
          ),
        ),

      deleteProfile: (id) => mutate(store.deleteProfile(id)),

      assignProfile: (accountId, profileId) =>
        mutate(store.setAccountProfile(accountId, profileId)),

      initializeProfiles: (accept, names) =>
        store
          .transaction(
            Effect.gen(function* () {
              const prefs = yield* store.prefs;
              const accounts = yield* store.listAccounts;
              if (prefs.defaultProfilesPrompted || accounts.length < 2) return;
              yield* store.setPrefs({ defaultProfilesPrompted: true });
              if (!accept || (yield* store.listProfiles).length) return;
              yield* store.createProfile({ name: names.personal, icon: "🏠", color: "emerald" });
              yield* store.createProfile({ name: names.work, icon: "💼", color: "blue" });
            }),
          )
          .pipe(Effect.andThen(changed)),
    } satisfies MailboxAccounts,
  };
};
