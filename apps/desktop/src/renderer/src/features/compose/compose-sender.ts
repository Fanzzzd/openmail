import { composeSender, type SendAs, type Signature } from "@openmail/core/schema";
import { Effect } from "effect";
import type { Account, Prefs } from "../../../../shared/api";
import type { ComposeMode } from "./draft";
import type { View } from "../../lib/view";

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

/** The local signature for a sender: one for new messages, one for replies and forwards. */
export function defaultSignature(
  signatures: readonly Signature[],
  accounts: readonly Account[],
  accountId: string,
  mode: ComposeMode,
  from?: string,
): Signature | undefined {
  const address = (from ?? accounts.find((a) => a.id === accountId)?.email)?.toLowerCase();
  const kind = mode === "new" ? "new" : "reply";
  return signatures.find((s) => s.address === address && s.kind === kind);
}
