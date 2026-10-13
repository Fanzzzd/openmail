import { Effect } from "effect";
import { Mailbox } from "../mailbox/mailbox.js";
import { AgentIdentity, cleanMcpClientName } from "./agent-identity.js";
import type { Actor, Proposal } from "../domain/command.js";
import {
  ACCESS_STATUS_HINT,
  ACCOUNT_ID_HINT,
  CONSENT_SWITCH,
  MESSAGE_ID_HINT,
  toToolError,
  toolError,
} from "./tool-common.js";
import type { Tool, Toolkit } from "effect/ai";

/** What every tool handler shares: the Mailbox, the caller's identity and the accounts it may read. */
export const makeToolContext = Effect.gen(function* () {
  const mailbox = yield* Mailbox;
  const identity = yield* AgentIdentity;

  const agent = (rationale: string) =>
    Effect.map(identity.current, (id): Actor => ({
      kind: "agent",
      surface: id.surface,
      name: id.surface === "mcp" ? cleanMcpClientName(id.name) : id.name,
      rationale,
    }));

  const accessibleAccounts = Effect.gen(function* () {
    const accounts = (yield* mailbox.accounts).filter((a) => a.enabled !== false);
    if ((yield* identity.current).surface !== "mcp") return accounts;
    const consent = (yield* mailbox.aiSettings).accounts;
    return accounts.filter((a) => consent.some((s) => s.accountId === a.id && s.allowed));
  }).pipe(Effect.mapError(toToolError));
  /**
   * Every readable account, or just `id`. An id the caller cannot read fails as not_found,
   * whether it is unknown, turned off or lacks consent, so a typo never reads as empty mail
   * and a hidden account's existence is not revealed.
   */
  const accountIdsFor = (id?: string) =>
    Effect.flatMap(accessibleAccounts, (accounts) =>
      id === undefined
        ? Effect.succeed(accounts.map((a) => a.id))
        : accounts.some((a) => a.id === id)
          ? Effect.succeed([id])
          : Effect.fail(
              toolError("not_found", `No readable account with id ${id}.`, ACCOUNT_ID_HINT),
            ),
    );
  /** Fails as not_found for an unknown profile id. */
  const requireProfile = (id: string) =>
    Effect.flatMap(mailbox.profiles, (profiles) =>
      profiles.some((p) => p.id === id)
        ? Effect.void
        : Effect.fail(
            toolError("not_found", `No profile with id ${id}.`, "Pass an id from list_profiles."),
          ),
    );
  const forAccounts = <A, E>(
    id: string | undefined,
    f: (ids: readonly string[]) => Effect.Effect<readonly A[], E>,
  ) => Effect.flatMap(accountIdsFor(id), (ids) => (ids.length ? f(ids) : Effect.succeed([])));
  const requireMessage = (id: string) =>
    Effect.gen(function* () {
      const message = (yield* mailbox.thread(id).pipe(Effect.mapError(toToolError))).find(
        (m) => m.id === id,
      );
      if (!message)
        return yield* toolError("not_found", `No message with id ${id}.`, MESSAGE_ID_HINT);
      if (!(yield* accountIdsFor(message.accountId)).length)
        return yield* toolError(
          "no_ai_consent",
          `This message's account is turned off or does not allow AI access. Only the person can turn on ${CONSENT_SWITCH}, in Settings → AI Access.`,
          ACCESS_STATUS_HINT,
        );
      return message;
    });
  // The in-app assistant's scoped Mailbox already gates writes; avoid charging metadata checks as extra model tool calls.
  const requireThreads = (ids: readonly string[]) =>
    Effect.flatMap(identity.current, (current) =>
      current.surface === "mcp"
        ? Effect.forEach(ids, requireMessage, { discard: true })
        : Effect.void,
    );

  const visibleProposals = Effect.gen(function* () {
    const allowed = new Set(yield* accountIdsFor());
    const kept: Proposal[] = [];
    for (const row of yield* mailbox.proposals) {
      const command = row.command;
      const ids =
        command.kind === "modify" || command.kind === "snooze"
          ? yield* Effect.forEach(command.threads, (id) =>
              mailbox.thread(id).pipe(
                Effect.map((ms) => ms[0]?.accountId ?? null),
                Effect.orElseSucceed(() => null),
              ),
            )
          : [command.accountId];
      if (ids.length && ids.every((id) => id !== null && allowed.has(id))) kept.push(row);
    }
    return kept;
  });
  return {
    mailbox,
    identity,
    agent,
    accessibleAccounts,
    accountIdsFor,
    forAccounts,
    requireProfile,
    requireMessage,
    requireThreads,
    visibleProposals,
  };
});
export type ToolContext = Effect.Success<typeof makeToolContext>;

/** The handler signatures for a group of tools, keyed by tool name. */
export type HandlersFor<T extends Tool.Any> = Toolkit.HandlersFrom<{
  readonly [K in T["name"]]: Extract<T, { readonly name: K }>;
}>;
