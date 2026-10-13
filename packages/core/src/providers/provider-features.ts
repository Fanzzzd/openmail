import { Effect } from "effect";
import type { Account } from "../domain/account.js";
import { FeatureScopeMissing, InvalidInput, ProviderError } from "../domain/errors.js";
import { authFailure } from "./reauth.js";

/** Translate optional API permissions before they reach the mail authentication path. */
export function featureRequest<
  A,
  E extends {
    readonly _tag: string;
    readonly status?: number | undefined;
    readonly body?: string | undefined;
    readonly message?: string | undefined;
  },
>(account: Account, feature: FeatureScopeMissing["feature"], effect: Effect.Effect<A, E>) {
  return effect.pipe(
    Effect.mapError((error) => {
      if (error._tag === "InvalidInput")
        return new InvalidInput({ message: error.message ?? "Invalid feature input" });
      if (error._tag === "FeatureScopeMissing")
        return new FeatureScopeMissing({
          accountId: account.id,
          feature,
          message: error.message ?? `Sign in again to enable ${feature}`,
        });
      if (
        error.status === 403 &&
        !/SERVICE_DISABLED|accessNotConfigured|has not been used|API.*disabled/i.test(
          error.body ?? error.message ?? "",
        ) &&
        !/rateLimitExceeded|dailyLimitExceeded/i.test(error.body ?? error.message ?? "")
      )
        return new FeatureScopeMissing({
          accountId: account.id,
          feature,
          message: `Sign in again to enable ${feature}`,
        });
      const auth = authFailure(account.id, error);
      if (auth) return auth;
      return new ProviderError({
        message: error.message ?? error.body ?? `${feature} request failed`,
        ...(error.status ? { status: error.status } : {}),
      });
    }),
  );
}
