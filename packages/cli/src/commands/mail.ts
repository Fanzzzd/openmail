/**
 * sync, health, list, search and show: reading the local mailbox. These are commands a person
 * types, so they run as the user through Mailbox and see every turned-on account, like the app. Agent
 * consent gates `openmail tool …` and `openmail mcp`: a CLI in the person's own shell could
 * read the SQLite file anyway.
 */

import { Argument, Command, Flag } from "effect/cli";
import {
  Failed,
  fail,
  findSpace,
  jsonFlag,
  limitFlag,
  noAccount,
  optionalInt,
  optionalString,
  print,
} from "./common.js";
import { Console, Effect, LogLevel, Logger, Option } from "effect";
import {
  MAILBOXES,
  Mailbox,
  SyncFailureDetailLog,
  type SyncResult,
  cursorScope,
  decodeCursor,
  encodeCursor,
  logWarning,
  printable,
  redactSyncHealth,
  searchRest,
  threadsWithLabel,
} from "@openmail/core";
import {
  SEARCH_VALUE_FORMS,
  type SearchResult,
  type SyncFailureDetail,
  type ThreadSummary,
  unparsedSearchOperators,
  withUnparsedOperators,
} from "@openmail/core/schema";
import { SEARCH_INDEX_NOTE, finishSearchIndex, withProgress } from "../sync-progress.js";
import {
  cliSyncResult,
  serverSearchFailure,
  syncFailedHint,
  messageText,
  syncTable,
  threadTable,
} from "../format.js";

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
      : (yield* mailbox.accounts.accounts).map((item) => item.id);
    const reports = yield* Effect.forEach(ids, (id) =>
      mailbox.sync.syncHealth(id).pipe(Effect.map(redactSyncHealth)),
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

/**
 * Why an account did not sync, for --log-level: an unknown failure at warn, the rest at debug.
 * The CLI writes no diagnostics file, and core already took addresses and tokens out.
 */
const logSyncFailure = (detail: SyncFailureDetail) => {
  const line =
    [
      `${detail.provider} sync failed (${detail.scope}): ${detail.tag}`,
      ...(detail.reason === undefined ? [] : [`reason ${detail.reason}`]),
      ...(detail.status === undefined ? [] : [`status ${detail.status}`]),
    ].join(", ") + (detail.message ? `: ${detail.message}` : "");
  return detail.failure === "unknown" ? logWarning("sync-failed", line) : Effect.logDebug(line);
};

/** Accepted and ignored: list, search and sync used to run as agent tools with a byte budget. */
const legacyBudget = Flag.Int("token-budget").pipe(Flag.withHidden, Flag.optional);

const sync = Command.make(
  "sync",
  {
    account: Argument.String("account").pipe(
      Argument.withDescription("Only this account, an id from `openmail accounts list`"),
      Argument.optional,
    ),
    json: jsonFlag,
    budget: legacyBudget,
  },
  Effect.fn(function* ({ account, json }) {
    const mailbox = yield* Mailbox;
    const ids = yield* accountScope(account, Option.none());
    const verbose = yield* LogLevel.isEnabled("Warn");
    const results = yield* withProgress(
      Effect.forEach(ids, (id) => mailbox.sync.sync(id)).pipe(
        Effect.map((rows) => rows.flat().map((row) => cliSyncResult(row, verbose))),
        Effect.provideService(SyncFailureDetailLog, logSyncFailure),
      ),
      !json,
    );
    // The app does both in the background; a CLI-only mailbox gets them here.
    yield* finishSearchIndex;
    // A refresh the app's writer keeps busy is skipped quietly; the app refreshes hourly.
    yield* mailbox.sync.refreshPlannerStats.pipe(Effect.provide(Logger.layer([])));
    // A sign-in command for IMAP repeats the account's server settings.
    const accounts = yield* mailbox.accounts.accounts;
    const syncTableOf = (value: { readonly results: readonly SyncResult[] }) =>
      syncTable(value.results, accounts);
    if (!results.some((r) => r.error)) return yield* print({ results }, json, syncTableOf);
    const error = {
      message: "Some accounts did not sync.",
      code: "failed" as const,
      hint: syncFailedHint(results, { json, verbose }),
    };
    // With --json, stdout stays one document: the results and the error object together.
    yield* print(json ? { results, error } : { results }, json, syncTableOf);
    return yield* fail(error.message, { ...error, printed: json });
  }),
).pipe(Command.withDescription("Push queued changes, then fetch changes into the local database"));

const threadLimit = limitFlag("Max threads", 20);

/** `--space`, plus the hidden `--profile` it replaced, so older scripts keep working. */
const spaceFlags = {
  space: optionalString(
    "space",
    "Only accounts in this space: its name or id (openmail spaces list)",
  ),
  profile: optionalString("profile", "Same as --space").pipe(Flag.withHidden),
};

/**
 * The opaque --cursor for list and search is core's page cursor: where the last page stopped,
 * bound to a hash of the command and filters that made it, so a cursor from one command never
 * pages another.
 */
const badCursor = (message: string) =>
  new Failed({
    message,
    code: "invalid_input",
    hint: "Omit --cursor to start from the first page.",
  });
const decodePageCursor = (raw: Option.Option<string>, scope: string) =>
  Effect.try({
    try: () => decodeCursor(Option.getOrUndefined(raw), scope),
    catch: () => badCursor("That --cursor is not from this command with these filters."),
  });

/**
 * The accounts a person's list or search covers: every turned-on account, narrowed by --space
 * and --account. Unknown ids fail with the command that lists the right ones.
 */
const accountScope = (account: Option.Option<string>, space: Option.Option<string>) =>
  Effect.gen(function* () {
    const mailbox = yield* Mailbox;
    const accounts = yield* mailbox.accounts.accounts;
    const inSpace = Option.isSome(space) ? yield* findSpace(space.value) : undefined;
    if (Option.isSome(account)) {
      const found = accounts.find((a) => a.id === account.value);
      if (!found) return yield* noAccount(account.value);
      if (inSpace && found.profileId !== inSpace.id)
        return yield* fail(`Account ${account.value} is not in space ${printable(inSpace.name)}.`);
      return [found.id];
    }
    return accounts
      .filter((a) => a.enabled !== false)
      .filter((a) => !inSpace || a.profileId === inSpace.id)
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
    label: optionalString(
      "label",
      "Only threads with this label or folder, by id or name (any case)",
    ),
    unread: Flag.Boolean("unread").pipe(
      Flag.withDescription("Unread only"),
      Flag.withDefault(false),
    ),
    limit: threadLimit,
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
    const scope = cursorScope("list", [o.mailbox, accountIds, Option.getOrNull(o.label), o.unread]);
    const cursor = yield* decodePageCursor(o.cursor, scope);
    const before =
      cursor.date !== undefined
        ? { before: cursor.date, ...(cursor.id === undefined ? {} : { beforeId: cursor.id }) }
        : Option.isSome(o.before)
          ? { before: o.before.value }
          : {};
    const q = {
      mailbox: o.mailbox,
      accountIds,
      ...(o.unread ? { unreadOnly: true } : {}),
      ...before,
      limit: o.limit + 1,
    };
    const label = Option.getOrUndefined(o.label);
    const rows = !accountIds.length
      ? []
      : label === undefined
        ? yield* mailbox.reading.threads(q)
        : yield* threadsWithLabel(mailbox.reading, { ...q, label });
    if (rows === null)
      return yield* fail(`No label or folder with id or name ${printable(label ?? "")}.`, {
        code: "not_found",
        hint: "Run `openmail tool list_labels` to see label ids and names.",
      });
    const threads = rows.slice(0, o.limit);
    const last = threads.at(-1);
    const next =
      last && rows.length > threads.length
        ? encodeCursor({ scope, offset: 0, date: last.date, id: last.id })
        : undefined;
    return yield* print(
      { threads, ...(next === undefined ? {} : { next_cursor: next }) },
      o.json,
      () => pageText(threads, next, []),
    );
  }),
).pipe(Command.withDescription("List conversations in a mailbox, newest first"));

