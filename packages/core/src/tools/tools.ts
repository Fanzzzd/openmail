/**
 * MailToolkit: the mail tools the CLI, the MCP server and the in-app assistant
 * share. Each *-tools.ts module defines one group of tools and its handlers;
 * this module combines them into toolkits and the handler layer.
 */
import { Toolkit } from "effect/ai";
import {
  AccessStatus,
  ListAccounts,
  ListLabels,
  ListProfiles,
  accountHandlers,
} from "./account-tools.js";
import {
  ListThreads,
  ReadThread,
  Search,
  SemanticSearch,
  Sync,
  threadHandlers,
} from "./thread-tools.js";
import {
  ListSignatures,
  ListTemplates,
  ReadSignature,
  ReadTemplate,
  SuggestContacts,
  composeHandlers,
} from "./compose-tools.js";
import { CalendarOverlap, ListInvites, calendarHandlers } from "./calendar-tools.js";
import { AttachmentText, ListAttachments, attachmentHandlers } from "./attachment-tools.js";
import {
  DraftMessage,
  ListProposals,
  ModifyThreads,
  ReadProposal,
  SnoozeThreads,
  proposalHandlers,
} from "./proposal-tools.js";
import { Effect, Exit } from "effect";
import { makeToolContext } from "./tool-context.js";
import { cleanMcpClientName } from "./agent-identity.js";
import { CONSENT_SWITCH } from "./tool-common.js";
import { Mailbox } from "../mailbox/mailbox.js";

export const ReadMailToolkit = Toolkit.make(
  AccessStatus,
  ListAccounts,
  ListProfiles,
  ListLabels,
  ListThreads,
  Search,
  SemanticSearch,
  ReadThread,
  Sync,
  ListTemplates,
  ReadTemplate,
  ListSignatures,
  ReadSignature,
  SuggestContacts,
  ListInvites,
  CalendarOverlap,
  ListAttachments,
  AttachmentText,
  ListProposals,
  ReadProposal,
);
export const ProposalMailToolkit = Toolkit.make(ModifyThreads, SnoozeThreads, DraftMessage);

export const MailToolkit = Toolkit.make(
  ...Object.values(ReadMailToolkit.tools),
  ...Object.values(ProposalMailToolkit.tools),
);

export const AssistantToolkit = Toolkit.make(
  ListAccounts,
  ListLabels,
  Search,
  SemanticSearch,
  ReadThread,
  ModifyThreads,
  DraftMessage,
);

export const MailToolkitLayer = MailToolkit.toLayer(
  Effect.gen(function* () {
    const context = yield* makeToolContext;
    const { mailbox, identity } = context;
    const handlers = MailToolkit.of({
      ...accountHandlers(context),
      ...threadHandlers(context),
      ...composeHandlers(context),
      ...calendarHandlers(context),
      ...attachmentHandlers(context),
      ...proposalHandlers(context),
    });

    /** MCP calls leave a row in agent_activity, so Settings can show what each AI app did. */
    const tracked = <A, E, R>(tool: string, effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.onExit((exit) =>
          Effect.flatMap(identity.current, (current) =>
            current.recordsActivity
              ? mailbox.proposals.recordAgentActivity({
                  client: cleanMcpClientName(current.name),
                  tool,
                  ok: Exit.isSuccess(exit),
                })
              : Effect.void,
          ).pipe(Effect.ignore),
        ),
      );
    return MailToolkit.of(wrapHandlers(handlers, tracked));
  }),
);

type AnyHandler = (params: never) => Effect.Effect<unknown, unknown, unknown>;

/** Runs every handler through `wrap`, which gets the tool name and keeps the effect's types. */
function wrapHandlers<H extends Record<string, AnyHandler>>(
  handlers: H,
  wrap: <A, E, R>(tool: string, effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>,
): H {
  const wrapped: Record<string, AnyHandler> = {};
  for (const [tool, handler] of Object.entries(handlers)) {
    wrapped[tool] = (params) => wrap(tool, handler(params));
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- same keys, and each wrapper keeps its handler's signature; Object.entries loses that.
  return wrapped as H;
}

/** Tools whose results narrow to the accounts an agent may read, and are empty without one. */
const ACCOUNT_SCOPED_TOOLS: ReadonlySet<string> = new Set([
  "list_accounts",
  "list_labels",
  "list_threads",
  "search",
  "semantic_search",
  "suggest_contacts",
  "list_proposals",
  "sync",
]);

const TURN_ON_CONSENT = `Only the person can turn on ${CONSENT_SWITCH}, in Settings → AI Access.`;

const stringParam = (input: unknown, key: string): string | undefined => {
  if (typeof input !== "object" || input === null) return undefined;
  const value: unknown = Reflect.get(input, key);
  return typeof value === "string" ? value : undefined;
};

/**
 * Why a tool call would read no account: an unknown or turned-off account id, an unknown
 * space, or no account with AI consent (in the space, when one is given). Null when it can
 * read one. MCP clients get the tool's own result; the CLI prints this on stderr next to it,
 * so a person sees why the result is empty.
 */
export const agentAccountGap = (tool: string, input: unknown) =>
  Effect.gen(function* () {
    const accountId = stringParam(input, "account_id");
    const profileId = stringParam(input, "profile_id");
    if (accountId === undefined && profileId === undefined && !ACCOUNT_SCOPED_TOOLS.has(tool))
      return null;
    const mailbox = yield* Mailbox;
    const accounts = yield* mailbox.accounts.accounts;
    const consent = yield* mailbox.ai.aiAccounts;
    const allowed = (id: string) => consent.some((s) => s.accountId === id && s.allowed);
    if (
      profileId !== undefined &&
      !(yield* mailbox.accounts.profiles).some((p) => p.id === profileId)
    )
      return `No space with id ${profileId}. Run \`openmail spaces list\` to see them.`;
    const inScope = accounts.filter((a) => profileId === undefined || a.profileId === profileId);
    if (accountId !== undefined) {
      const account = accounts.find((a) => a.id === accountId);
      if (!account)
        return `No account with id ${accountId}. Run \`openmail accounts list\` to see them.`;
      if (!inScope.includes(account)) return `Account ${accountId} is not in space ${profileId}.`;
      if (account.enabled === false) return `Account ${accountId} is turned off in OpenMail.`;
      return allowed(accountId)
        ? null
        : `Account ${accountId} does not allow AI access. ${TURN_ON_CONSENT}`;
    }
    const enabled = inScope.filter((a) => a.enabled !== false);
    if (profileId !== undefined) {
      if (!enabled.length) return `Space ${profileId} has no enabled mail accounts.`;
      return enabled.some((a) => allowed(a.id))
        ? null
        : `No account in space ${profileId} allows AI access. ${TURN_ON_CONSENT}`;
    }
    if (!enabled.length) return "No mail account is turned on in OpenMail.";
    return enabled.some((a) => allowed(a.id))
      ? null
      : `No account allows AI access. ${TURN_ON_CONSENT}`;
  });
