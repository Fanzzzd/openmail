import { Effect } from "effect";
import type { Account } from "./domain.js";
import { AuthError, FeatureScopeMissing, InvalidInput, ProviderError } from "./errors.js";

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
      if (error._tag === "AuthError" || error.status === 401)
        return new AuthError({ accountId: account.id, message: error.message ?? "Sign in again" });
      return new ProviderError({
        message: error.message ?? error.body ?? `${feature} request failed`,
        ...(error.status ? { status: error.status } : {}),
      });
    }),
  );
}