/** Search reads at most this many hits; a narrower query finds the rest. */
const SEARCH_CAP = 200;

const search = Command.make(
  "search",
  {
    query: Argument.String("query").pipe(
      Argument.withDescription(
        "Words and Gmail-style operators such as from:, subject: and has:attachment. A word or operator after a minus sign, such as -newsletter, leaves those messages out; words after -- are always query text",
      ),
      Argument.variadic({ min: 1 }),
    ),
    account: optionalString("account", "Only this account"),
    limit: threadLimit,
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
    const query = { search: o.query.join(" "), accountIds, limit: SEARCH_CAP + 1 };
    const scope = cursorScope("search", [query.search, accountIds, o.server]);
    const cursor = yield* decodePageCursor(o.cursor, scope);
    if (accountIds.length && !(yield* finishSearchIndex)) yield* Console.error(SEARCH_INDEX_NOTE);
    const found: SearchResult = !accountIds.length
      ? { threads: [], truncated: false, errors: [] }
      : o.server
        ? yield* mailbox.reading.searchServer(query)
        : { threads: yield* mailbox.reading.threads(query), truncated: false, errors: [] };
    const rest = searchRest(found.threads.slice(0, SEARCH_CAP), cursor);
    const threads = rest.rows.slice(0, o.limit);
    const after = rest.next(threads.length);
    const next = after === null ? undefined : encodeCursor({ scope, offset: 0, ...after });
    const truncated = found.truncated || found.threads.length > SEARCH_CAP;
    // newer:foo or larger:xyz matches nothing; say so on stderr, keeping stdout for results.
    const unparsed = unparsedSearchOperators(query.search);
    if (unparsed.length)
      yield* Console.error(
        `note: no valid value, searched as plain text: ${unparsed.join(", ")}. ${SEARCH_VALUE_FORMS}`,
      );
    const ignored = accountIds.length
      ? withUnparsedOperators(found.ignored ?? [], accountIds, query.search)
      : [];
    const providerIgnored = (found.ignored ?? []).map(
      (n) => `${n.accountId}: the provider ignored ${n.operators.join(", ")}`,
    );
    const notes = [
      ...providerIgnored,
      ...found.errors.map((n) => `${n.accountId}: ${n.message}`),
      ...(truncated
        ? [`Showing the first ${SEARCH_CAP} hits; narrow the query for the rest.`]
        : []),
    ];
    const page = {
      threads,
      truncated,
      ...(found.ignored || ignored.length ? { ignored } : {}),
      errors: found.errors,
      ...(next === undefined ? {} : { next_cursor: next }),
    };
    // Local hits still print, but a --server search that reached no server is a failure.
    const failedAccounts = new Set(found.errors.map((e) => e.accountId));
    if (!o.server || !accountIds.length || accountIds.some((id) => !failedAccounts.has(id)))
      return yield* print(page, o.json, () => pageText(threads, next, notes));
    const error = serverSearchFailure(found.errors, yield* mailbox.accounts.accounts);
    // With --json, stdout stays one document: the page and the error object together.
    yield* print(o.json ? { ...page, error } : page, o.json, () => pageText(threads, next, notes));
    return yield* fail(error.message, { ...error, printed: o.json });
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
    id: Argument.String("message-id").pipe(
      Argument.withDescription("An id from `openmail list` or `openmail search`"),
    ),
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
    const all = yield* mailbox.reading.thread(o.id);
    const picked = o.thread ? all : all.filter((m) => m.id === o.id);
    const messages = picked.map((m) => (o.html ? m : { ...m, bodyHtml: undefined }));
    yield* print(o.thread ? messages : messages[0], o.json, () =>
      picked.map(messageText).join(`\n\n${"─".repeat(60)}\n\n`),
    );
  }),
).pipe(Command.withDescription("Print a message as plain text, or its whole thread"));

/** @internal */
export const mailCommands = [sync, health, list, search, show] as const;
