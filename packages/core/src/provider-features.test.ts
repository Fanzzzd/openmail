import { account as buildAccount } from "./platform/node/testing.js";
import { Effect } from "effect";
import { expect, it } from "vitest";
import { type Account } from "./domain/domain.js";
import { AuthError, FeatureScopeMissing, ProviderError } from "./domain/errors.js";
import { featureRequest } from "./provider-features.js";
const account: Account = buildAccount("outlook", { id: "outlook:fake", email: "fake@example.com" });

it("contacts preserve capability failures through nested adapters and never classify 403 as AuthError", () => {
  for (const error of [
    { _tag: "ApiError", status: 403, body: "" },
    new ProviderError({ status: 403, message: "AccessDenied" }),
    new FeatureScopeMissing({
      accountId: account.id,
      feature: "contacts",
      message: "Missing grant",
    }),
  ]) {
    const result = Effect.runSync(
      featureRequest(account, "contacts", Effect.fail(error)).pipe(Effect.flip),
    );
    expect(result._tag).toBe("FeatureScopeMissing");
  }
  const auth = Effect.runSync(
    featureRequest(
      account,
      "contacts",
      Effect.fail(new AuthError({ accountId: account.id, message: "invalid_grant" })),
    ).pipe(Effect.flip),
  );
  expect(auth._tag).toBe("AuthError");
  const quota = Effect.runSync(
    featureRequest(
      account,
      "contacts",
      Effect.fail(new ProviderError({ status: 403, message: "rateLimitExceeded" })),
    ).pipe(Effect.flip),
  );
  expect(quota._tag).toBe("ProviderError");
});
