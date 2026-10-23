# How the renderer loads mailbox lists

This note covers how the main window loads, caches, refreshes and warms thread lists. The numbers come from [perf-list.mjs](../apps/desktop/scripts/perf-list.mjs) on a copy of a real 1.5 GB database (20,131 messages, 5 accounts) and on the 100k fixture. See [performance.md](performance.md#message-list-transitions) for the full tables.

## The cache

Each list query (mailbox, label, account scope, filters, search) owns one `loadedPages` atom in [threads.ts](../apps/desktop/src/renderer/src/state/threads.ts). The atom holds the pages loaded so far. It stays in the registry for five minutes after the last component stops reading it (`Atom.setIdleTTL`). This is the only list cache. Prefetch and warming put lists into it. They do not keep a second copy.

A switch to a view whose list is cached renders those rows in the same commit, with no list request before paint: 14 to 22 ms from click to painted rows on the real database. A view with no cached list shows the previous rows dimmed until its first page arrives: 50 to 160 ms on the same database.

## Invalidation

Mutations and main-process events invalidate reactivity keys (`state/keys.ts`). Lists do not register `Keys.threads` themselves. They read `threadsVersionAtom`, which counts invalidations of that key:

- The list on screen is observed, so it rebuilds at once and reads its rows again.
- A cached list that no component reads goes stale and does nothing. When it shows again it renders its old rows and reads them again in the background (stale-while-revalidate).

Before this, `Atom.withReactivity` kept every cached list observed. Each change re-ran every mailbox and search opened in the last five minutes. One cleared search for a common word cost 3.7 s of main-process time on each mark-read.

A refresh reads only the rows within reach: through the page after the last row the list renders or the last selected row (`refreshPages` in [list-pages.ts](../apps/desktop/src/renderer/src/state/list-pages.ts)). Deeper pages load again on scroll. A list scrolled 2,000 rows down used to read and send 1.6 MB on each change. It now reads 200 rows, 160 KB.

The main process answers requests in order, so the thread count for a list waits for its first rows. All Mail's count took 120 to 165 ms and used to run ahead of the rows a switch was waiting for. Once rows exist the count stays mounted, so a refresh counts once.

Events from the main process arrive in batches, and each batch invalidates each key once. Layout prefs (sidebar, toolbar, reading pane) emit `PrefsChanged`, which refetches only the prefs. They no longer emit `Changed`, which refetched every view.

## Loading ahead of a click

Two paths fill the cache before a click. Both call `prefetchView`, which reads the target view's `loadedPages` atom once.

- **Intent.** Pointer enter or focus on a sidebar row (mailbox, label, category, favorite, account tile) loads that view. A pointer reaches a row 100 to 300 ms before the click, which covers a first page on the real database.
- **Warming.** Once the list on screen has loaded, [use-view-warming.ts](../apps/desktop/src/renderer/src/app/use-view-warming.ts) warms the views one click away: Inbox, Starred, Sent, Drafts and All Mail in the open space, plus each account tile's target. A new view starts a new pass.

Warming is bounded so that it never competes with the person or with sync ([view-warming.ts](../apps/desktop/src/renderer/src/state/view-warming.ts)):

- At most 12 views per pass, and only views with no cached list. A cached list, stale or not, refreshes when it shows or when the pointer reaches its row.
- One list request at a time. The next view starts after the previous list arrived, 250 ms passed and the window was idle (`requestIdleCallback`).
- A key press, click, wheel or scroll pauses the pass until one second has passed without input. Changing the view cancels it.
- Each warmed view holds one first page of up to 100 summaries, 30 to 90 KB as JSON, and leaves the cache after five idle minutes.

## Options considered

| Option                                                  | Result                                                                                                                       | Decision                                                                                                                      |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| (a) Prefetch on pointer enter or focus                  | First visits drop from up to 158 ms to at most 34 ms with a 150 ms hover                                                     | Done                                                                                                                          |
| (b) Warm likely views after launch                      | The views it covers switch in 16 to 25 ms on the first visit                                                                 | Done, bounded as above                                                                                                        |
| (c) Cached rows first, then revalidate                  | Already the model for cached lists; now also for stale ones                                                                  | Kept and extended                                                                                                             |
| (d) Smaller first pages                                 | A first page of 100 rows took 20 to 140 ms in the main process (27 to 86 KB). Paging assumes 100-row pages in several places | Not done. With (a) and (b) the first page is off the click path                                                               |
| (e) Core and the database off the Electron main process | Removes main-process blocking for every request                                                                              | Not done in this change. After the fixes the main thread spends 20 to 60 ms of CPU per action, against several seconds before |

Linear's sync engine and Superhuman keep a local copy of the data and render from it. OpenMail already does: SQLite in core is the local copy, so the renderer only needs the list summaries for the next view, which are cheap to read. TanStack Query's prefetch on intent and stale-while-revalidate map onto the atom cache, so the design reuses the existing Effect atoms and reactivity keys.

## Tests and budgets

- [layout.test.ts](../apps/desktop/src/renderer/src/e2e/layout.test.ts): a switch to a view loaded on pointer enter paints its rows with no list request; a cached view off screen does not reload on sync and reloads once when it shows; Back from the narrow reader reuses the list node; toggling the docked sidebar paints before the pref is stored and keeps the list and reader nodes.
- [view-warming.test.ts](../apps/desktop/src/renderer/src/state/view-warming.test.ts): warming sends one list at a time, waits out recent input, skips cached lists and stops when cancelled.
- [performance-large.test.ts](../packages/core/src/platform/node/performance-large.test.ts) (`pnpm test:perf`): a first page of 100 rows for All Mail and for Sent within 150 ms, a refresh at the top within 75 ms on 100k messages.
