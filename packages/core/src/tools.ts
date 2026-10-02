/**
 * The tools a language model gets. The MCP server and the in-app assistant
 * both use `MailToolkit`, so each tool is defined once. Every change goes
 * through `Mailbox.perform` as an agent, which means policy decides whether
 * it runs, waits for the person, or is refused. No tool sends mail; a drafted
 * message becomes a synced draft that only the person can send.
 */
import { Context, Effect, Layer, Option, Schema } from "effect";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import {
  Account,
  type Actor,
  type Address,
  ComposeMode,
  Label,
  MAILBOXES,
  type MailOp,
  Outcome,
  Profile,
  SyncResult,
  ThreadSummary,
} from "./domain.js";
import { Mailbox, ModelThread, type PerformError } from "./mailbox.js";
import { parseAddressList } from "./mime.js";

type AgentSurface = Extract<Actor, { kind: "agent" }>["surface"];

/**
 * Who the model is. Read on every call: one MCP server can serve several
 * clients, and the client name keys the agent's policy and audit entries.
 */
export class AgentIdentity extends Context.Service<
  AgentIdentity,
  { readonly current: Effect.Effect<{ readonly surface: AgentSurface; readonly name: string }> }
>()("openmail/AgentIdentity") {
  /** The MCP client's name from its initialize request, or "mcp" when it sent none. */
  static readonly mcp = Layer.succeed(AgentIdentity, {
    current: Effect.serviceOption(McpSchema.McpRequestContext).pipe(
      Effect.map((ctx) => ({
        surface: "mcp" as const,
        name: Option.getOrUndefined(ctx)?.clientInfo?.name || "mcp",
      })),
    ),
  });

  static fixed(surface: AgentSurface, name: string): Layer.Layer<AgentIdentity> {
    return Layer.succeed(AgentIdentity, { current: Effect.succeed({ surface, name }) });
  }
}

/** What a tool call returns when it fails. The message is written for the model to relay. */
export class MailToolError extends Schema.TaggedError<MailToolError>()("MailToolError", {
  message: Schema.String,
}) {}

// Parameters

const AccountId = Schema.String.annotate({
  description: "Account id from list_accounts, such as gmail:me@example.com",
});
const ThreadId = Schema.String.annotate({
  description: "A message id from list_threads or search. It stands for its whole thread.",
});
const Limit = (fallback: number) =>
  Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))
    .annotate({ description: `Maximum number of threads, 1 to 100. Default ${fallback}.` })
    .pipe(Schema.withDecodingDefaultKey(Effect.succeed(fallback)));
const Rationale = Schema.String.check(Schema.isMinLength(1)).annotate({
  description:
    "One or two sentences on why, written for the person. They see it when they review your request.",
});
const Recipients = Schema.Array(Schema.String).annotate({
  description: 'Addresses as "name@example.com" or "Name <name@example.com>".',
});

interface ToolConfig {
  readonly parameters: Schema.Constraint;
  readonly success: Schema.Constraint;
  readonly failure: Schema.Constraint;
  readonly failureMode: Tool.FailureMode;
}

function readOnly<N extends string, C extends ToolConfig>(tool: Tool.Tool<N, C>): Tool.Tool<N, C> {
  return tool
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true)
    .annotate(Tool.OpenWorld, false);
}

const WriteResult = Schema.Struct({
  outcome: Outcome,
  /** One sentence for the model to pass on to the person. */
  message: Schema.String,
});

// Tools

export const toModelAccount = ({ id, provider, email, needsReauth }: Account) => ({
  id,
  provider,
  email,
  needsReauth,
});

const ListAccounts = readOnly(
  Tool.make("list_accounts", {
    description:
      "List the person's connected mail accounts. Each id is used as account_id by the other tools. needsReauth means the account must be signed in again in openmail.",
    success: Schema.Struct({
      accounts: Schema.Array(
        Schema.Struct({
          id: Account.fields.id,
          provider: Account.fields.provider,
          email: Account.fields.email,
          needsReauth: Account.fields.needsReauth,
        }),
      ),
    }),
    failure: MailToolError,
    failureMode: "return",
  }),
);

const ListProfiles = readOnly(
  Tool.make("list_profiles", {
    description:
      "List profiles: named groups of accounts such as Work and Personal. Pass a profile id as profile_id to list_threads.",
    success: Schema.Struct({ profiles: Schema.Array(Profile) }),
    failure: MailToolError,
    failureMode: "return",
  }),
);

