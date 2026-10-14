/** Tools that propose changes (modify, snooze, draft) and read pending proposals. Every change waits for approval in the app. */

import {
  ADDRESS_HINT,
  AccountId,
  MESSAGE_ID_HINT,
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
import { localIso } from "../platform/host.js";
import { Clock, Effect, Option, Schema } from "effect";
import { replyRecipients, replySubject } from "../compose/recipients.js";
import { Tool } from "effect/ai";
import { pageParameters } from "./compose-tools.js";
import type { MailOp } from "../domain/changes.js";
import type { HandlersFor, ToolContext } from "./tool-context.js";
import { ToolInt, shortText } from "./tool-pages.js";

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

/** The draft_message mode as the tool takes it, and as a draft stores it. */
const COMPOSE_MODES = { new: "new", reply: "reply", reply_all: "replyAll" } as const;

/** How far ahead snooze_threads may snooze, as Mailbox.perform allows. */
const SNOOZE_HORIZON_MS = 365 * 86_400_000;
const SNOOZE_DUE_HINT =
  "Pass due as a future time within the next year, as ISO 8601 with a UTC offset, such as 2026-10-15T09:00:00+08:00. access_status gives now and time_zone.";
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?/;
const ISO_OFFSET = /(?:Z|[+-]\d{2}:\d{2})$/i;

/**
 * The instant `due` names, or a tool error. ISO 8601 needs an offset: without one the time is
 * ambiguous, so it fails with a hint instead of being read in some zone. Epoch milliseconds
 * still work for older clients.
 */
export function snoozeDue(due: number | string): Effect.Effect<number, MailToolError> {
  if (typeof due === "number") return Effect.succeed(due);
  const text = due.trim();
  if (!ISO_TIME.test(text))
    return Effect.fail(
      toolError(
        "invalid_input",
        `due ${JSON.stringify(shortText(text, 64))} is not a time.`,
        SNOOZE_DUE_HINT,
      ),
    );
  if (!ISO_OFFSET.test(text))
    return Effect.fail(
      toolError(
        "invalid_input",
        `due ${JSON.stringify(shortText(text, 64))} has no UTC offset, so the time is ambiguous.`,
        "Add the offset of the person's time zone, such as 2026-10-15T09:00:00+08:00. access_status gives time_zone and now.",
      ),
    );
  const ms = Date.parse(text);
  return Number.isFinite(ms)
    ? Effect.succeed(ms)
    : Effect.fail(
        toolError(
          "invalid_input",
          `due ${JSON.stringify(shortText(text, 64))} is not a valid date.`,
          SNOOZE_DUE_HINT,
        ),
      );
}

export const ModifyThreads = appTool("modify_threads", {
  description:
    "Propose archiving, marking read or unread, starring, or adding or removing a Gmail label on up to 20 conversations. From MCP, nothing changes until the person approves it in OpenMail. Relay the returned message and do not retry.",
  parameters: Schema.Struct({
    message_ids: Schema.Array(ThreadId)
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
        description:
          "Required for label and unlabel, refused with other actions. A user label id from list_labels.",
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
    to: Schema.optionalKey(
      Recipients.annotate({
        description:
          'Required for new messages. A reply without to, cc and bcc goes to the original\'s sender, or to everyone on it for reply_all. Entries are "name@example.com" or "Name <name@example.com>".',
      }),
    ),
    cc: Schema.optionalKey(Recipients),
    bcc: Schema.optionalKey(Recipients),
    subject: Schema.optionalKey(
      Schema.String.check(Schema.isMaxLength(998)).annotate({
        description: "Required for new messages. Replies default to Re: and the original subject.",
      }),
    ),
    body: Schema.String.check(Schema.isMaxLength(24_000)).annotate({
      description: "Plain-text body. No HTML.",
    }),
    reply_to_message_id: Schema.optionalKey(
      Schema.String.annotate({
        description: "The message id from read_thread that this replies to, in the same account.",
      }),
    ),
    mode: Schema.optionalKey(
      Schema.Literals(["new", "reply", "reply_all"]).annotate({
        description:
          "new, reply or reply_all. Default: reply when reply_to_message_id is set, else new.",
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
  createdAt: Schema.String,
  agent: Schema.String,
  kind: Schema.String,
  rationale: Schema.String,
});
export const ListProposals = collection(
  "list_proposals",
  "List proposals waiting for the person's approval in OpenMail. Pass an id to read_proposal; no tool approves, rejects or sends. Page with next_cursor.",
  ProposalSummary,
  true,
);
export const ReadProposal = readOnly(
  mailTool("read_proposal", {
    description:
      "Read one pending proposal as the approval screen shows it. Use an id from list_proposals. A long draft body pages with next_offset.",
    times: true,
    parameters: Schema.Struct({
      // list_proposals returns the id as a number. Older clients send it as a string.
      id: Schema.Union([ToolInt, Schema.String]).annotate({
        description: "A pending proposal id from list_proposals, as list_proposals returns it.",
      }),
      ...pageParameters,
    }),
    success: Schema.Struct({
      id: Schema.Number,
      command: Schema.Record(Schema.String, Schema.Unknown).annotate({
        description:
          "The change: kind, then threads and op, due, or account and message. A draft's message.text is one page of the body.",
      }),
      next_offset: Schema.optionalKey(ToolInt),
    }),
    failure: MailToolError,
    failureMode: "return",
  }),
);
export const SnoozeThreads = appTool("snooze_threads", {
  description:
    "Propose snoozing up to 20 conversations until a time. Nothing is snoozed until the person approves it in OpenMail. Relay the returned message and do not retry.",
  parameters: Schema.Struct({
    message_ids: Schema.Array(ThreadId)
      .check(Schema.isMinLength(1), Schema.isMaxLength(20))
      .annotate({
        description: "Message ids from list_threads or search; each stands for its thread.",
      }),
    due: Schema.Union([Schema.String, Schema.Finite]).annotate({
      description:
        "When the conversations return to the inbox: a future time within the next year, as ISO 8601 with a UTC offset, such as 2026-10-15T09:00:00+08:00. Epoch milliseconds also work.",
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

/**
 * A proposal as an object. Only a draft or send has long text, its body, so that pages with
 * next_offset; everything else fits in one result.
 */
function proposalPage(
  id: number,
  command: ReturnType<typeof approvalCommand>,
  p: { readonly offset: number; readonly token_budget: number },
) {
  if (command.kind !== "draft" && command.kind !== "send") {
    if (p.offset > 0) throw new Error("offset is beyond the text.");
    return { id, command };
  }
  // The header carries an empty body, so the page size counts the body once.
  const header = { id, command: { ...command, message: { ...command.message, text: "" } } };
  const { text, next_offset } = textPage(header, command.message.text, p);
  return {
    id,
    command: { ...command, message: { ...command.message, text } },
    ...(next_offset === undefined ? {} : { next_offset }),
  };
}

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
  timeZone,
  agent,
  accountIdsFor,
  requireMessage,
  requireThreads,
  propose,
  visibleProposals,
  visibleProposal,
}: ToolContext) => {
  return {
    list_proposals: (p) =>
      page(
        "list_proposals",
        p,
        Effect.map(visibleProposals, (rows) =>
          rows.map((r) => ({
            id: r.id,
            createdAt: localIso(r.createdAt, timeZone()),
            agent: r.actor.kind === "agent" ? shortText(r.actor.name) : r.actor.surface,
            kind: r.command.kind,
            rationale: r.actor.kind === "agent" ? shortText(r.actor.rationale ?? "") : "",
          })),
        ),
      ),
    read_proposal: Effect.fnUntraced(function* (p) {
      const id = String(p.id);
      const row = /^[1-9]\d{0,15}$/.test(id)
        ? Option.getOrUndefined(yield* visibleProposal(Number(id)))
        : undefined;
      if (!row)
        return yield* toolError(
          "not_found",
          `No pending proposal with id ${p.id}.`,
          "Get pending proposal ids from list_proposals.",
        );
      return yield* toolAttempt(() =>
        proposalPage(row.id, approvalCommand(row.command, timeZone()), p),
      );
    }),
    modify_threads: Effect.fnUntraced(function* (p) {
      if (p.label_id !== undefined && p.action !== "label" && p.action !== "unlabel")
        return yield* toolError(
          "invalid_input",
          `label_id works only with action label or unlabel, not ${p.action}.`,
          `Leave out label_id to ${p.action}, or set action to label or unlabel.`,
        );
      yield* requireThreads(p.message_ids);
      const op = opFor(p.action, p.label_id);
      if (!op) {
        return yield* toolError(
          "invalid_input",
          `${p.action} needs label_id.`,
          "Get a user label id from list_labels.",
        );
      }
      const actor = yield* agent(p.rationale);
      const outcome = yield* propose({ kind: "modify", threads: p.message_ids, op }, actor);
      return {
        outcome,
        message: yield* describe(
          outcome,
          `Applied ${p.action} to ${p.message_ids.length} thread(s).`,
        ),
      };
    }),
    snooze_threads: Effect.fnUntraced(function* (p) {
      const now = yield* Clock.currentTimeMillis;
      const due = yield* snoozeDue(p.due);
      if (due <= now)
        return yield* toolError(
          "invalid_input",
          `The snooze time ${localIso(due, timeZone())} is in the past. It is now ${localIso(now, timeZone())}.`,
          SNOOZE_DUE_HINT,
        );
      if (due > now + SNOOZE_HORIZON_MS)
        return yield* toolError(
          "invalid_input",
          "The snooze time is more than a year away.",
          SNOOZE_DUE_HINT,
        );
      yield* requireThreads(p.message_ids);
      const actor = yield* agent(p.rationale);
      const outcome = yield* propose({ kind: "snooze", threads: p.message_ids, due }, actor);
      return { outcome, message: yield* describe(outcome, "Snoozed conversations.") };
    }),
    draft_message: Effect.fnUntraced(function* (p) {
      const mcp = (yield* identity.current).surface === "mcp";
      if (mcp) yield* accountIdsFor(p.account_id);
      const mode = COMPOSE_MODES[p.mode ?? (p.reply_to_message_id ? "reply" : "new")];
      if (mode === "new" && p.reply_to_message_id !== undefined)
        return yield* toolError(
          "invalid_input",
          "A new message cannot have reply_to_message_id.",
          "To reply to that message, leave out mode or set it to reply or reply_all. For a new message, leave out reply_to_message_id.",
        );
      if (mode !== "new" && p.reply_to_message_id === undefined)
        return yield* toolError(
          "invalid_input",
          `A ${p.mode === "reply_all" ? "reply to all" : "reply"} needs reply_to_message_id.`,
          "Pass reply_to_message_id, the id from read_thread of the message you reply to, or set mode to new.",
        );
      const replyId = p.reply_to_message_id;
      const original =
        replyId === undefined
          ? undefined
          : mcp
            ? yield* requireMessage(replyId)
            : (yield* mailbox.reading.thread(replyId).pipe(Effect.mapError(toToolError))).find(
                (m) => m.id === replyId,
              );
      if (replyId !== undefined && !original)
        return yield* toolError("not_found", `No message with id ${replyId}.`, MESSAGE_ID_HINT);
      const subject = p.subject ?? (original ? replySubject(original.subject) : undefined);
      if (subject === undefined)
        return yield* toolError(
          "invalid_input",
          "A new message needs a subject.",
          "Pass subject. A reply takes the original's subject when you pass reply_to_message_id.",
        );
      let to = yield* addresses(p.to);
      let cc = yield* addresses(p.cc);
      const bcc = yield* addresses(p.bcc);
      if (original && p.to === undefined && p.cc === undefined && p.bcc === undefined) {
        // The person's own addresses never become reply recipients.
        const own = [
          ...(yield* mailbox.accounts.accounts)
            .filter((a) => a.id === p.account_id)
            .map((a) => a.email),
          ...(yield* mailbox.organize.sendAs)
            .filter((a) => a.accountId === p.account_id)
            .map((a) => a.address),
        ];
        ({ to, cc } = replyRecipients(original, own, mode === "replyAll"));
      }
      if (to.length + cc.length + bcc.length === 0) {
        return yield* toolError(
          "invalid_input",
          "The draft needs at least one recipient.",
          original
            ? `The original has no one to reply to besides the person. Pass to. ${ADDRESS_HINT}`
            : `Pass to with at least one address. ${ADDRESS_HINT}`,
        );
      }
      const actor = yield* agent(p.rationale);
      const outcome = yield* propose(
        {
          kind: "draft",
          accountId: p.account_id,
          message: {
            to,
            cc,
            bcc,
            subject,
            text: p.body,
            attachments: [],
            mode,
            ...(p.reply_to_message_id ? { inReplyTo: p.reply_to_message_id } : {}),
          },
        },
        actor,
      );
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
