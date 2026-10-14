import { Effect, Option } from "effect";
import { Mailbox } from "../mailbox/mailbox.js";
import { AgentIdentity, cleanMcpClientName } from "./agent-identity.js";
import {
  type Actor,
  type Command,
  type Outcome,
  PENDING_PROPOSAL_LIMIT,
  PENDING_PROPOSAL_TOTAL_LIMIT,
  type Proposal,
} from "../domain/command.js";
import {
  ACCESS_STATUS_HINT,
  ACCOUNT_ID_HINT,
  CONSENT_SWITCH,
  MESSAGE_ID_HINT,
  REVIEW_PROPOSALS_HINT,
  toToolError,
  toolError,
} from "./tool-common.js";
import type { Tool, Toolkit } from "effect/ai";

/** Pending proposals one client may have, and all agents together. More fail with too_many_proposals. */
export { PENDING_PROPOSAL_LIMIT, PENDING_PROPOSAL_TOTAL_LIMIT };

/** JSON with sorted object keys, so equal commands compare equal however they were built. */
const canonicalJson = (value: unknown): string =>
  JSON.stringify(value, (_key, item: unknown) =>
    item !== null && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).toSorted(([a], [b]) => a.localeCompare(b)))
      : item,
  );

/** Whether the caller may read every account the proposal touches; one lookup for all messages. */
const visibleTo =
  (allowed: ReadonlySet<string>, owners: ReadonlyMap<string, string>) => (row: Proposal) => {
    const command = row.command;
    const ids =
      command.kind === "modify" || command.kind === "snooze"
        ? command.threads.map((id) => owners.get(id))
        : [command.accountId];
    return ids.length > 0 && ids.every((id) => id !== undefined && allowed.has(id));
  };
const threadsOf = (rows: readonly Proposal[]) =>
  rows.flatMap((row) =>
    row.command.kind === "modify" || row.command.kind === "snooze" ? row.command.threads : [],
  );

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

  /**
   * mailbox.perform for an agent's change, with limits on pending proposals: the same change
   * again returns the waiting proposal instead of a second one (and a second draft), and a
   * client with PENDING_PROPOSAL_LIMIT waiting, or all agents with PENDING_PROPOSAL_TOTAL_LIMIT,
   * gets too_many_proposals until the person decides some. The store enforces both limits in the
   * insert itself; the checks here only give the clearer message.
   */
  const propose = (command: Command, actor: Actor) =>
    Effect.gen(function* () {
      if (actor.kind !== "agent")
        return yield* mailbox.perform(command, actor).pipe(Effect.mapError(toToolError));
      const pending = (yield* mailbox.proposals).filter((p) => p.actor.kind === "agent");
      const mine = pending.filter(
        (p) =>
          p.actor.kind === "agent" &&
          p.actor.surface === actor.surface &&
          p.actor.name === actor.name,
      );
      const key = canonicalJson(command);
      const same = mine.find((p) => canonicalJson(p.command) === key);
      if (same) return { status: "proposed", proposalId: same.id } satisfies Outcome;
      if (mine.length >= PENDING_PROPOSAL_LIMIT)
        return yield* toolError(
          "too_many_proposals",
          `${PENDING_PROPOSAL_LIMIT} proposals from this app are already waiting for the person. Nothing was proposed.`,
          REVIEW_PROPOSALS_HINT,
        );
      if (pending.length >= PENDING_PROPOSAL_TOTAL_LIMIT)
        return yield* toolError(
          "too_many_proposals",
          `${PENDING_PROPOSAL_TOTAL_LIMIT} AI proposals are already waiting for the person. Nothing was proposed.`,
          REVIEW_PROPOSALS_HINT,
        );
      return yield* mailbox.perform(command, actor).pipe(Effect.mapError(toToolError));
    });

  const visibleProposals = Effect.gen(function* () {
    const allowed = new Set(yield* accountIdsFor());
    const rows = yield* mailbox.proposals;
    const owners = yield* mailbox.messageAccounts(threadsOf(rows));
    return rows.filter(visibleTo(allowed, owners));
  });
  /** One pending proposal the caller may read, or None. */
  const visibleProposal = (id: number) =>
    Effect.gen(function* () {
      const row = yield* mailbox.proposal(id).pipe(Effect.option);
      if (Option.isNone(row) || row.value.status !== "pending") return Option.none<Proposal>();
      const allowed = new Set(yield* accountIdsFor());
      const owners = yield* mailbox.messageAccounts(threadsOf([row.value]));
      return visibleTo(allowed, owners)(row.value) ? row : Option.none<Proposal>();
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
    propose,
    visibleProposals,
    visibleProposal,
  };
});
export type ToolContext = Effect.Success<typeof makeToolContext>;

/** The handler signatures for a group of tools, keyed by tool name. */
export type HandlersFor<T extends Tool.Any> = Toolkit.HandlersFrom<{
  readonly [K in T["name"]]: Extract<T, { readonly name: K }>;
}>;