const ListLabels = readOnly(
  Tool.make("list_labels", {
    description:
      "List user labels (Gmail) and folders (Outlook, IMAP) per account. Pass a label id as label to list_threads, or as label_id to modify_threads.",
    parameters: Schema.Struct({
      account_id: Schema.optionalKey(AccountId),
    }),
    success: Schema.Struct({ labels: Schema.Array(Label) }),
    failure: MailToolError,
    failureMode: "return",
  }),
);

const ListThreads = readOnly(
  Tool.make("list_threads", {
    description:
      "List conversations in a mailbox across all accounts, newest first. Each row is the newest message of a thread; pass its id to read_thread or modify_threads. Reads the local copy; call sync first if the person asks about mail that just arrived. To page, pass next_before from the previous result as before.",
    parameters: Schema.Struct({
      mailbox: Schema.Literals(MAILBOXES)
        .annotate({ description: "Which mailbox. Default inbox." })
        .pipe(Schema.withDecodingDefaultKey(Effect.succeed("inbox" as const))),
      account_id: Schema.optionalKey(AccountId),
      profile_id: Schema.optionalKey(
        Schema.String.annotate({ description: "Only accounts in this profile (list_profiles)." }),
      ),
      label: Schema.optionalKey(
        Schema.String.annotate({
          description:
            "Only threads with this label or folder id (list_labels), or a Gmail category such as CATEGORY_PROMOTIONS.",
        }),
      ),
      unread_only: Schema.optionalKey(
        Schema.Boolean.annotate({ description: "Only unread threads." }),
      ),
      before: Schema.optionalKey(
        Schema.Finite.annotate({
          description:
            "Epoch milliseconds. Only threads older than this. Use next_before from the last page.",
        }),
      ),
      limit: Limit(25),
    }),
    success: Schema.Struct({
      threads: Schema.Array(ThreadSummary),
      next_before: Schema.optionalKey(
        Schema.Finite.annotate({
          description: "Pass as before to get the next page. Absent on the last page.",
        }),
      ),
    }),
    failure: MailToolError,
    failureMode: "return",
  }),
);

const Search = readOnly(
  Tool.make("search", {
    description:
      "Search local mail and on-device OCR/PDF text. With opt-in local models, text and image vectors are fused with full-text hits by reciprocal rank. Supports from:, is:unread, has:image and in:attachment. derivedMatches contains matched text with attachment name/index, PDF page or original image region and pipeline provenance. Never returns image bytes.",
    parameters: Schema.Struct({
      query: Schema.String.check(Schema.isMinLength(1)).annotate({ description: "Words to find." }),
      account_id: Schema.optionalKey(AccountId),
      limit: Limit(20),
    }),
    success: Schema.Struct({ threads: Schema.Array(ThreadSummary) }),
    failure: MailToolError,
    failureMode: "return",
  }),
);

const ReadThread = readOnly(
  Tool.make("read_thread", {
    description:
      "Read a whole conversation as plain text, oldest message first. Quoted history and signatures are cut. truncated counts characters dropped to fit max_chars.",
    parameters: Schema.Struct({
      id: ThreadId,
      max_chars: Schema.Int.check(Schema.isBetween({ minimum: 500, maximum: 100_000 }))
        .annotate({
          description: "Character budget for all message bodies together. Default 12000.",
        })
        .pipe(Schema.withDecodingDefaultKey(Effect.succeed(12_000))),
    }),
    success: ModelThread,
    failure: MailToolError,
    failureMode: "return",
  }),
);

const SemanticSearch = readOnly(
  Tool.make("semantic_search", {
    description:
      "Search the existing on-device text vector index by meaning. Only opted-in selected accounts are available. MCP results can include message snippets, attachment names and derived media text matches; the in-app assistant redacts these fields. Never downloads a model or changes mail.",
    parameters: Schema.Struct({
      query: Schema.String.check(Schema.isMinLength(1)),
      account_id: Schema.optionalKey(AccountId),
      limit: Limit(5),
    }),
    success: Schema.Struct({ threads: Schema.Array(ThreadSummary) }),
    failure: MailToolError,
    failureMode: "return",
  }),
);

