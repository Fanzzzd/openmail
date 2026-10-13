import { Context, Effect } from "effect";
import { ProviderError } from "./domain/errors.js";

/** OS adapter sends a context-free HTTPS POST, with no redirects or ambient cookies. */
export const UnsubscribeNetwork = Context.Reference<{
  readonly post: (url: string) => Effect.Effect<void, ProviderError>;
}>("openmail/UnsubscribeNetwork", {
  defaultValue: () => ({
    post: () =>
      Effect.fail(
        new ProviderError({ message: "One-click unsubscribe is unavailable on this platform" }),
      ),
  }),
});
