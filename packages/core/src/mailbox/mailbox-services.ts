import type { makeFeatureMailbox } from "./mailbox-features.js";
import { Clock, Effect } from "effect";
import { InvalidInput } from "../domain/errors.js";
import type { MailboxAccounts } from "./mailbox.js";
import type { Store } from "../store/service.js";
import { serviceGrants } from "../providers/optional-services.js";
import { providerCapabilities } from "../providers/capabilities.js";

export function makeOptionalServiceMailbox(
  store: Store["Service"],
  changed: Effect.Effect<unknown>,
  refreshContacts: ReturnType<typeof makeFeatureMailbox>["refreshContacts"],
) {
  return {
    optionalServices: (accountId) =>
      Effect.gen(function* () {
        const account = yield* store.getAccount(accountId);
        return serviceGrants(
          account.provider,
          yield* store.grantedScopes(accountId),
          yield* store.disabledServices(accountId),
          yield* store.enabledServices(accountId),
        );
      }),
    setServiceEnabled: (accountId, service, enabled) =>
      Effect.gen(function* () {
        const account = yield* store.getAccount(accountId);
        const grants = serviceGrants(account.provider, yield* store.grantedScopes(accountId), []);
        if (
          !providerCapabilities(account.provider).optionalServices ||
          (enabled &&
            !grants.some((grant) => grant.service === service && grant.state === "granted"))
        )
          return yield* new InvalidInput({ message: "Connect this service before enabling it." });
        yield* store.transaction(
          Effect.gen(function* () {
            yield* store.setServiceEnabled(accountId, service, enabled);
            if (!enabled && service === "contacts") {
              yield* store.replaceServerContacts(accountId, [], yield* Clock.currentTimeMillis);
              yield* store.replaceContactExtras(accountId, { groups: [], photos: [] });
            }
          }),
        );
        if (service === "contacts" && enabled)
          yield* refreshContacts(accountId, true, true).pipe(Effect.catch(() => Effect.void));
        yield* changed;
        return yield* Effect.void;
      }),
  } satisfies Pick<MailboxAccounts, "optionalServices" | "setServiceEnabled">;
}