const Sync = Tool.make("sync", {
  description:
    "Fetch new and changed mail from the providers into the local copy, and push changes already approved. Call it when the person asks about mail from the last few minutes. Changes nothing the person has not already approved.",
  parameters: Schema.Struct({
    account_id: Schema.optionalKey(
      AccountId.annotate({ description: "Only this account. Default: every account." }),
    ),
  }),
  success: Schema.Struct({ results: Schema.Array(SyncResult) }),
  failure: MailToolError,
  failureMode: "return",
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

export const MODIFY_ACTIONS = [
  "archive",
  "inbox",
  "trash",
  "spam",
  "read",
  "unread",
  "star",
  "unstar",
  "important",
  "unimportant",
  "label",
  "unlabel",
] as const;
export type ModifyAction = (typeof MODIFY_ACTIONS)[number];

const ModifyThreads = Tool.make("modify_threads", {
  description:
    "Archive, trash, mark, star or label whole conversations. The person's AI 权限 setting decides what happens: the change is applied, or it waits in openmail for the person to approve, or it is refused (the default). Relay the returned message. Do not retry a refused or pending request.",
  parameters: Schema.Struct({
    thread_ids: Schema.Array(ThreadId).check(Schema.isMinLength(1)).annotate({
      description: "Message ids from list_threads or search; each stands for its thread.",
    }),
    action: Schema.Literals(MODIFY_ACTIONS).annotate({
      description:
        "archive: out of the inbox, kept. inbox: back to the inbox. trash, spam: move there. read/unread, star/unstar, important/unimportant: set the flag. label/unlabel: add or remove label_id.",
    }),
    label_id: Schema.optionalKey(
      Schema.String.annotate({
        description: "Required for label and unlabel. An id from list_labels.",
      }),
    ),
    rationale: Rationale,
  }),
  success: WriteResult,
  failure: MailToolError,
  failureMode: "return",
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

const DraftMessage = Tool.make("draft_message", {
  description:
    "Write an email for the person to review. It never sends: it is saved as a draft in the person's Drafts (in openmail and, after the app's next sync, on the mail server) and listed under AI 建议. The person reads it, can edit it, and sends or discards it. There is no tool that sends mail. For a reply, pass reply_to_message_id and mode reply or replyAll; the subject and threading follow the original.",
  parameters: Schema.Struct({
    account_id: AccountId.annotate({ description: "The account to send from (list_accounts)." }),
    to: Recipients,
    cc: Schema.optionalKey(Recipients),
    bcc: Schema.optionalKey(Recipients),
    subject: Schema.String,
    body: Schema.String.annotate({ description: "Plain-text body. No HTML." }),
    reply_to_message_id: Schema.optionalKey(
      Schema.String.annotate({ description: "The message this replies to or forwards." }),
    ),
    mode: Schema.optionalKey(
      ComposeMode.annotate({
        description:
          "new, reply, replyAll or forward. Default: reply when reply_to_message_id is set, else new.",
      }),
    ),
    rationale: Rationale,
  }),
  success: WriteResult,
  failure: MailToolError,
  failureMode: "return",
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

export const MailToolkit = Toolkit.make(
  ListAccounts,
  ListProfiles,
  ListLabels,
  ListThreads,
  Search,
  SemanticSearch,
  ReadThread,
  Sync,
  ModifyThreads,
  DraftMessage,
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

// Handlers

const toToolError = (e: PerformError): MailToolError => {
  switch (e._tag) {
    case "NotFound":
      return new MailToolError({ message: `No ${e.what} with id ${e.id}.` });
    case "InvalidInput":
    case "PermanentError":
      return new MailToolError({ message: e.message });
    case "AuthError":
      return new MailToolError({
        message: `Account ${e.accountId} must be signed in again in openmail before this can run: ${e.message}`,
      });
    default:
      return new MailToolError({
        message: `The mail provider did not answer (${e.message}). Try again later.`,
      });
  }
};

export function opFor(action: ModifyAction, labelId: string | undefined): MailOp | undefined {
  switch (action) {
    case "archive":
    case "inbox":
    case "trash":
    case "spam":
      return { kind: action };
    case "read":
    case "star":
    case "important":
      return { kind: action, value: true };
    case "unread":
      return { kind: "read", value: false };
    case "unstar":
      return { kind: "star", value: false };
    case "unimportant":
      return { kind: "important", value: false };
    default:
      return labelId ? { kind: "label", labelId, value: action === "label" } : undefined;
  }
}

const SETTINGS_HINT = "The person can allow it in openmail under Settings > AI 权限.";

function describe(outcome: Outcome, applied: string): string {
  switch (outcome.status) {
    case "applied": {
      const failed = outcome.flush?.failed ?? 0;
      return failed > 0
        ? `${applied} ${failed} change(s) are queued and will reach the provider on the next sync.`
        : applied;
    }
    case "proposed":
      return `Waiting for the person to approve in openmail (proposal ${outcome.proposalId}). Nothing has changed yet.`;
    default:
      return outcome.reason.includes("AI 权限")
        ? `Not done: ${outcome.reason}`
        : `Not done: ${outcome.reason} ${SETTINGS_HINT}`;
  }
}

function addresses(raw: readonly string[] | undefined): Effect.Effect<Address[], MailToolError> {
  const list = parseAddressList((raw ?? []).join(", "));
  const bad = list.find((a) => !/^[^\s@]+@[^\s@]+$/.test(a.address));
  return bad
    ? Effect.fail(new MailToolError({ message: `Not an email address: ${bad.address}` }))
    : Effect.succeed(list);
}

export const MailToolkitLayer = MailToolkit.toLayer(
  Effect.gen(function* () {
    const mailbox = yield* Mailbox;
    const identity = yield* AgentIdentity;

    const agent = (rationale: string) =>
      Effect.map(identity.current, (id): Actor => ({
        kind: "agent",
        surface: id.surface,
        name: id.name,
        rationale,
      }));

    return MailToolkit.of({
      list_accounts: () =>
        Effect.map(mailbox.accounts, (accounts) => ({
          accounts: accounts.map(toModelAccount),
        })),

      list_profiles: () => Effect.map(mailbox.profiles, (profiles) => ({ profiles })),

      list_labels: ({ account_id }) =>
        Effect.map(mailbox.labels(account_id ? [account_id] : undefined), (labels) => ({ labels })),

      list_threads: Effect.fnUntraced(function* (p) {
        let accountIds: string[] | undefined = p.account_id ? [p.account_id] : undefined;
        if (p.profile_id) {
          const inProfile = (yield* mailbox.accounts)
            .filter((a) => a.profileId === p.profile_id)
            .map((a) => a.id);
          accountIds = accountIds ? accountIds.filter((id) => inProfile.includes(id)) : inProfile;
          if (accountIds.length === 0) return { threads: [] };
        }
        const threads = yield* mailbox
          .threads({
            mailbox: p.mailbox,
            ...(accountIds ? { accountIds } : {}),
            ...(p.label ? { label: p.label } : {}),
            ...(p.unread_only ? { unreadOnly: true } : {}),
            ...(p.before === undefined ? {} : { before: p.before }),
            limit: p.limit,
          })
          .pipe(Effect.mapError(toToolError));
        const last = threads.at(-1);
        return threads.length === p.limit && last
          ? { threads, next_before: last.date }
          : { threads };
      }),

      search: ({ query, account_id, limit }) =>
        Effect.map(
          mailbox.threads({
            search: query,
            ...(account_id ? { accountIds: [account_id] } : {}),
            limit,
          }),
          (threads) => ({ threads }),
        ).pipe(Effect.mapError(toToolError)),

      read_thread: ({ id, max_chars }) =>
        mailbox.threadForModel(id, max_chars).pipe(Effect.mapError(toToolError)),

      semantic_search: ({ query, account_id, limit }) =>
        mailbox
          .semanticSearch({
            search: query,
            accountIds: account_id ? [account_id] : undefined,
            limit,
          })
          .pipe(
            Effect.map((threads) => ({ threads })),
            Effect.mapError(toToolError),
          ),

      sync: ({ account_id }) => Effect.map(mailbox.sync(account_id), (results) => ({ results })),

      modify_threads: Effect.fnUntraced(function* (p) {
        const op = opFor(p.action, p.label_id);
        if (!op) {
          return yield* new MailToolError({
            message: `${p.action} needs label_id. Get one from list_labels.`,
          });
        }
        const actor = yield* agent(p.rationale);
        const outcome = yield* mailbox
          .perform({ kind: "modify", threads: p.thread_ids, op }, actor)
          .pipe(Effect.mapError(toToolError));
        return {
          outcome,
          message: describe(outcome, `Applied ${p.action} to ${p.thread_ids.length} thread(s).`),
        };
      }),

      draft_message: Effect.fnUntraced(function* (p) {
        const to = yield* addresses(p.to);
        const cc = yield* addresses(p.cc);
        const bcc = yield* addresses(p.bcc);
        if (to.length + cc.length + bcc.length === 0) {
          return yield* new MailToolError({ message: "The draft needs at least one recipient." });
        }
        const actor = yield* agent(p.rationale);
        const mode = p.mode ?? (p.reply_to_message_id ? "reply" : "new");
        const outcome = yield* mailbox
          .perform(
            {
              kind: "draft",
              accountId: p.account_id,
              message: {
                to,
                cc,
                bcc,
                subject: p.subject,
                text: p.body,
                attachments: [],
                mode,
                ...(p.reply_to_message_id ? { inReplyTo: p.reply_to_message_id } : {}),
              },
            },
            actor,
          )
          .pipe(Effect.mapError(toToolError));
        return {
          outcome,
          message:
            outcome.status === "proposed"
              ? `Saved as a draft for the person to review (proposal ${outcome.proposalId}). They send it or discard it in openmail. Nothing has been sent.`
              : describe(outcome, "Saved as a draft."),
        };
      }),
    });
  }),
);
