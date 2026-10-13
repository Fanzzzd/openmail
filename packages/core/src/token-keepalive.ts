import { Cause, Effect, Schedule } from "effect";

import { KEEP_ALIVE_CHECK, KEEP_ALIVE_MAX_AGE_MS } from "./reauth.js";
import type { Provider } from "./domain/domain.js";
import type { ProviderAdapter, Store } from "./services.js";

/** Only the keep-alive of each adapter is used. */
export interface KeepAliveProviders {
  get(provider: Provider): Pick<ProviderAdapter, "keepAlive">;
}

/**
 * One keep-alive pass: refresh each OAuth account whose token this process has not
 * refreshed for KEEP_ALIVE_MAX_AGE_MS. Disabled and paused accounts count too: a refresh
 * reads no mail and writes nothing to the mailbox. Only a definitive AuthError marks
 * the account; offline, 5xx and keychain errors wait for the next pass.
 */
export const keepTokensAlive = (
  store: Pick<Store["Service"], "listAccounts" | "markReauth">,
  providers: KeepAliveProviders,
  changed: Effect.Effect<void>,
) =>
  Effect.gen(function* () {
    for (const account of yield* store.listAccounts) {
      if (account.provider === "imap" || account.needsReauth) continue;
      const adapter = providers.get(account.provider);
      if (!adapter.keepAlive) continue;
      const result = yield* Effect.result(adapter.keepAlive(account.id, KEEP_ALIVE_MAX_AGE_MS));
      if (result._tag === "Failure" && result.failure._tag === "AuthError") {
        yield* store.markReauth(account.id, result.failure);
        yield* changed;
      }
    }
  });

/** The first pass runs a minute after start, after the first sync has refreshed what it uses. */
export const runTokenKeepAlive = (
  store: Pick<Store["Service"], "listAccounts" | "markReauth">,
  providers: KeepAliveProviders,
  changed: Effect.Effect<void>,
) =>
  Effect.sleep("1 minute").pipe(
    Effect.andThen(
      keepTokensAlive(store, providers, changed).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : Effect.logWarning("Token keep-alive failed"),
        ),
        Effect.repeat(Schedule.spaced(KEEP_ALIVE_CHECK)),
      ),
    ),
  );
