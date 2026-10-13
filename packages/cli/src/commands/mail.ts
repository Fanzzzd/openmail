/** sync, health, list, search and show: reading the local mailbox. */

import { Argument, Command, Flag } from "effect/cli";
import { fail, jsonFlag, optionalInt, optionalString, print } from "./common.js";
import { Console, Effect, Option, Schema } from "effect";
import { MAILBOXES, MailToolkit, Mailbox, redactSyncHealth } from "@openmail/core";
import { withProgress } from "../sync-progress.js";
import { invokeTool } from "./tool-runner.js";
import { messageText, syncTable } from "../format.js";
import { withToolDescription } from "../mcp-tools.js";

const health = Command.make(
  "health",
  {
    account: Flag.String("account").pipe(Flag.optional),
    json: jsonFlag,
  },
  Effect.fn(function* ({ account, json }) {
    yield* Console.error("Reading credentials from the keychain…");
    const mailbox = yield* Mailbox;
    const ids = Option.isSome(account)
      ? [account.value]
      : (yield* mailbox.accounts).map((item) => item.id);
    const reports = yield* Effect.forEach(ids, (id) =>
      mailbox.syncHealth(id).pipe(Effect.map(redactSyncHealth)),
    );
    yield* print(reports, json, (items) =>
      items
        .map((report) =>
          [
            `${report.provider} ${report.accountDomainHash}`,
            `Cursor age: ${report.cursorAgeMs === null ? "never synced" : `${report.cursorAgeMs} ms`}; pending operations: ${report.pendingOps}`,
            "Folder\tServer total/unread/threads\tLocal total/unread/threads\tBody cache days\tHeader window\tPending\tVerdict",
            ...report.folders.map(
              (folder) =>
                `${folder.scope}\t${folder.server.kind === "available" ? `${folder.server.total}/${folder.server.unread}/${folder.server.threads ?? "—"}` : "unavailable"}\t${folder.local.total}/${folder.local.unread}/${folder.local.threads}\t${folder.bodyCacheWindowDays ?? "all"}\t${folder.headerWindow ? `${folder.headerWindow.days} days, ${folder.headerWindow.messageLimit} messages` : "all"}\t${folder.pendingOps}\t${folder.verdict}`,
            ),
          ].join("\n"),
        )
        .join("\n\n"),
    );
  }),
).pipe(Command.withDescription("Compare cached messages with read-only server counts"));

const sync = Command.make(
  "sync",
  {
    account: Argument.String("account").pipe(
      Argument.withDescription("Only this account"),
      Argument.optional,
    ),
    json: jsonFlag,
    budget: Flag.Int("token-budget").pipe(
      Flag.withDescription("UTF-8 JSON budget, 2000 to 24000 bytes"),
      Flag.withDefault(12000),
    ),
  },
  Effect.fn(function* ({ account, json, budget }) {
    const encoded = yield* withProgress(
      invokeTool(
        "sync",
        {
          ...(Option.isSome(account) ? { account_id: account.value } : {}),
          token_budget: budget,
        },
        json,
      ),
      !json,
    );
    const result = yield* Schema.decodeUnknownEffect(MailToolkit.tools.sync.successSchema)(encoded);
    yield* print(
      result,
      json,
      (value) =>
        `${syncTable(value.results)}${value.omitted ? `\n${value.omitted} account results omitted; sync an account id to inspect.` : ""}`,
    );
    return yield* result.results.some((r) => r.error)
      ? fail("Some accounts did not sync.")
      : Effect.void;
  }),
).pipe(Command.withDescription("Push queued changes, then fetch changes into the local database"));

const limitFlag = Flag.Int("limit").pipe(
  Flag.withDescription("Max threads"),
  Flag.withDefault(20),
  Flag.filter(
    (n) => n > 0 && n <= 100,
    () => "must be between 1 and 100",
  ),
);

const list = Command.make(
  "list",
  {
    mailbox: Flag.Literals("mailbox", MAILBOXES).pipe(Flag.withDefault("inbox")),
    account: optionalString("account", "Only this account"),
    profile: optionalString("profile", "Only accounts in this profile"),
    label: optionalString("label", "Only threads with this label or folder id"),
    unread: Flag.Boolean("unread").pipe(
      Flag.withDescription("Unread only"),
      Flag.withDefault(false),
    ),
    limit: limitFlag,
    before: optionalInt("before", "Legacy page boundary; use --cursor to preserve same-date rows"),
    cursor: optionalString("cursor", "next_cursor from the preceding page"),
    budget: Flag.Int("token-budget").pipe(Flag.withDefault(12000)),
    json: jsonFlag,
  },
  Effect.fn(function* (o) {
    const result = yield* invokeTool(
      "list_threads",
      {
        mailbox: o.mailbox,
        ...(Option.isSome(o.account) ? { account_id: o.account.value } : {}),
        ...(Option.isSome(o.profile) ? { profile_id: o.profile.value } : {}),
        ...(Option.isSome(o.label) ? { label: o.label.value } : {}),
        unread_only: o.unread,
        ...(Option.isSome(o.before) ? { before: o.before.value } : {}),
        ...(Option.isSome(o.cursor) ? { cursor: o.cursor.value } : {}),
        limit: o.limit,
        token_budget: o.budget,
      },
      o.json,
    );
    return yield* print(result, o.json);
  }),
).pipe(Command.withDescription("List conversations in a mailbox, newest first"));

const search = Command.make(
  "search",
  {
    query: Argument.String("query").pipe(Argument.variadic({ min: 1 })),
    account: optionalString("account", "Only this account"),
    limit: limitFlag,
    cursor: optionalString("cursor", "next_cursor from the preceding page"),
    budget: Flag.Int("token-budget").pipe(Flag.withDefault(12000)),
    server: Flag.Boolean("server").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Fetch provider search hits; report unsupported operators and failures"),
    ),
    json: jsonFlag,
  },
  Effect.fn(function* (o) {
    const result = yield* invokeTool(
      "search",
      {
        query: o.query.join(" "),
        ...(Option.isSome(o.account) ? { account_id: o.account.value } : {}),
        limit: o.limit,
        ...(Option.isSome(o.cursor) ? { cursor: o.cursor.value } : {}),
        token_budget: o.budget,
        server: o.server,
      },
      o.json,
    );
    yield* print(result, o.json);
  }),
).pipe(withToolDescription(MailToolkit.tools.search.description ?? "Search mail"));

const show = Command.make(
  "show",
  {
    id: Argument.String("message-id"),
    thread: Flag.Boolean("thread").pipe(
      Flag.withDescription("Print every message in the thread"),
      Flag.withDefault(false),
    ),
    html: Flag.Boolean("html").pipe(
      Flag.withDescription("Include the HTML body in JSON output"),
      Flag.withDefault(false),
    ),
    json: jsonFlag,
  },
  Effect.fn(function* (o) {
    const mailbox = yield* Mailbox;
    const all = yield* mailbox.thread(o.id);
    const picked = o.thread ? all : all.filter((m) => m.id === o.id);
    const messages = picked.map((m) => (o.html ? m : { ...m, bodyHtml: undefined }));
    yield* print(o.thread ? messages : messages[0], o.json, () =>
      picked.map(messageText).join(`\n\n${"─".repeat(60)}\n\n`),
    );
  }),
).pipe(Command.withDescription("Print a message as plain text, or its whole thread"));

/** @internal */
export const mailCommands = [sync, health, list, search, show] as const;
