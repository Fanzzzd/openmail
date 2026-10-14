/** Tools that list, search, read and sync threads. */

import {
  ACCOUNT_ID_HINT,
  AccountId,
  MailToolError,
  ThreadId,
  ToolThread,
  boundThread,
  bounded,
  compactThread,
  cursorFor,
  mailTool,
  page,
  pageScope,
  readOnly,
  toToolError,
  toolAttempt,
  toolError,
  untrustedMail,
} from "./tool-common.js";
import { Effect, Schema } from "effect";
import { MAILBOXES } from "../domain/message.js";
import {
  PageParameters,
  PageResult,
  ToolBudget,
  ToolLimit,
  encodeCursor,
  jsonBytes,
  shortText,
} from "./tool-pages.js";
import { SearchResult } from "../domain/organization.js";
import { ModelThread } from "../ai/model-thread.js";
import { SyncResult } from "../domain/sync-status.js";
import { Tool } from "effect/ai";
import type { HandlersFor, ToolContext } from "./tool-context.js";

export const ListThreads = readOnly(
  mailTool("list_threads", {
    description:
      "List conversations in a mailbox from the local copy, newest first. Each row is a thread's newest message; call sync first for mail from the last few minutes. Page with next_cursor and the same filters.",
    parameters: Schema.Struct({
      mailbox: Schema.Literals(MAILBOXES)
        .annotate({ description: "Default inbox." })
        .pipe(Schema.withDecodingDefaultKey(Effect.succeed("inbox" as const))),
      account_id: Schema.optionalKey(AccountId),
      profile_id: Schema.optionalKey(
        Schema.String.annotate({ description: "Only accounts in this profile (list_profiles)." }),
      ),
      label: Schema.optionalKey(
        Schema.String.annotate({
          description:
            "A label or folder id from list_labels, or a Gmail category such as CATEGORY_PROMOTIONS.",
        }),
      ),
      unread_only: Schema.optionalKey(
        Schema.Boolean.annotate({ description: "Only unread threads." }),
      ),
      before: Schema.optionalKey(
        Schema.Finite.annotate({
          description:
            "Epoch ms. Only threads older than this; pass next_before from the last page.",
        }),
      ),
      ...PageParameters,
    }),
    success: Schema.Struct({
      ...PageResult,
      threads: Schema.Array(ToolThread),
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

export const Search = readOnly(
  mailTool("search", {
    description:
      "Search the local copy with words and Gmail-style operators. Use it to find specific mail; set server to also ask the provider. Returns up to 200 results; page with next_cursor.",
    parameters: Schema.Struct({
      query: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)).annotate({
        description:
          "Words and operators: from:, to:, subject:, after:, before:, is:unread, has:attachment, label:, in:attachment.",
      }),
      account_id: Schema.optionalKey(AccountId),
      server: Schema.Boolean.annotate({
        description:
          "Also fetch the provider's hits into the local copy. Unsupported operators are listed under ignored, failed accounts under errors.",
      }).pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
      ...PageParameters,
      limit: ToolLimit(20),
    }),
    success: Schema.Struct({
      ...PageResult,
      ...SearchResult.fields,
      threads: Schema.Array(ToolThread),
    }),
    failure: MailToolError,
    failureMode: "return",
  }),
  true,
);

export const ReadThread = readOnly(
  mailTool("read_thread", {
    description:
      "Read a conversation as plain text, oldest message first, without quoted history, signatures or attachments. Use a message id from list_threads or search. Older text is trimmed to fit max_chars; truncated counts what was cut.",
    parameters: Schema.Struct({
      id: ThreadId,
      max_chars: Schema.Int.check(Schema.isBetween({ minimum: 2000, maximum: 24_000 }))
        .annotate({
          description:
            "Result size in UTF-8 JSON bytes. Default 12000. Older messages are trimmed first.",
        })
        .pipe(Schema.withDecodingDefaultKey(Effect.succeed(12_000))),
    }),
    success: ModelThread,
    failure: MailToolError,
    failureMode: "return",
  }),
);

export const SemanticSearch = readOnly(
  mailTool("semantic_search", {
    description:
      "Find up to five conversations in one account by meaning, using its on-device text index. Use it when keyword search misses. Message snippets are omitted. Page with next_cursor.",
    parameters: Schema.Struct({
      query: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)).annotate({
        description: "What the mail is about, in plain words.",
      }),
      account_id: Schema.optionalKey(
        AccountId.annotate({
          description:
            "Required for MCP. The account needs AI consent and a ready on-device text index.",
        }),
      ),
      ...PageParameters,
      limit: ToolLimit(5, 5),
    }),
    success: Schema.Struct({ ...PageResult, threads: Schema.Array(ToolThread) }),
    failure: MailToolError,
    failureMode: "return",
  }),
);

export const Sync = mailTool("sync", {
  description:
    "Fetch new and changed mail from the providers into the local copy, and push changes the person already approved. Call it when the person asks about mail from the last few minutes. Returns up to 100 account results; omitted counts the rest.",
  parameters: Schema.Struct({
    token_budget: ToolBudget,
    account_id: Schema.optionalKey(
      AccountId.annotate({ description: "Only this account. Default: every account." }),
    ),
  }),
  success: Schema.Struct({ results: Schema.Array(SyncResult), omitted: Schema.Int }),
  failure: MailToolError,
  failureMode: "return",
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

export const threadHandlers = ({
  mailbox,
  identity,
  accountIdsFor,
  forAccounts,
  requireProfile,
  requireMessage,
}: ToolContext) => {
  return {
    list_threads: Effect.fnUntraced(function* (p) {
      // A bad cursor fails before any account check, so it never pages silently from the top.
      const scope = pageScope("list_threads", p);
      const cursor = yield* cursorFor(p.cursor, scope);
      if (p.profile_id !== undefined) yield* requireProfile(p.profile_id);
      let accountIds = yield* accountIdsFor(p.account_id);
      if (!accountIds.length) return { threads: [] };
      if (p.profile_id) {
        const inProfile = new Set(
          (yield* mailbox.accounts).filter((a) => a.profileId === p.profile_id).map((a) => a.id),
        );
        accountIds = accountIds.filter((id) => inProfile.has(id));
        if (!accountIds.length) return { threads: [] };
      }
      const rows = yield* mailbox
        .threads({
          mailbox: p.mailbox,
          accountIds,
          ...(p.label ? { label: p.label } : {}),
          ...(p.unread_only ? { unreadOnly: true } : {}),
          ...(cursor.date === undefined
            ? p.before === undefined
              ? {}
              : { before: p.before }
            : { before: cursor.date, beforeId: cursor.id }),
          limit: p.limit + 1,
        })
        .pipe(Effect.mapError(toToolError));
      const threads = yield* bounded(rows.map(compactThread), p.limit, p.token_budget);
      const last = threads.at(-1);
      return yield* toolAttempt(() => {
        const result = {
          threads,
          ...(last && rows.length > threads.length
            ? {
                next_cursor: encodeCursor({ scope, offset: 0, date: last.date, id: last.id }),
                next_before: last.date,
              }
            : {}),
        };
        if (jsonBytes(untrustedMail(result)) > p.token_budget)
          throw new Error(
            "Message ids and cursor exceed token_budget. Increase the budget or narrow the filters.",
          );
        return result;
      });
    }),
    search: Effect.fnUntraced(function* (p) {
      if (p.server && (yield* identity.current).surface !== "mcp")
        return yield* toolError(
          "invalid_input",
          "Server search is not available to the in-app assistant.",
        );
      yield* cursorFor(p.cursor, pageScope("search", p));
      const q = {
        search: p.query,
        accountIds: yield* accountIdsFor(p.account_id),
        limit: 201,
      };
      if (!q.accountIds.length) return { threads: [], truncated: false, ignored: [], errors: [] };
      const found = p.server
        ? yield* mailbox.searchServer(q).pipe(Effect.mapError(toToolError))
        : {
            threads: yield* mailbox.threads(q).pipe(Effect.mapError(toToolError)),
            truncated: false,
            errors: [],
          };
      const result = yield* page(
        "search",
        p,
        Effect.succeed(found.threads.slice(0, 200).map(compactThread)),
      ).pipe(Effect.map(({ items, ...rest }) => ({ ...rest, threads: items })));
      const notices = {
        ignored: (found.ignored ?? []).slice(0, 20).map((n) => ({
          accountId: n.accountId,
          operators: n.operators.slice(0, 20).map((v) => shortText(v, 64)),
        })),
        errors: found.errors.slice(0, 20).map((n) => ({ ...n, message: shortText(n.message) })),
      };
      if (jsonBytes(untrustedMail({ ...result, ...notices, truncated: true })) > p.token_budget)
        return yield* toolError(
          "invalid_input",
          "Search notices exceed token_budget. Narrow account_id or increase the budget.",
        );
      return {
        ...result,
        ...notices,
        truncated:
          found.truncated ||
          found.threads.length > 200 ||
          found.errors.length > 20 ||
          (found.ignored?.length ?? 0) > 20,
      };
    }),
    read_thread: Effect.fnUntraced(function* ({ id, max_chars }) {
      yield* requireMessage(id);
      const view = yield* mailbox.threadForModel(id, max_chars).pipe(Effect.mapError(toToolError));
      return yield* toolAttempt(() => boundThread(view, max_chars));
    }),
    semantic_search: (p) =>
      page(
        "semantic_search",
        p,
        Effect.flatMap(identity.current, (current) =>
          !p.account_id && current.surface === "mcp"
            ? Effect.fail(
                toolError(
                  "invalid_input",
                  "semantic_search needs account_id: it searches one account's on-device index.",
                  ACCOUNT_ID_HINT,
                ),
              )
            : forAccounts(p.account_id, (ids) =>
                mailbox.semanticSearch({ search: p.query, accountIds: ids, limit: 5 }).pipe(
                  Effect.mapError((e) =>
                    e._tag === "IndexNotReady"
                      ? toolError(
                          "not_ready",
                          e.message,
                          "Use search for keywords meanwhile, and tell the person why meaning search is unavailable.",
                        )
                      : toToolError(e),
                  ),
                  Effect.map((rows) => rows.map(compactThread)),
                ),
              ),
        ),
      ).pipe(Effect.map(({ items, ...rest }) => ({ ...rest, threads: items }))),
    sync: ({ account_id, token_budget }) =>
      Effect.flatMap(accountIdsFor(account_id), (ids) =>
        Effect.forEach(ids, (id) => mailbox.sync(id)).pipe(Effect.map((rows) => rows.flat())),
      ).pipe(
        Effect.flatMap((all) =>
          bounded(
            all.map((row) => ({ ...row, ...(row.error ? { error: shortText(row.error) } : {}) })),
            100,
            token_budget,
          ).pipe(Effect.map((results) => ({ results, omitted: all.length - results.length }))),
        ),
      ),
  } satisfies HandlersFor<
    typeof ListThreads | typeof Search | typeof ReadThread | typeof SemanticSearch | typeof Sync
  >;
};
