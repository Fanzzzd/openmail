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
import { Clock, Context, Duration, Effect, Exit, Semaphore } from "effect";
import { logWarning } from "../domain/diagnostic-log.js";
import { makeToolContext } from "./tool-context.js";
import { cleanMcpClientName } from "./agent-identity.js";
import {
  CONSENT_SWITCH,
  type MailToolError,
  ToolFailure,
  busyToolError,
  isLockTimeout,
} from "./tool-common.js";
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

/**
 * Runs once before every tool call, before the handler touches the Mailbox. A failure becomes
 * the call's result. The in-app assistant charges its tool-call budget here.
 */
export const ToolGate = Context.Reference<Effect.Effect<void, MailToolError>>("openmail/ToolGate", {
  defaultValue: () => Effect.void,
});

interface ActivityEntry {
  readonly client: string;
  readonly tool: string;
  readonly ok: boolean;
  /** When the call ended. A row that waits for the write lock keeps this time. */
  readonly at: number;
}
/** How often rows that met another process's write lock are tried again. */
const ACTIVITY_RETRY_SPACING = Duration.seconds(1);

export const MailToolkitLayer = MailToolkit.toLayer(
  Effect.gen(function* () {
    const context = yield* makeToolContext;
    const { mailbox, identity } = context;
    const gate = yield* ToolGate;
    const handlers = MailToolkit.of({
      ...accountHandlers(context),
      ...threadHandlers(context),
      ...composeHandlers(context),
      ...calendarHandlers(context),
      ...attachmentHandlers(context),
      ...proposalHandlers(context),
    });

    /**
     * agent_activity rows that met another process's write lock, oldest first. The tool's
     * result does not wait for them: a background fiber retries them, and closing the server
     * tries once more and logs the rows it drops.
     */
    const unrecorded: ActivityEntry[] = [];
    /** Writes the waiting rows in order; false when the lock is still held. One at a time. */
    const writing = yield* Semaphore.make(1);
    const writeUnrecorded = Effect.gen(function* () {
      for (let entry = unrecorded[0]; entry; entry = unrecorded[0]) {
        const written = yield* mailbox.proposals.recordAgentActivity(entry).pipe(
          Effect.as(true),
          Effect.catchTag("DatabaseBusy", () => Effect.succeed(false)),
        );
        if (!written) return false;
        unrecorded.shift();
      }
      return true;
    }).pipe(writing.withPermits(1));
    yield* Effect.addFinalizer(() =>
      writeUnrecorded.pipe(
        Effect.flatMap((done) =>
          done
            ? Effect.void
            : logWarning(
                "agent-activity-dropped",
                "Another process kept the database's write lock, so AI activity rows were not saved",
                { rows: unrecorded.length },
              ),
        ),
        Effect.ignoreCause,
      ),
    );
    /** Retries the waiting rows every ACTIVITY_RETRY_SPACING until they are written. */
    const scope = yield* Effect.scope;
    let retrying = false;
    const retryLater = Effect.suspend(() => {
      if (retrying) return Effect.void;
      retrying = true;
      return Effect.sleep(ACTIVITY_RETRY_SPACING).pipe(
        Effect.andThen(writeUnrecorded),
        Effect.repeat({ until: (done) => done }),
        Effect.ensuring(Effect.sync(() => (retrying = false))),
        Effect.ignoreCause,
        Effect.forkIn(scope),
        Effect.asVoid,
      );
    });
    const record = (entry: ActivityEntry) => {
      unrecorded.push(entry);
      return Effect.flatMap(writeUnrecorded, (done) => (done ? Effect.void : retryLater));
    };

    /** MCP calls leave a row in agent_activity, so Settings can show what each AI app did. */
    const tracked = <A, E, R>(tool: string, effect: Effect.Effect<A, E, R>) =>
      Effect.andThen(gate, effect).pipe(
        Effect.catchDefect((defect) =>
          defect instanceof ToolFailure
            ? Effect.fail(defect.error)
            : isLockTimeout(defect)
              ? Effect.fail(busyToolError())
              : Effect.die(defect),
        ),
        Effect.onExit((exit) =>
          Effect.gen(function* () {
            const current = yield* identity.current;
            if (!current.recordsActivity) return;
            yield* record({
              client: cleanMcpClientName(current.name),
              tool,
              ok: Exit.isSuccess(exit),
              at: yield* Clock.currentTimeMillis,
            });
          }).pipe(Effect.ignoreCause),
        ),
      );
    return MailToolkit.of(wrapHandlers(handlers, tracked));
  }),
);

type AnyHandler = (params: never) => Effect.Effect<unknown, unknown, unknown>;

/** Runs every handler through `wrap`, which gets the tool name and keeps the effect's types; every handler already fails with MailToolError. */
function wrapHandlers<H extends Record<string, AnyHandler>>(
  handlers: H,
  wrap: <A, E, R>(
    tool: string,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | MailToolError, R>,
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
