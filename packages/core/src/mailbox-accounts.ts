import { Clock, Effect, FiberSet, Schema } from "effect";
import { AccountSettings } from "./domain.js";
import { FeatureScopeMissing, InvalidInput } from "./errors.js";
import { GMAIL_PERMANENT_DELETE_SCOPE } from "./folder-actions.js";
import { type makeFeatureMailbox } from "./mailbox-features.js";
import { type MailboxDependencies, type MailboxRuntimeState } from "./mailbox-runtime.js";
import { type Mailbox } from "./mailbox.js";
import { type AuthorizationFeature, serviceGranted } from "./optional-services.js";
import { type ConnectInput } from "./services.js";

export const makeAccountsMailbox = (
  deps: MailboxDependencies & {
    features: () => ReturnType<typeof makeFeatureMailbox>;
    sync: Mailbox["Service"]["sync"];
  },
  runtime: MailboxRuntimeState,
) => {
  const { store, providers, secrets, changed, sync, mutate, config } = deps;

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
    const scopes = hinted
      ? yield* store.grantedScopes(hinted.id)
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
        return yield* new InvalidInput({
          message: `Signed in as ${connected.email}, expected ${existing.email}.`,
        });
    }
    if (expect && connected.email.toLowerCase() !== expect.toLowerCase()) {
      return yield* new InvalidInput({
        message: `Signed in as ${connected.email}, expected ${expect}.`,
      });
    }
    const account = yield* store.upsertAccount(input.provider, connected.email);
    yield* secrets.set(account.id, connected.secret);
    if (input.provider !== "imap")
      yield* store.setGrantedScopes(account.id, connected.scopes ?? []);
    if (connected.imap) yield* store.setImapSettings(account.id, connected.imap);
    yield* providers.get(account.provider).closeSessions?.(account.id) ?? Effect.void;
    yield* store.setNeedsReauth(account.id, false);
    yield* store.setSyncError(account.id, null);
    yield* store.audit({
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
    if (feature === "permanentDelete" && account.provider !== "gmail")
      return yield* new InvalidInput({
        message: "Only Gmail requires an extra permanent deletion permission.",
      });
    if (account.provider === "imap") {
      return yield* new InvalidInput({
        message: "IMAP accounts sign in again by adding the address with a new password.",
      });
    }
    const grantedScopes = yield* store.grantedScopes(accountId);
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
            ...(feature && feature !== "permanentDelete" ? { feature } : {}),
          },
      account.email,
    );
    if (
      feature &&
      !(feature === "permanentDelete"
        ? (yield* store.grantedScopes(accountId)).includes(GMAIL_PERMANENT_DELETE_SCOPE)
        : serviceGranted(account.provider, feature, yield* store.grantedScopes(accountId)))
    )
      return yield* new FeatureScopeMissing({
        accountId,
        feature,
        message: "The provider did not grant the requested permission.",
      });
    if (feature && feature !== "permanentDelete")
      yield* store.setServiceEnabled(accountId, feature, true);
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

      clientSetup: Effect.map(config.read, (c) => ({
        googleConfigured: Boolean(c.google),
        microsoftConfigured: Boolean(c.microsoft),
      })),

      setClient: (patch) => mutate(config.write(patch)),

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
      | "profiles"
      | "createProfile"
      | "updateProfile"
      | "deleteProfile"
      | "assignProfile"
    >,
  };
};
