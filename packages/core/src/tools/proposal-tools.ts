/** Tools that propose changes (modify, snooze, draft) and read pending proposals. Every change waits for approval in the app. */

import {
  ACCESS_STATUS_HINT,
  AccountId,
  MailToolError,
  Rationale,
  Recipients,
  ThreadId,
  WriteResult,
  addresses,
  appTool,
  approvalCommand,
  collection,
  describe,
  mailTool,
  page,
  readOnly,
  textPage,
  toToolError,
  toolAttempt,
  toolError,
} from "./tool-common.js";
import { Effect, Schema } from "effect";
import { Tool } from "effect/ai";
import { detailParameters } from "./compose-tools.js";
import type { MailOp } from "../domain/changes.js";
import type { HandlersFor, ToolContext } from "./tool-context.js";
import { shortText } from "./tool-pages.js";

export const MODIFY_ACTIONS = [
  "archive",
  "read",
  "unread",
  "star",
  "unstar",
  "label",
  "unlabel",
] as const;
export type ModifyAction = (typeof MODIFY_ACTIONS)[number];

export const ModifyThreads = appTool("modify_threads", {
  description:
    "Propose archiving, marking read or unread, starring, or adding or removing a Gmail label on up to 20 conversations. From MCP, nothing changes until the person approves it in OpenMail. Relay the returned message and do not retry.",
  parameters: Schema.Struct({
    thread_ids: Schema.Array(ThreadId)
      .check(Schema.isMinLength(1), Schema.isMaxLength(20))
      .annotate({
        description: "Message ids from list_threads or search; each stands for its thread.",
      }),
    action: Schema.Literals(MODIFY_ACTIONS).annotate({
      description:
        "archive: remove from inbox, keep mail. read/unread and star/unstar: set flags. label/unlabel: add/remove the Gmail user label_id. Other folder moves and system labels are refused.",
    }),
    label_id: Schema.optionalKey(
      Schema.String.annotate({
        description: "Required for label and unlabel. A user label id from list_labels.",
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
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

export const DraftMessage = appTool("draft_message", {
  description:
    "Propose a new message or reply as a local draft. The person reviews, edits and sends it in OpenMail; no tool sends mail. For a reply, pass reply_to_message_id.",
  parameters: Schema.Struct({
    account_id: AccountId.annotate({ description: "The account to send from (list_accounts)." }),
    to: Recipients,
    cc: Schema.optionalKey(Recipients),
    bcc: Schema.optionalKey(Recipients),
    subject: Schema.String.check(Schema.isMaxLength(998)).annotate({
      description: "Ignored for replies, which keep the original subject.",
    }),
    body: Schema.String.check(Schema.isMaxLength(24_000)).annotate({
      description: "Plain-text body. No HTML.",
    }),
    reply_to_message_id: Schema.optionalKey(
      Schema.String.annotate({
        description: "The message id from read_thread that this replies to, in the same account.",
      }),
    ),
    mode: Schema.optionalKey(
      Schema.Literals(["new", "reply", "replyAll"]).annotate({
        description:
          "new, reply or replyAll. Default: reply when reply_to_message_id is set, else new.",
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
const ProposalSummary = Schema.Struct({
  id: Schema.Number,
  createdAt: Schema.Number,
  agent: Schema.String,
  kind: Schema.String,
  rationale: Schema.String,
});
export const ListProposals = collection(
  "list_proposals",
  "List proposals waiting for the person's approval in OpenMail. Pass an id to read_proposal; no tool approves, rejects or sends. Page with next_cursor.",
  ProposalSummary,
);
export const ReadProposal = readOnly(
  mailTool("read_proposal", {
    description:
      "Read one pending proposal as the JSON the approval screen shows. Use an id from list_proposals. Long JSON pages with next_offset; join the chunks.",
    parameters: Schema.Struct(detailParameters),
    success: Schema.Struct({
      id: Schema.Number,
      command_json: Schema.String,
      next_offset: Schema.optionalKey(Schema.Int),
    }),
    failure: MailToolError,
    failureMode: "return",
  }),
);
export const SnoozeThreads = appTool("snooze_threads", {
  description:
    "Propose snoozing up to 20 conversations until a time. Nothing is snoozed until the person approves it in OpenMail. Relay the returned message and do not retry.",
  parameters: Schema.Struct({
    thread_ids: Schema.Array(ThreadId).check(Schema.isMinLength(1), Schema.isMaxLength(20)),
    due: Schema.Finite.annotate({
      description: "When the conversations return to the inbox, in epoch milliseconds.",
    }),
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

export function opFor(action: ModifyAction, labelId: string | undefined): MailOp | undefined {
  switch (action) {
    case "archive":
      return { kind: action };
    case "read":
    case "star":
      return { kind: action, value: true };
    case "unread":
      return { kind: "read", value: false };
    case "unstar":
      return { kind: "star", value: false };
    default:
      return labelId ? { kind: "label", labelId, value: action === "label" } : undefined;
  }
}

export const proposalHandlers = ({
  mailbox,
  identity,
  agent,
  accountIdsFor,
  requireMessage,
  requireThreads,
  visibleProposals,
}: ToolContext) => {
  return {
    list_proposals: (p) =>
      page(
        "list_proposals",
        p,
        Effect.map(visibleProposals, (rows) =>
          rows.map((r) => ({
            id: r.id,
            createdAt: r.createdAt,
            agent: r.actor.kind === "agent" ? shortText(r.actor.name) : r.actor.surface,
            kind: r.command.kind,
            rationale: r.actor.kind === "agent" ? shortText(r.actor.rationale ?? "") : "",
          })),
        ),
      ),
    read_proposal: Effect.fnUntraced(function* (p) {
      const row = (yield* visibleProposals).find((r) => String(r.id) === p.id);
      if (!row)
        return yield* toolError(
          "not_found",
          `No pending proposal with id ${p.id}.`,
          "Get pending proposal ids from list_proposals.",
        );
      return yield* toolAttempt(() => {
        const { text, ...rest } = textPage(
          { id: row.id },
          JSON.stringify(approvalCommand(row.command)),
          { ...p, token_budget: p.token_budget - 64 },
        );
        return { ...rest, command_json: text };
      });
    }),
    modify_threads: Effect.fnUntraced(function* (p) {
      yield* requireThreads(p.thread_ids);
      const op = opFor(p.action, p.label_id);
      if (!op) {
        return yield* toolError(
          "invalid_input",
          `${p.action} needs label_id.`,
          "Get a user label id from list_labels.",
        );
      }
      const actor = yield* agent(p.rationale);
      const outcome = yield* mailbox
        .perform({ kind: "modify", threads: p.thread_ids, op }, actor)
        .pipe(Effect.mapError(toToolError));
      return {
        outcome,
        message: yield* describe(
          outcome,
          `Applied ${p.action} to ${p.thread_ids.length} thread(s).`,
        ),
      };
    }),
    snooze_threads: Effect.fnUntraced(function* (p) {
      yield* requireThreads(p.thread_ids);
      const actor = yield* agent(p.rationale);
      const outcome = yield* mailbox
        .perform({ kind: "snooze", threads: p.thread_ids, due: p.due }, actor)
        .pipe(Effect.mapError(toToolError));
      return { outcome, message: yield* describe(outcome, "Snoozed conversations.") };
    }),
    draft_message: Effect.fnUntraced(function* (p) {
      if ((yield* identity.current).surface === "mcp") {
        if (!(yield* accountIdsFor(p.account_id)).length)
          return yield* toolError(
            "no_ai_consent",
            `Account ${p.account_id} is unknown, turned off, or does not allow AI access.`,
            ACCESS_STATUS_HINT,
          );
        if (p.reply_to_message_id) yield* requireMessage(p.reply_to_message_id);
      }
      const to = yield* addresses(p.to);
      const cc = yield* addresses(p.cc);
      const bcc = yield* addresses(p.bcc);
      if (to.length + cc.length + bcc.length === 0) {
        return yield* toolError("invalid_input", "The draft needs at least one recipient.");
      }
      const actor = yield* agent(p.rationale);
      const mode = p.mode ?? (p.reply_to_message_id ? "reply" : "new");
      if ((mode === "new") === Boolean(p.reply_to_message_id))
        return yield* toolError(
          "invalid_input",
          "New drafts cannot have reply_to_message_id; replies require one.",
        );
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
        message: yield* describe(
          outcome,
          "Saved as a draft.",
          (id) =>
            `Saved as a draft for the person to review (proposal ${id}). They send it or discard it in OpenMail. Nothing has been sent.`,
        ),
      };
    }),
  } satisfies HandlersFor<
    | typeof ListProposals
    | typeof ReadProposal
    | typeof ModifyThreads
    | typeof SnoozeThreads
    | typeof DraftMessage
  >;
};
