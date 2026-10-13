import { Clock, Effect, Option } from "effect";
import { gmailPages } from "../provider-pages.js";

import { HistoryPage, MessageList, INITIAL_QUERY, INITIAL_LIMIT, Profile } from "./api.js";
import type { GmailClient } from "./client.js";

/** Incremental sync from the History API, and the full listing used when the history cursor has expired. */
export const makeGmailHistory = (client: GmailClient) => {
  const { get } = client;
  /** None when the cursor is too old (Gmail keeps about a week), forcing a full sync. */
  const readHistory = Effect.fnUntraced(
    function* (accountId: string, cursor: string, scope?: "inbox") {
      const changed = new Set<string>();
      const added = new Set<string>();
      const deleted = new Set<string>();
      let latest = cursor;
      for (const loadPage of gmailPages((pageToken) =>
        get(accountId, HistoryPage, "/history", {
          startHistoryId: cursor,
          ...(scope ? { labelId: "INBOX" } : {}),
          maxResults: "500",
          ...(pageToken ? { pageToken } : {}),
        }),
      )) {
        const page = yield* loadPage;
        for (const h of page.history ?? []) {
          for (const e of h.messagesAdded ?? []) added.add(e.message.id);
          for (const e of [
            ...(h.messagesAdded ?? []),
            ...(h.labelsAdded ?? []),
            ...(h.labelsRemoved ?? []),
          ]) {
            changed.add(e.message.id);
          }
          for (const e of h.messagesDeleted ?? []) deleted.add(e.message.id);
        }
        latest = page.historyId;
      }
      for (const id of deleted) changed.delete(id);
      return Option.some({
        changedIds: [...changed],
        addedIds: added,
        deletedIds: [...deleted],
        cursor: latest,
      });
    },
    Effect.catchIf(
      (e) => e._tag === "ApiError" && e.status === 404,
      () => Effect.succeed(Option.none()),
    ),
  );

  const fullSyncPlan = Effect.fnUntraced(function* (
    accountId: string,
    scope?: "inbox",
    recovering = false,
    resumeFrom?: string,
  ) {
    const since = (yield* Clock.currentTimeMillis) - 90 * 86400000;
    // Take the cursor before listing so nothing that arrives mid-sync is lost;
    // the next incremental run re-fetches any overlap idempotently.
    const historyId = resumeFrom ?? (yield* get(accountId, Profile, "/profile")).historyId;
    const ids: string[] = [];
    for (const loadPage of gmailPages((pageToken) =>
      get(accountId, MessageList, "/messages", {
        q: scope ? `in:inbox ${INITIAL_QUERY}` : INITIAL_QUERY,
        includeSpamTrash: "true",
        maxResults: "500",
        ...(pageToken ? { pageToken } : {}),
      }),
    )) {
      const page = yield* loadPage;
      ids.push(...(page.messages ?? []).map((m) => m.id));
      if (ids.length >= (recovering ? Infinity : INITIAL_LIMIT)) break;
    }
    return {
      changedIds: recovering ? ids : ids.slice(0, INITIAL_LIMIT),
      addedIds: new Set(ids),
      since,
      deletedIds: [] as string[],
      cursor: historyId,
    };
  });

  return { readHistory, fullSyncPlan };
};
