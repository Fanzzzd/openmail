/**
 * sync, health, list, search and show: reading the local mailbox. These are commands a person
 * types, so they run as the user through Mailbox and see every turned-on account, like the app. Agent
 * consent gates `openmail tool …` and `openmail mcp`: a CLI in the person's own shell could
 * read the SQLite file anyway.
 */

import { Argument, Command, Flag } from "effect/cli";
import { Failed, fail, jsonFlag, optionalInt, optionalString, print } from "./common.js";
import { Effect, Option, Schema } from "effect";
import { Buffer } from "node:buffer";
import { MAILBOXES, Mailbox, redactSyncHealth } from "@openmail/core";
import type { SearchResult, ThreadSummary } from "@openmail/core/schema";
import { withProgress } from "../sync-progress.js";
import { messageText, syncTable, threadTable } from "../format.js";

const health = Command.make(
  "health",
  {
    account: Flag.String("account").pipe(
      Flag.withDescription("Only this account (an id from `openmail accounts list`)"),
      Flag.optional,
    ),
    json: jsonFlag,
  },
  Effect.fn(function* ({ account, json }) {
    const mailbox = yield* Mailbox;
    const ids = Option.isSome(account)
      ? [account.value]
      : (yield* mailbox.accounts).map((item) => item.id);
    const reports = yield* Effect.forEach(ids, (id) =>
      mailbox.syncHealth(id).pipe(Effect.map(redactSyncHealth)),
    );
    yield* print(reports, json, (items) =>
      items.length === 0
        ? "(no accounts; run `openmail accounts add gmail`)"
        : items
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

/** Accepted and ignored: list, search and sync used to run as agent tools with a byte budget. */
const legacyBudget = Flag.Int("token-budget").pipe(Flag.withHidden, Flag.optional);

const sync = Command.make(
  "sync",
  {
    account: Argument.String("account").pipe(
      Argument.withDescription("Only this account"),
      Argument.optional,
    ),
    json: jsonFlag,
    budget: legacyBudget,
  },
  Effect.fn(function* ({ account, json }) {
    const mailbox = yield* Mailbox;
    const ids = yield* accountScope(account, Option.none());
    const results = yield* withProgress(
      Effect.forEach(ids, (id) => mailbox.sync(id)).pipe(Effect.map((rows) => rows.flat())),
      !json,
    );
    yield* print({ results }, json, (value) => syncTable(value.results));
    return yield* results.some((r) => r.error) ? fail("Some accounts did not sync.") : Effect.void;
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

/** `--space`, plus the hidden `--profile` it replaced, so older scripts keep working. */
const spaceFlags = {
  space: optionalString("space", "Only accounts in this space (openmail spaces list)"),
  profile: optionalString("profile", "Same as --space").pipe(Flag.withHidden),
};

/** The opaque --cursor for list and search: where the last page stopped. */
const PageCursor = Schema.Struct({
  date: Schema.optionalKey(Schema.Number),
  id: Schema.optionalKey(Schema.String),
  offset: Schema.optionalKey(Schema.Int),
});
const PageCursorJson = Schema.fromJsonString(PageCursor);
const encodePageCursor = (cursor: typeof PageCursor.Type) =>
  Buffer.from(Schema.encodeSync(PageCursorJson)(cursor)).toString("base64url");
const decodePageCursor = (raw: Option.Option<string>) =>
  Option.isNone(raw)
    ? Effect.succeed<typeof PageCursor.Type>({})
    : Schema.decodeUnknownEffect(PageCursorJson)(
        Buffer.from(raw.value, "base64url").toString("utf8"),
      ).pipe(
        Effect.mapError(() => new Failed({ message: "That --cursor is not from this command." })),
      );

/**
 * The accounts a person's list or search covers: every turned-on account, narrowed by --space
 * and --account. Unknown ids fail with the command that lists the right ones.
 */
const accountScope = (account: Option.Option<string>, space: Option.Option<string>) =>
  Effect.gen(function* () {
    const mailbox = yield* Mailbox;
    const accounts = yield* mailbox.accounts;
    if (Option.isSome(space) && !(yield* mailbox.profiles).some((p) => p.id === space.value))
      return yield* fail(
        `No space with id ${space.value}. Run \`openmail spaces list\` to see them.`,
      );
    if (Option.isSome(account)) {
      const found = accounts.find((a) => a.id === account.value);
      if (!found)
        return yield* fail(
          `No account with id ${account.value}. Run \`openmail accounts list\` to see them.`,
        );
      if (Option.isSome(space) && found.profileId !== space.value)
        return yield* fail(`Account ${account.value} is not in space ${space.value}.`);
      return [found.id];
    }
    return accounts
      .filter((a) => a.enabled !== false)
      .filter((a) => Option.isNone(space) || a.profileId === space.value)
      .map((a) => a.id);
  });

/** Human output: one line per thread, then the command for the next page. */
const pageText = (threads: readonly ThreadSummary[], next: string | undefined, notes: string[]) =>
  [
    threadTable(threads),
    ...notes,
    ...(next === undefined ? [] : [`More: add --cursor ${next}`]),
  ].join("\n");

const list = Command.make(
  "list",
  {
    mailbox: Flag.Literals("mailbox", MAILBOXES).pipe(
      Flag.withDescription("Mailbox to list"),
      Flag.withDefault("inbox"),
    ),
    account: optionalString("account", "Only this account"),
    ...spaceFlags,
    label: optionalString("label", "Only threads with this label or folder id"),
    unread: Flag.Boolean("unread").pipe(
      Flag.withDescription("Unread only"),
      Flag.withDefault(false),
    ),
    limit: limitFlag,
    budget: legacyBudget,
    before: optionalInt("before", "Legacy page boundary; use --cursor to preserve same-date rows"),
    cursor: optionalString("cursor", "The cursor printed after the preceding page"),
    json: jsonFlag,
  },
  Effect.fn(function* (o) {
    const mailbox = yield* Mailbox;
    const accountIds = yield* accountScope(
      o.account,
      Option.orElse(o.space, () => o.profile),
    );
    const cursor = yield* decodePageCursor(o.cursor);
    const before =
      cursor.date !== undefined
        ? { before: cursor.date, ...(cursor.id === undefined ? {} : { beforeId: cursor.id }) }
        : Option.isSome(o.before)
          ? { before: o.before.value }
          : {};
    const rows = accountIds.length
      ? yield* mailbox.threads({
          mailbox: o.mailbox,
          accountIds,
          ...(Option.isSome(o.label) ? { label: o.label.value } : {}),
          ...(o.unread ? { unreadOnly: true } : {}),
          ...before,
          limit: o.limit + 1,
        })
      : [];
    const threads = rows.slice(0, o.limit);
    const last = threads.at(-1);
    const next =
      last && rows.length > threads.length
        ? encodePageCursor({ date: last.date, id: last.id })
        : undefined;
    yield* print({ threads, ...(next === undefined ? {} : { next_cursor: next }) }, o.json, () =>
      pageText(threads, next, []),
    );
  }),
).pipe(Command.withDescription("List conversations in a mailbox, newest first"));

/** Search reads at most this many hits; a narrower query finds the rest. */
const SEARCH_CAP = 200;

const search = Command.make(
  "search",
  {
    query: Argument.String("query").pipe(Argument.variadic({ min: 1 })),
    account: optionalString("account", "Only this account"),
    limit: limitFlag,
    budget: legacyBudget,
    cursor: optionalString("cursor", "The cursor printed after the preceding page"),
    server: Flag.Boolean("server").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Fetch provider search hits; report unsupported operators and failures"),
    ),
    json: jsonFlag,
  },
  Effect.fn(function* (o) {
    const mailbox = yield* Mailbox;
    const accountIds = yield* accountScope(o.account, Option.none());
    const { offset = 0 } = yield* decodePageCursor(o.cursor);
    const query = { search: o.query.join(" "), accountIds, limit: SEARCH_CAP + 1 };
    const found: SearchResult = !accountIds.length
      ? { threads: [], truncated: false, errors: [] }
      : o.server
        ? yield* mailbox.searchServer(query)
        : { threads: yield* mailbox.threads(query), truncated: false, errors: [] };
    const all = found.threads.slice(0, SEARCH_CAP);
    const threads = all.slice(offset, offset + o.limit);
    const next =
      offset + threads.length < all.length
        ? encodePageCursor({ offset: offset + threads.length })
        : undefined;
    const truncated = found.truncated || found.threads.length > SEARCH_CAP;
    const notes = [
      ...(found.ignored ?? []).map(
        (n) => `${n.accountId}: the provider ignored ${n.operators.join(", ")}`,
      ),
      ...found.errors.map((n) => `${n.accountId}: ${n.message}`),
      ...(truncated
        ? [`Showing the first ${SEARCH_CAP} hits; narrow the query for the rest.`]
        : []),
    ];
    yield* print(
      {
        threads,
        truncated,
        ...(found.ignored ? { ignored: found.ignored } : {}),
        errors: found.errors,
        ...(next === undefined ? {} : { next_cursor: next }),
      },
      o.json,
      () => pageText(threads, next, notes),
    );
  }),
).pipe(
  Command.withDescription(
    "Search the local copy with words and Gmail-style operators (from:, subject:, has:attachment …); --server also asks the provider",
  ),
  Command.withShortDescription("Search mail with words and Gmail-style operators"),
);

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
