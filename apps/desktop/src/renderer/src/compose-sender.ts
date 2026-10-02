import { composeSender, type SendAs } from "@openmail/core/schema";
import { Effect } from "effect";
import type { Account, Prefs } from "../../shared/api";
import type { View } from "./view";

/** Wait for authoritative settings before choosing a new message's account or alias. */
export function resolveComposeSender<PE, PR, AE, AR>(options: {
  accounts: readonly Account[];
  view: Pick<View, "accountId" | "label">;
  scope: readonly string[] | undefined;
  prefs: Effect.Effect<Prefs, PE, PR>;
  aliases: Effect.Effect<readonly SendAs[], AE, AR>;
}) {
  return Effect.all({ prefs: options.prefs, aliases: options.aliases }).pipe(
    Effect.map(({ prefs, aliases }) =>
      composeSender(options.accounts, aliases, prefs.defaultFrom, options.view, options.scope),
    ),
  );
}
