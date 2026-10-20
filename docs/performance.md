# Performance

The redaction check of the content in cached copies of real mail is in [corpus-check](corpus-check.md).

This page maintains the local performance budgets and the commands that reproduce them. It uses Node and `node:sqlite`. It does not measure Electron, model downloads or end-to-end latency on real accounts.

## 100k-message budget

The suite runs the real migrations and `Store.upsertMessage`. The temporary database holds 100,000 messages, 3 accounts, 200 labels/folders and 20,000 threads, of which 100 long threads have 204 messages each. Message text contains CJK and quoted history. HTML uses the repo's newsletter and Outlook Word fixtures. The separate parsing test input is 200 KiB of UTF-8 with inline CSS, hidden content and JSON-LD events. The database is created in the system temp directory and deleted after the Layer closes. The SQLite page cache is 8 MiB and the Node heap limit is 192 MiB. The Effect clock is fixed at 2026-10-03, so the cache window does not depend on the date the tests run.

The fixture does not run `ANALYZE` by default, so the budgets are measured as on a new install with no planner statistics yet. Set `OPENMAIL_PERF_ANALYZE=1` to measure with statistics. The app runs `PRAGMA optimize=0x10002` (`analysis_limit=400`) when it opens the database, and the sync loop runs `PRAGMA optimize` once an hour; see `packages/core/src/db/migrate.ts`.

```sh
OPENMAIL_PERF=1 pnpm test:perf
# Choose where the full SQL, query plans and measurements are written:
OPENMAIL_PERF=1 OPENMAIL_PERF_REPORT=/tmp/openmail-performance.json pnpm test:perf
```

The large-data suite is `packages/core/src/platform/node/performance-large.test.ts`. The default `pnpm test` excludes it. `performance-plans.test.ts` in the default suite checks the real Store queries in one place. The sync health and paging cases write only 120 messages; the contacts cases keep their existing candidate counts. They check index use, paging wraparound, orphaned draft deduplication and Unicode ID order. The 150k migration case runs only with `OPENMAIL_PERF=1`. The MCP measurement calls the real Toolkit handlers and Mailbox. The provider is an in-process fake and sends no network requests.

`pnpm test:perf` also runs `visible-text-cost.test.ts`, `performance-plans.test.ts` (including the 150k migration case), `src/domain/cache.test.ts` (including the 100k-thread paging case), `recovery-safety.test.ts` (four processes open the database for the first time at once, and each must get the shared lock within 1 s) and `migration37-performance.test.ts` (migration 37 on 100k messages; see below). It then runs `pnpm --filter @openmail/cli test:perf`, which runs the CLI's `mcp-server.test.ts` with `OPENMAIL_PERF=1`: while another process holds the write lock, the median time of a `list_accounts` call must be under 500 ms × `OPENMAIL_PERF_FACTOR`. perf.yml therefore covers these cases too.

In CI, [perf.yml](../.github/workflows/perf.yml) runs it: on a schedule every Monday at 06:00 UTC, by hand from the Actions page (workflow_dispatch), and from [release.yml](../.github/workflows/release.yml) through `workflow_call`, where it must pass before a tagged release. It does not run in the check on every push; on push, the growth assertion of the write-rate budget below guards instead. The job runs on macos-latest. It first builds core and the CLI with `pnpm build --filter=@openmail/cli...` (the sync measurement loads the HTML worker from `dist/`, and the MCP measurement starts the built CLI), then runs `pnpm test:perf`. The suite uses only Node and `node:sqlite`. It opens no Electron window and needs no display or network. Shared runners are noisy, so the job sets `OPENMAIL_PERF_FACTOR=2` and every wall-clock budget is multiplied by that factor. The local default factor is 1; a value below 1 or not a number counts as 1. The three JSON reports (`OPENMAIL_PERF_REPORT`, `OPENMAIL_SPARSE_PERF_REPORT`, `OPENMAIL_SYNC_REPORT`) are uploaded as the `performance-report` artifact, also on failure. The long-tail vocabulary case writes each run's latency and the median to `openmail-vocabulary-performance.json` in the same directory as `OPENMAIL_PERF_REPORT`, so it is in this artifact too. The factor is implemented in `packages/core/test-support/perf-budget.ts`. Timing rules for the everyday suite are in [tests under load](testing.md#tests-under-load).

Each item runs once first, with `EXPLAIN QUERY PLAN` collected separately, then takes the median of five warm runs; remap, invalidate and actual eviction take three, and the three `count` items take nine. Each write rolls back at the end of its transaction, so repeated measurements use the same state. The tests assert that the median is under the budget in the table below. The JSON also keeps every run's latency, the maximum and the 1/5/15-minute load at the end of the measurement.

A median over budget whose slowest run is more than 3 times its fastest gets one more pass of the same length, and the assertion uses that pass. Other processes taking the CPU for part of a pass spread its runs like that; a regression slows every run and fails the second pass too. The result keeps the first pass under `contendedPass`, and the output prints it with `(contended, measuring again)` after the name. On one shared runner `count -to: and common word` ran 236–1907 ms in one pass while the other counts stayed at 87–129 ms. Fixture creation, query plan collection and index integrity checks are not counted in the latency.

| Path                                                     | Budget ms |
| -------------------------------------------------------- | --------: |
| provider ID lookup miss                                  |         5 |
| sync-health label local counts / observed labels         |       150 |
| sync-health IMAP local counts                            |       100 |
| stale sweep label/IMAP page of 100 candidates            |       100 |
| stale sweep claim and cursor save                        |        25 |
| reset account seven-day window                           |       200 |
| reset label/IMAP thirty-day window                       |       150 |
| reset candidate persistence                              |        50 |
| unread account/label badges                              |       100 |
| list_threads first page of 50 threads                    |        75 |
| common word / CJK / operator search, 50 threads          |       150 |
| rare one/two-character CJK search, 50 threads            |        50 |
| common one/two-character CJK search, 50 threads          |       150 |
| prefix and two-word search while typing, 50 threads      |       150 |
| has:drive / has:spreadsheet, 50 threads                  |        50 |
| label: search (ID, name, plus common word), 50 threads   |       200 |
| label list view (all accounts / one account), 50 threads |       200 |
| message text + OCR search, 200 threads                   |       100 |
| OCR snippet search, 50 threads                           |       150 |
| AROUND 0 search, 50 threads                              |       500 |
| AROUND 3 search, 50 threads                              |       475 |
| AROUND sparse exact hits, 100k messages                  |       500 |
| AROUND deep-page cursor, 100k threads                    |      1500 |
| getThread, 204-message long thread                       |       100 |
| long thread model text                                   |       500 |
| 200 KiB HTML visible text                                |       150 |
| 200 KiB HTML sanitizing                                  |       200 |
| 200 KiB structured event detection                       |       100 |
| MCP list_threads / search                                |       200 |
| remap 100 identities                                     |       250 |
| invalidate IMAP folder                                   |       500 |
| message text bytes per account                           |       150 |
| message text budget full protection scan                 |      5000 |
| message text budget evicting 1 MiB                       |       500 |
| message text budget hourly gate                          |        25 |

The MCP measurement first turns on AI access for the three fixture accounts and asserts that list_threads and search both return threads. Before that, without access, both returned empty results and measured 0.3 ms. With access the medians are about 16 ms and 75 ms.

One in a thousand fixture messages contains a Google Sheet link, so has:drive and has:spreadsheet both have to skip many non-matching rows. Migration 45 records Drive links, attachment types and `cid:` inline images in `message_search_meta.search_flags`. A trigger computes them when a message is written. Rows from before the migration are NULL and are backfilled in batches in the background; the query scans message text and the attachment list only for those rows. Before the change has:drive had a median of 161 ms and has:spreadsheet 3021 ms; after it they are about 12 ms and 4 ms. The attachment type rules are frozen in `SEARCH_FLAG_ATTACHMENT_TYPES_45`. A test requires it to equal `ATTACHMENT_TYPES`, so a rule change needs a new migration.

The budget eviction test sets the INBOX retention window to 30 days and asserts that message text was actually evicted. The hourly gate test calls again after one check. Both roll back. The full budget scan still keeps message text that is starred, a draft, or inside an unlimited window.

Migration 35 adds read indexes. It extends the provider ID index to cover `ORDER BY date DESC,id`, so a lookup miss does not walk the whole account. It adds an IMAP path index, a partial index for remote drafts and a covering index for message text byte sizes. The index definitions were trimmed after the write and space acceptance in the next section. Stale sweep takes a bounded page by provider ID from each source, then merges them in SQLite BINARY order; the cursor wraps around when it ends. Date paging uses the covering metadata index. It first excludes messages that already have a newer match, then checks the row's full-text condition. Zero-distance AROUND reads by date paging. Non-zero distance first reads a window of NEAR candidates by date, computes word positions and groups only for the messages in the window, and stops once it has a result page. It uses at most two candidate windows, then falls back to the whole-database query. Message text budget paging uses a time lower bound and continues from `(COALESCE(body_opened_at,date),id)`; see [SQLite row-value paging](https://www.sqlite.org/rowvalue.html#scrolling_window_queries). Index maintenance adds write and disk cost.

The remaining scans are the label JSON within an account, the compact badge projection, the message text size covering index and FTS hit sets. They do not read all HTML. Reset returns every candidate in the window, and `COUNT(DISTINCT thread_id)` and the chosen long threads may use a temporary sort. The plan of every SQL statement actually run is saved in a temporary JSON. The default tests forbid bare scans of the large messages table and check that stale pages have no full ORDER BY sort.

## Write-rate budget

`seed-rate.test.ts` runs in the default `pnpm test`, so the Check on every push runs the growth assertion. `pnpm test:perf` also includes it, and perf.yml asserts the total time there. It creates a file database through the real open path (migrations plus the planner statistics refresh at open), then writes 10,000 fixture messages through `Store.upsertMessage`, 500 per transaction. Each transaction is timed on its own, and every 2,000 messages form a phase. Before and after each transaction it runs a CPU calibration slice (one third of the `perf-calibration.ts` loop, about 11 ms on the reference machine) and divides the transaction time by the smaller of the two ratios. It takes the smaller one because a burst of load that hits a slice but not the transaction would divide the transaction time down too far. Two assertions:

- Growth: the median calibrated transaction time of the last 2,000 messages divided by that of the first 2,000 is below 2.5. On the reference machine it is 1.1. The median drops a single transaction or slice hit by a burst. The default suite asserts only this one. Three runs in a row on a 16-core machine at load 29–43 gave growth of 1.09, 0.65 and 1.34. The old per-phase-sum method gave 1.11, 0.20 and 1.26 on the same three runs; in the 0.20 run the first phase had a 3.9 s burst.
- Total time: below 6,000 ms × `OPENMAIL_PERF_FACTOR` × max(1, calibration ratio), where the calibration ratio is the largest of the full calibration and every slice. On the reference machine it is about 3.7 s. It is asserted only when `OPENMAIL_PERF=1` is set, that is in `pnpm test:perf` and perf.yml. On Check's shared runners it failed 2 of 6 pushes while growth over the same period was only 1.17×, so Check does not assert it.

The failure message gives the total time, the budget, the calibration ratio and each phase's time. `PRAGMA optimize` at open once recorded statistics for empty FTS5 tables (fixed in `d5194310`). With that regression put back, the total time on the same machine was 12.8 s and the last phase was 4.9× the first. With per-transaction calibration and the median, two reruns at load about 40 gave 5.07× and 5.74×, total times 21.8 s and 17.2 s, and the growth assertion failed.

## Calibration ratio

Shared runner speed differs from run to run, so milliseconds alone cannot compare two CI runs. Measured alternately on a local machine, `a4d1e203` and `53688a59` both wrote 100k messages in about 40.5 s, yet on CI they differed by 2×; the gap came from runner load. At the start, the performance suite runs a fixed amount of work in an idle process (`packages/core/test-support/perf-calibration.ts`):

- `cpuMs`: a pure JS loop of 30 million integer hashes, median of three.
- `sqliteMs`: insert 20,000 rows into an indexed table in a temporary file database (WAL), 2,000 rows per transaction, median of three.

`ratio` is the geometric mean of the two relative to the reference machine (Apple M3 Max, Node 24: CPU 33 ms, SQLite 35 ms). 2 means this machine runs the same fixed work twice as slowly.

All three reports carry `calibration`. `openmail-performance.json` also has `seedPhases` (milliseconds for writing messages, OCR text chunks, word index backfill, bigram index and ANALYZE) and `calibratedSeedPhases`, and each query result has `calibratedMs`. `calibratedMs = medianMs / ratio`, the time converted to the reference machine. Compare two runs by `calibratedMs`: if the raw time doubles and `calibratedMs` stays the same, the runner got slower; if `calibratedMs` doubles too, the code got slower. Budget assertions still use raw milliseconds and `OPENMAIL_PERF_FACTOR`; the calibration ratio is only for reading reports. The exception is the write-rate budget above, whose budget is multiplied by the calibration ratio.

## One/two-character CJK search

The trigram index can only answer terms of three characters or more. A search for one or two Han, kana, Hangul, Thai or similar characters used to run LIKE on each message's subject, sender and message text, and LIKE on all derived text. Migration 48 (user_version 48) adds two contentless FTS5 tables, `messages_bigrams` and `derived_bigrams`, with the `ascii` tokenizer, `detail=column` and `prefix='1'`. `search-bigrams.ts` writes each character of these scripts as a term: it pairs with the next character of the same kind into a two-character term, and the last character of a run becomes a term on its own. A two-character search looks up the exact term and a one-character search looks up terms starting with that character, with the same results as LIKE. Contentless tables store no text and turn on `contentless_delete`, which needs SQLite 3.43 or later; the versions bundled with Node, Electron and op-sqlite all meet it.

Terms are generated in JavaScript. Triggers only write new, changed or pre-migration rows to `search_bigram_pending`, and delete the old terms immediately on change or delete. A background loop after startup and a task debounced 2 s after each change write 200 rows per batch, one transaction per batch. Rows still in the queue are searched with LIKE, so results are complete at all times; an unfinished backfill is only slower. As with trigram, a common term whose probe exceeds 2048 hits switches to checking row by row along the date index.

Ten messages in the 100k fixture contain “鲸鱼” (whale). On 2026-10-13 the four items ran on the same fixture, median of five warm runs, in ms; `OPENMAIL_PERF_MEASURE` takes several names separated by commas. The one-minute load was 10–29, above 12, so the results are only for comparison: <!-- cjk-ok -->

| Measurement                             | Before | After |
| --------------------------------------- | -----: | ----: |
| rare two-character “鲸鱼” (whale)       |  127.1 |   4.5 | <!-- cjk-ok --> |
| rare one-character “鲸” (whale)         |  123.7 |   3.6 | <!-- cjk-ok --> |
| common two-character “预算” (budget)    |   28.2 |  15.4 | <!-- cjk-ok --> |
| common one-character “会” (meeting/can) |   30.1 |  16.0 | <!-- cjk-ok --> |

```sh
OPENMAIL_PERF_MEASURE="search CJK rare 2-char,search CJK rare 1-char,search CJK common 2-char,search CJK common 1-char" pnpm test:perf
```

## Prefix search while typing

The search box searches the unfinished last word as a prefix: `we` searches `we*`. `messages_words` has no prefix index, so each prefix query merges the doclists of every term that starts with it. When a common term was checked row by row along the date index, the code opened one MATCH per row, so the prefix was merged again for each row: `pe*` for 200 threads took 5.9 s on the 100k fixture. Now the in-row check for a prefix tests whether the rowid is in the prefix's hit set. The set is built once per statement and written as `(m.rowid+0) IN (...)`, so the set does not drive the date walk. Exact terms are still probed row by row. When several ordinary terms appear together in most messages (such as `weekly de*`), `planTextPage` also probes the combined MATCH and switches to the date walk above 2048 hits. Before, it started from every rowid of the first term, and `weekly delivery` for 50 threads took 67 s. The representative message for an attachment hit is looked up by id and no longer follows the common term's date walk.

Measured on 2026-10-16 on the same data, Node v24.21.0, median of five warm runs, one-minute load 4–15, in ms, 50 threads:

| Measurement                | Before | After |
| -------------------------- | -----: | ----: |
| fixture `we*`              |    376 |    77 |
| fixture `pe*`              |   1654 |   131 |
| fixture `weekly de*`       |  69417 |   111 |
| fixture `weekly`           |     34 |    34 |
| long-tail vocabulary `co*` |    973 |    80 |
| long-tail vocabulary `re*` |   1227 |    86 |

Prefixes that hit almost every message have their own cases. In the long-tail vocabulary, two syllables start with `se`, se and sel, so `se*` matches about 2,500 terms and hits all 100k messages. Before, every result page ran BM25 on the chosen messages with `MATCH` over all highlight terms, and the prefix expanded to every term it starts: `se* co*` took 157 ms in total, 47 ms of it BM25. BM25 only ranks messages when attachment text also hits, so `loadRelevance` now runs only when the page has an attachment hit. Same data on 2026-10-16, median of five warm runs, in ms, 50 threads:

| Measurement | Before (load about 22) | After (load about 10) |
| ----------- | ---------------------: | --------------------: |
| `se*`       |                     88 |                    62 |
| `se*` flat  |                     64 |                    37 |
| `se* co*`   |                    157 |                   111 |
| `a*` flat   |                     41 |                    25 |

All these cases have a 150 ms budget. [search-relevance.test.ts](../packages/core/src/store/search-relevance.test.ts) in the default suite checks that BM25 does not run without an attachment hit, and that with an attachment hit a subject hit ranks ahead of a body hit.

The long-tail vocabulary case builds a separate 100k-message set in `performance-large.test.ts`, with words drawn from 50,000 synthetic words in a heavy-head, long-tail distribution. `search-prefix-plans.test.ts` in the default suite uses 3,000 messages and compares against reference results computed directly from message text. It covers prefixes, exact terms, two-word queries, paging and account scope, and checks that prefixes do not run MATCH row by row. A prefix index would cut the MATCH for `co*` from about 13 ms to 2 ms, but the word index would grow 2.4× and need a rebuild on upgrade, so it is not added for now.

## label: search and label lists

After round 18 made `label:` match names case-insensitively, one `label:Folder_5` took 20 s on the 100k fixture. There were two causes:

- The name branch was written as `j.value IN (SELECT id FROM labels WHERE account_id=m.account_id AND name=? COLLATE NOCASE)`. The subquery refers to `m.account_id`, so SQLite rebuilt the IN list for each message. Counting 100k rows took 912 ms, against 143 ms without the reference to `m`.
- The thread page filter put the newest-in-thread check (`NOT EXISTS (SELECT 1 FROM candidates n …)`) before the row's own condition. Each row of the date walk ran this check first, and the check ran the full filter on every newer message in the thread, about 2 million label tests in total.

Changes:

- The name lookup is now `(m.account_id,j.value) IN (SELECT account_id,id FROM labels WHERE name=? COLLATE NOCASE)`, so the list is built once per statement. Matching by ID and system labels is unchanged.
- The date walk (when `listIndex` provides an index) tests the row's own filter first, then does the newest-in-thread check: `CASE WHEN filter THEN newestMatch ELSE 0 END`. Without the date walk it is written as `filter AND newestMatch`. Wrapping everything in CASE would hide `m.id IN (…)` and the search flags from the planner: has:drive went from 15 ms to 320 ms and CJK from 3.4 ms to 371 ms.
- `label:` plus a common word (`label:Folder_5 weekly`) used to start from every rowid of `weekly`, read 100k rows and sort them, about 1.5 s. `planTextPage` now lets searches with only `label:` take the date walk: the walk tests the label and searchability first, then the newest-in-thread check, and only then runs MATCH row by row on the candidate thread heads. The optimistic `recent` window also tests the row's condition first. `messages_list_date_id` covers `labels_json`, so the label test does not read the table. Other operators still do not take this path. A count cannot test labels on the word index, so `countThreads` counts by row for searches with `label:`.
- Single-account label lists and mailbox views other than Inbox (such as Starred) also use `messages_list_date_id`. They used `messages_account_list_date_id`, which does not contain `labels_json`, so every walked row read the table, and a folder holding 1/67 of the messages took 600 ms. Single-account Inbox still uses the account index.

Measured on 2026-10-17 on the reviewer's copy of the 100k fixture (`seedMailbox(100_000)`, no ANALYZE), Node v24.21.0, median of three warm runs, 50 threads, in ms. One-minute load was 11–64 before the fix (16 cores) and about 11 after:

| Measurement                          | Before | After |
| ------------------------------------ | -----: | ----: |
| `label:Folder_5`                     |  20390 |    16 |
| `label:"folder 5"`                   |  20150 |    20 |
| `is:unread label:Folder_7`           |   2085 |    13 |
| `label:Folder_5 OR from:person7`     |  17828 |    39 |
| `label:Folder_5 weekly`              |  30076 |    36 |
| `label:Folder_5 we*`                 |  33903 |    66 |
| `label:INBOX weekly`                 |  57539 |    35 |
| `label:Folder_5`, one account        |   7216 |    25 |
| `label:Folder_5 weekly`, one account |   8078 |    68 |
| Starred list (0 results)             |   1184 |    34 |
| label list, all accounts             |   1721 |    22 |
| label list, one account              |    575 |    21 |
| `weekly`                             |     32 |    30 |
| `we*`                                |     63 |    63 |
| `pe*`                                |    107 |   107 |
| `预算` (budget)                      |     17 |    17 | <!-- cjk-ok --> |
| has:drive                            |     12 |    11 |
| `in:inbox`                           |     12 |    13 |
| Inbox list                           |     11 |    13 |

The result page, second page and count match item by item on both sides. With only the first two changes, `label:Folder_5 weekly` for 200 threads still took 1.5 s; with the third added it took 68–91 ms.

[search-label-plans.test.ts](../packages/core/src/store/search-label-plans.test.ts) in the default suite uses 3,000 messages and compares against reference results computed directly from labels and message text. It covers label IDs, names and case, two accounts with the same name but different IDs and with the same ID but different names, system labels, negation, OR, combinations with words and `is:`, threads and flat, one account, the second page and counts, and also label lists and the Important view. It also checks that no `CORRELATED` precedes the label lookup in the query plan, that the date walk tests the label before looking for newer matches in the thread, and that MATCH comes after that check. The three `search label:` items and the two `list label view` items in `performance-large.test.ts` have a 200 ms budget; one run with `OPENMAIL_PERF=1` gave medians of 15, 17, 35, 19 and 21 ms.

Extending `messages_account_list_date_id` into an index covering `labels_json` was tried. Without statistics the planner changed plans: the single-account label list went from 578 ms to 23 s and the single-account Inbox from 15 ms to 2.5 s, so no migration was added. Label lists are now within 30 ms, and a `message_labels(account_id,label,row_id)` side table is no longer needed.

Operator searches that find no results are covered under “to:, cc:, filename:, list:” in the next section.

## subject:, OR and operator search

On 2026-10-17 the reviewer found three kinds of slow search on two data sets. Fixture P is the 100k fixture above (`seedMailbox(100_000)`, with 10k OCR chunks). Fixture R is 100k messages of about 10 KB in one Gmail account plus 2k in one Outlook account, a 2.3 GB database, in two copies with and without planner statistics. All numbers below were measured on Node v24.21.0 with 50 threads, in ms, median of three warm runs; “cold” is the first run after the process opens the database. The result page, second page, unread/starred flags, thread count and count match item by item before and after the fixes.

### Common words with subject:

`subject:report` took 53 s on fixture P and 19.8 s for one account. Two causes:

- The thread page's `page` CTE computed unread and starred in its select list (two EXISTS on `flag_candidates`), before `ORDER BY … LIMIT`. When the page started from the word index's rowids, SQLite computed them for every matching row, about 1 ms per row.
- `subject:` set criteria on the query, so `planTextPage` returned early and did not take the date walk. It could only start from the 100k rowids of `subject : "report"`.

Changes:

- Unread and starred moved to the outer SELECT and are computed only for the at most limit rows `page` selects.
- `planTextPage` lets `subject:` take the date walk like `label:`: it ANDs `(subject : "report")` with the other terms into the `commonTerm` probe, walks the date index above 2048 rows, and probes MATCH by rowid on each row. Counts still use the word index.
- The thread page's unsearched superset drops `subject:`, the same as ordinary words. If kept, the newest-in-thread check probes MATCH once for every newer reply of every walked row. The newest 20k messages of fixture P belong to 100 long threads of 204 messages, so a single account needed about 30,000 probes, 900 ms.

`subject:` with other operators (such as `subject:report -from:person1`) still starts from rowids and gets only the first change: 48 s to 329 ms.

Fixture P, before and after (no ANALYZE):

| Measurement                             | Before | After |
| --------------------------------------- | -----: | ----: |
| `subject:report`                        |  54770 |    18 |
| `subject:report`, one account           |  20331 |    65 |
| `subject:"weekly report"`               |  52537 |    18 |
| `subject:"weekly report"`, one account  |  20804 |    65 |
| `subject:weekly is:unread`, one account |  20015 |    86 |
| `subject:report -from:person1`          |  48282 |   329 |
| `-to:nobody weekly`                     |  53985 |   483 |
| `subject:report`, flat                  |    134 |     7 |

`-to:nobody weekly` also starts from rowids and likewise benefits only from the first change.

When a count cannot use the word index (with conditions such as `is:unread`), it counts by row. It used to reuse the page's per-row MATCH probe, probing once for each of the 100k messages. Now the count uses the word index's rowid set; every match has to be read anyway, and the set is cheaper. On fixture P the count for `subject:weekly is:unread` went from 288 ms to 77 ms, `weekly is:unread` from 288 ms to 76 ms and `weekly delivery is:unread` from 559 ms to 89 ms, with the same values.

[search-operator-plans.test.ts](../packages/core/src/store/search-operator-plans.test.ts) in the default suite uses 3,000 messages (including one long thread of 60 messages) and compares against reference results computed directly from stored fields. It covers single words, phrases, case, prefixes, combinations with ordinary words and `is:`, negation, threads and flat, one account, the second page and counts. It also checks that the `page` CTE has no `flag_candidates`, that the `recent` window for a common `subject:` word uses the date index and contains no `messages_words`, and that statements counting by row do not probe by rowid row by row. `search subject: common` and `search subject: phrase` in `performance-large.test.ts` have a 200 ms budget.

### OR and attachment text

Once OCR and PDF text were indexed, OR searches on fixture P took 13–18 s. Both places had the same flaw: a condition on chunks was probed message by message.

- The statement that adds attachment hits to the returned threads (`store-search-matches.ts`) wrote `m.id IN (ids of messages in the chosen threads)`. Without statistics the planner started from `derived_words MATCH` and probed `derived_chunks_message` once per chosen id for each matching chunk. With `+m.id IN (…)`, each chunk finds its message by its own rowid. The reviewer measured this statement alone at 13,016 ms before and 25 ms after; the whole `weekly OR alpha` request went from 14,752 ms to 89 ms.
- The page filter wrote each term's attachment text check as `EXISTS(SELECT 1 FROM derived_chunks d WHERE d.message_id=m.id AND d.id IN (SELECT rowid FROM derived_words WHERE derived_words MATCH ?))`. The IN list is every matching chunk, so for each message checked SQLite probed the index once per chunk id in the list. In `invoice OR weekly`, invoice is in all 10k chunks, and with only the previous change it still took 4.3 s. Now each statement builds the message id set once: `+m.id IN (SELECT d.message_id FROM derived_chunks d WHERE d.id IN (MATCH))`. Like `(m.rowid+0) IN (…)` for prefix terms, this keeps the set from driving the walk. The word index and the trigram index use this set; rows in the bigram queue and LIKE are still tested message by message.

Fixture P, before and after:

| Measurement                      | Before | After |
| -------------------------------- | -----: | ----: |
| `weekly OR alpha`                |  13284 |    91 |
| `weekly OR alpha`, one account   |   9437 |    82 |
| `(weekly OR delivery) is:unread` |  13389 |    81 |
| `invoice OR weekly`              |  17805 |   104 |
| `invoice OR weekly`, one account |  12055 |    96 |
| `invoice OR weekly` count        |  21536 |   161 |
| `invoice OR weekly` flat count   |  20181 |    95 |
| `invoice OR zzzzunmatched`       |  17617 |    65 |
| `weekly OR 鲸鱼` (whale)         |    103 |    98 | <!-- cjk-ok --> |

Counts also use the page filter, so the count for `invoice OR weekly` dropped from 21.5 s to 161 ms. The OR part of search-operator-plans.test.ts covers ordinary words, combinations with `is:`, words only in attachment text, negation and `subject:`. Pages with attachment hits are sorted by relevance, so only the thread sets are compared. It checks that the query plan for attachment text has no per-row probe on `derived_chunks_message (message_id=? AND rowid=?)`, and that the statement adding attachment hits writes `+m.id IN`. A small database does not pick the old bad plan even without statistics, so the second check only inspects the statement text. `search OR`, `search OR is:unread` and `search attachment word OR common` in `performance-large.test.ts` have a 200 ms budget.

### to:, cc:, filename:, list:

`to:`, `cc:`, `filename:` and `list:` searches that find no results have to check every message: read the row, then run `json_each` on `to_json`, `cc_json`, `attachments_json` or `headers_json`. `to_json` and `cc_json` come before `body_text`; `attachments_json` and `headers_json` come after it. The cost is mostly random page reads per row plus `json_each`. It took 1–2 s on fixture P, and up to 6 s cold on the reviewer's 2.3 GB fixture R.

Migration 57 adds a side table `message_operator_text(row_id, to_text, cc_text, file_text, list_id_text, list_post_text)`, one row per message. The SQL is in `packages/core/src/db/operator-text.ts`:

- Each column joins multiple values with char(30), and separates name and address with char(31). A LIKE pattern without those two characters can only hit within one value, the same as the old per-`json_each`-value test. When the search value contains those characters or is empty, the old per-row test is still used.
- INSERT, UPDATE and DELETE triggers on `messages` maintain the table, deleting before inserting. The UPDATE trigger runs only when one of the four JSON columns actually changed, so a sync that only changes labels does not write the side table. `json_valid` and `type='object'` skip bad JSON, so writes do not fail because of it.
- The migration itself does not backfill: one backfill took 13.7 s on 2.3 GB, and migrations run synchronously in the startup window. `message_operator_text_backfill` records the maximum rowid at migration time. A background loop (`mailbox-live.ts`, after the word index and has: flags) commits 200 rows per batch and can be interrupted and resumed. Until the backfill finishes, these operators keep the old per-row test with the same results. After it finishes they switch to `(m.rowid+0) IN (SELECT row_id FROM message_operator_text WHERE to_text LIKE ? ESCAPE '\')`; `+0` keeps the set from driving the walk. On a new install the migration sees an empty table and marks itself done.

Write cost: for 10,000 messages with recipients, attachments and List-Id, insert went from 2.75 s to 2.84 s (+3%), and a rewrite that only changes labels from 2.15 s to 2.17 s. The backfill uses 200 rows per batch, the same as the word index default:

| Data                          | Total time | Batches | p50 per batch | p95 per batch | Slowest batch |
| ----------------------------- | ---------: | ------: | ------------: | ------------: | ------------: |
| fixture P (600 MB)            |      1.9 s |     500 |          3 ms |          5 ms |         38 ms |
| fixture R (2.3 GB)            |     17.2 s |     510 |         27 ms |         35 ms |        402 ms |
| fixture R, 500 rows per batch |     14.4 s |     204 |         63 ms |        100 ms |        249 ms |

At 500 rows per batch, p95 reaches 100 ms and the write lock is held longer, so the batch size is 200. In both batch sizes the slowest batches are scattered 250–400 ms ones partway through, unrelated to batch size.

Fixture P, before and after:

| Measurement                          | Before | After |
| ------------------------------------ | -----: | ----: |
| `to:nobody@example.com`              |   1926 |    20 |
| `to:nobody@example.com`, one account |    685 |    11 |
| `cc:nobody`                          |   1034 |    18 |
| `filename:none.pdf`                  |   1117 |    19 |
| `list:nolist`                        |    926 |    22 |
| `to:nobody OR cc:nobody`             |    177 |    27 |
| `to:recipient` (every message hits)  |     13 |    63 |
| `to:recipient`, flat                 |    0.3 |    13 |
| `filename:report.pdf` (1/10 hit)     |     49 |    26 |
| `-filename:report.pdf from:person1`  |     22 |    42 |
| `to:recipient filename:report`       |     80 |    78 |

The cost is on common hits. Before, the first few dozen rows of the date walk filled a page; now each statement first scans the side table to build the set. The thread page's `candidates`, `flag_candidates` and `page` each scan once, about 15–20 ms each on fixture P, so `to:recipient` went from 13 ms to 63 ms. No-result and sparse searches dropped from seconds to about 20 ms, so this cost is accepted.

The operator part of search-operator-plans.test.ts covers the four operators, case, `_` escaping, empty recipients and NULL headers, negation, OR, combinations, threads and flat, one account, the second page and counts. It compares against reference results in four states: a new database (no backfill needed), a simulated old database (a third of the rows have no side table row and the backfill has not started), half backfilled and fully backfilled. It also compares after changing recipients, attachments and headers through `upsertMessage`, changing only flags, deleting with `deleteMessage`, and writing new messages. In each state it checks whether the query used the side table or the per-row test, and compares the side table row by row with values recomputed by `operatorTextValues("m")`. Another test upgrades from a user_version 56 database and confirms that the migration does not backfill and that search results are the same before and after the backfill. The four `no match` measurements in `performance-large.test.ts` have a 200 ms budget.

### fixture R

The 2.3 GB fixture R has no OCR chunks, so OR was already fast. “One account” is the 2k-message Outlook account. The database file was a fresh copy, but the system page cache was not cleared, so the “before” operator numbers in the table are lower than the reviewer's 6 s cold reads. The fixed database finished its backfill before timing.

| Measurement                     | No stats before | No stats after | Stats before | Stats after |
| ------------------------------- | --------------: | -------------: | -----------: | ----------: |
| `subject:report`                |           99271 |            126 |       102633 |         131 |
| `subject:report`, one account   |            2450 |            134 |         2610 |         146 |
| `subject:"weekly report"`       |           93070 |            122 |        96238 |         128 |
| `-to:nobody weekly`             |           92186 |            925 |        94752 |        1184 |
| `weekly OR alpha`               |             154 |            145 |          147 |         149 |
| `to:nobody@example.com`         |             354 |             18 |          362 |          19 |
| `cc:nobody`                     |             282 |             17 |          284 |          18 |
| `filename:none.pdf`             |             480 |             17 |          493 |          17 |
| `list:nolist`                   |             227 |             21 |          244 |          21 |
| `to:me3@example.com` (2% hit)   |              10 |             24 |           11 |          23 |
| `filename:report3.pdf` (no hit) |             469 |             18 |          835 |          17 |

For 36 query shapes, the result page, second page, flags, thread count and count match item by item on both databases.

Common-word searches with negation and OR counts were changed later too; see the next two sections.

### Operators plus a common word

`planTextPage` used to let only searches with `label:` or `subject:` take the date walk; any other operator made it start from every rowid of the common word. `-to:nobody weekly`, `from:person1 weekly` and `has:attachment weekly` on fixture R read about 100k rows of `weekly` and sorted them, 0.4–0.8 s, while `weekly` alone took 128 ms.

Now a search takes the date walk whenever every operator can be tested on the walked row:

- `from:`, `is:unread`, `is:starred`, `is:important`, `has:attachment`, plus the existing `label:` and `subject:`. `is_unread`, `is_starred` and `labels_json` are in `messages_list_date_id`. `from_name` and `from_addr` come before the message text. `has:attachment` reads `attachments_json`, which comes after the message text, but the walk stops once the page is full.
- `to:`, `cc:`, `filename:` and `list:` join only after `message_operator_text` is fully backfilled, when each statement reads the side table once. Before the backfill finishes they run `json_each` row by row and still start from rowids.
- Negations (`-to:`, `-from:` and so on) use the same list, but without `subject:` and `label:`.

The `message_search_meta` shortcut in `countThreads` counts only by the word index's MATCH and ignores criteria. Before, only `subject:` reached it (it is inside the MATCH). Now `planTextPage` also sets `textPage` for `from:` and others, so the shortcut is limited to criteria that are only `subject:` or empty; everything else counts by row. Without this limit the count for `to:r3 weekly` was 1542; the correct value is 350.

The worst case is a sender with no hits: `from:nobody weekly` has to walk the whole date index once. Thread mode used to walk it twice; see “Date walks with no match” below.

Fixture R, no stats, before and after (ms, median of three warm runs; counts run once each):

| Measurement                       | Before | After |
| --------------------------------- | -----: | ----: |
| `-to:nobody weekly`               |    829 |   148 |
| `-to:nobody weekly`, one account  |    431 |   165 |
| `-from:nobody weekly`             |    823 |   129 |
| `from:person1 weekly`             |    443 |   130 |
| `has:attachment weekly`           |    618 |   130 |
| `-has:attachment weekly`          |    791 |   128 |
| `is:important weekly`             |    871 |   137 |
| `to:me3@example.com weekly`       |    406 |   150 |
| `-filename:report weekly`         |    770 |   139 |
| `-cc:nobody -to:nobody weekly`    |    840 |   172 |
| `-from:person1 subject:weekly`    |    725 |   139 |
| `-to:nobody alpha`                |    842 |   140 |
| `to:nobody weekly`                |    118 |    74 |
| `from:nobody weekly` (worst case) |    125 |   247 |
| `-to:nobody weekly` count         |    424 |   175 |
| `-from:nobody weekly` count       |    420 |   177 |

28 searches, each in thread, one-account and flat shapes, 84 cases in all: the result page, second page, flags, thread count and count match item by item.

“operators with a common word” in search-operator-plans.test.ts compares 13 searches (including negation, a sender with no hits, `has:attachment` and multiple negations) against reference results. It checks that each one's `recent` window uses `messages_list_date_id` and that the count does not use `message_search_meta_threads`, and that `to:r3 weekly` does not take the date walk while the backfill is unfinished. operator-text-diff.test.ts moves the reviewer's randomized differential test into the default suite. Each round does 40 random writes (new messages, rewrites, flags, local operations, deletes, provider id changes, added headers, evicted message text, deleted Spam, deleted accounts), then compares the side table row by row with recomputed values, and compares the result pages and counts of 25 operator searches with the side table and with the per-row test. It runs 10 rounds by default and 50 with `OPENMAIL_PERF=1`; `OPENMAIL_DIFF_SEED` changes the random sequence. `performance-large.test.ts` adds `search -to: and common word`, `search from: and common word` and `search has:attachment and common word` with a 200 ms budget, and `search from: no match and common word` with a 350 ms budget. One run with `OPENMAIL_PERF=1` on 2026-10-17 gave medians of 72, 30, 33 and 155 ms in that order.

### is:important plus a common word

After r21 let `is:important` plus a common word take the date walk, flat mode got slower. `messagePage` joined `listFilter(q)` directly with AND. `is:important` compiles to a bare `json_each` EXISTS, and SQLite put the per-row `EXISTS (… messages_words MATCH ?)` before the label check, so it queried the word index once for every walked row. Thread mode did not have this problem: `headFilter` uses CASE to test the row's own condition first.

Now `messagePage` also uses `CASE WHEN listFilter(query without words) THEN listFilter(q) ELSE 0 END` when it has a `textPage`. The account scope stays outside the CASE, so the account index can still use it. `unsearchedQuery` generates the query without words, shared with thread mode.

One account had a second problem. `listIndex` chose `messages_account_list_date_id` for single-account text pages, which does not contain `labels_json`, so each walked row went back to the table to read `labels_json`. Now, whenever a text page tests labels (`is:important`, `label:`, their negations, the list filters Important and In Inbox, search by folder), single-account pages also use `messages_list_date_id`, which covers `labels_json`, matching the rule for label views.

A 50k-message fixture (2 accounts, 1/1000 with IMPORTANT, `weekly` in every message), no stats, warm cache, median of the last three of four runs (ms). “Row set” is the plan with `CommonTermRows` set to 1e9, starting from word index rowids, for reference:

| Measurement                                          | Before | After | Row set |
| ---------------------------------------------------- | -----: | ----: | ------: |
| `is:important weekly`, flat                          |    863 |    30 |     237 |
| `is:important weekly`, flat, one account             |   1092 |    30 |     245 |
| `is:read is:important weekly`, flat                  |    645 |    26 |     194 |
| list filter Important plus `weekly`, flat            |    857 |    27 |     236 |
| `is:important weekly`, threads, one account          |    237 |    30 |       - |
| `is:important weekly`, threads                       |     32 |    29 |     422 |
| `is:important weekly`, one account, small 1k account |     22 |    19 |       - |

The flat search for the list filter Important plus a common word (841 ms before r21) is fixed by the same change. A small account using the global index reads other accounts' index entries but does not go back to the table, so it did not get slower.

“is:important with a common word tests the label before the word index” in search-operator-plans.test.ts compares `is:important weekly`, `is:read is:important weekly` and `-is:important weekly` in thread, flat and one-account shapes, plus the flat list filter Important with `weekly`, against reference results. For every statement that has both a word index probe and a label check, it checks that `SCAN json_each` comes before `SCAN messages_words` in the query plan, and that flat pages (including one account) use `messages_list_date_id`. Before the change this test failed in both places.

walk-plan-diff.test.ts is the reviewer's randomized differential test: 2 accounts and 1,500 randomly generated messages, with random combinations of operators, negation, OR, one account, by folder, list filters and the `is:unread` toggle. It compares the first page, second page, flags and count under `CommonTermRows=0` (date walk wherever possible) and `1e9` (always start from rowids), once with the side table backfilled and once without. By default it runs 60 searches (120 comparisons); `OPENMAIL_PERF=1` uses 3,000 messages and 300 searches, and `OPENMAIL_DIFF_SEED` changes the random sequence. The test requires that at least a quarter of the comparisons take the date walk and that some reach an empty page.

The `performance-large.test.ts` fixture adds IMPORTANT to 1/1000 of the messages and adds three items, `search is:important and common word, flat`, `search is:important and common word, flat, one account` and `search Important list filter and common word, flat`, with a 200 ms budget. One run with `OPENMAIL_PERF=1` on 2026-10-17 gave medians of 32, 52 and 30 ms in that order.

### Date walks with no match

The fast path of `threadPage` first takes `recent`: the newest `limit` thread heads by date without the word conditions, then checks whether they match the full query. Before, whenever there were fewer than `limit` results it ran the full query as well. With no match, both statements walked the whole date index: `-is:important -has:attachment from:nobody weekly` was two statements of about 200 ms each.

Every match satisfies the conditions without words. When `recent` has fewer than `limit` rows, it holds all thread heads without words. If a thread's head without words matches the full query, it is that thread's newest match. So when `recent` is not truncated and every row in it matches, the fast path's result is the full result; when `recent` is empty, the result is empty. The fast statement now returns the window size with `(SELECT COUNT(*) AS recent_count FROM recent) r LEFT JOIN page c`, which returns one row even with no match. The full query runs only when there are fewer result rows than `recent_count`.

The same 50k-message fixture (ms):

| Measurement                                                     | Before | After |
| --------------------------------------------------------------- | -----: | ----: |
| `-is:important -has:attachment from:nobody weekly`              |    404 |   197 |
| `-is:important -has:attachment from:nobody weekly`, one account |    396 |   197 |
| `from:nobody weekly`                                            |    120 |    56 |

Flat `from:nobody weekly` across two accounts was already one statement and stays at 56 ms.

“a date walk with no match or a short window of matching heads runs once” in search-operator-plans.test.ts takes 4 searches with no match and 1 search that hits only a few threads (`from:s3 is:starred weekly`). For all accounts and for one account, it checks that there is only one statement with `page AS MATERIALIZED`, that it contains `recent`, and that the results match the reference. The first 5 searches of walk-plan-diff.test.ts hit only a few threads; the test requires that thread-mode date walks include both empty results and non-empty short results that ran only the fast path. 7 seeds of 300 searches each (`OPENMAIL_PERF=1`, 4,200 comparisons in all) showed no differences. `performance-large.test.ts` adds `search negations, no match and common word` with a 350 ms budget, the same as `from:nobody weekly`. One run with `OPENMAIL_PERF=1` on 2026-10-17 gave it a median of 91 ms, and `search from: no match and common word` dropped from the 155 ms above to 89 ms.

### Counts excluding Spam and Trash

Counts for OR and operator searches excluded spam and trash with `NOT EXISTS (SELECT 1 FROM json_each(m.labels_json) …)`. `labels_json` comes after `body_text` and `body_html`, so every counted row read its overflow page chain. On fixture R the reviewer measured a cold `weekly OR alpha` count at 3.4 s, with 410,000 page faults and 1.6 GB read.

`countThreads` now sets `metaEligible` for counts, and `listFilter` uses `EXISTS (SELECT 1 FROM message_search_meta s WHERE s.row_id=m.rowid AND s.eligible=1)`, which text pages already use. The migration 30 triggers maintain `eligible` with the same SPAM/TRASH rules, so the results are unchanged.

Fixture R, no stats, warm cache, counts run once each (ms):

| Measurement                      | Before | After |
| -------------------------------- | -----: | ----: |
| `weekly OR alpha`                |    442 |    68 |
| `weekly OR alpha`, flat          |     73 |    43 |
| `to:nobody OR weekly`            |    438 |    64 |
| `to:nobody OR weekly`, flat      |     80 |    51 |
| `(weekly OR delivery) is:unread` |     43 |    33 |
| `is:important weekly`            |    401 |   361 |

The result page, second page and count of the 84 cases still match item by item. This machine cannot clear the system page cache, so there are no cold numbers; the reviewer measured cold `weekly OR alpha` counts at 3412 ms before and 54 ms after, and `to:nobody OR weekly` at 426 ms and 61 ms.

The `has:attachment` count is unchanged at about 340 ms on fixture R: it reads `attachments_json`, which also comes after the message text. No existing column can replace it. `search_flags` only has per-type bits, with no “has attachment” bit. `message_operator_text.file_text` is an empty string for a message whose only attachment has no file name, which cannot be told apart from no attachment. Making it fast needs a new migration that adds a flag bit and backfills it. The `is:important weekly` count also stays at about 360 ms, because the `IMPORTANT` label needs `labels_json`.

The OR part and “operators with a common word” in search-operator-plans.test.ts check that every statement counting by row contains `s.row_id=m.rowid AND s.eligible=1` and does not contain `json_each(m.labels_json)`. `performance-large.test.ts` adds `count OR`, `count operator OR common word` and `count -to: and common word` with a 250 ms budget, warm cache. One run with `OPENMAIL_PERF=1` on 2026-10-17 gave medians of 55, 64 and 110 ms in that order.

### Search in the current folder from a label view

When the user switches search scope to “Current folder” in a label view and types a common word, the desktop app sends `{search, searchScope:"folder", label, mailbox}` (`apps/desktop/src/renderer/src/state/threads.ts`). `planTextPage` used to return early for `q.label && q.searchScope === "folder"` without setting `textPage`, so the query started from every `messages_words` rowid of `weekly` and sorted by date in a temporary B-tree (`SCAN messages_words VIRTUAL TABLE INDEX 0:M4`, `USE TEMP B-TREE FOR ORDER BY`).

The first version of `planTextPage` in `60f0d7e9` added this early return. At the time, the date walk did the newest-in-thread check before testing the label on each row, and `messages_list_date_id` was not yet used for text pages with labels, so a sparse label plus a date walk would be slow. The “label: search and label lists” section above changed both: the walk tests the row's own label first, and `messages_list_date_id` covers `labels_json`. `label:Folder_5 weekly` has taken the date walk since then, and a label view searched by folder uses the same filter, with the label taken from the view.

Changes:

- Remove this condition from `planTextPage`.
- `testsLabels` used to count search by folder as a label test only when `mailbox` was not `all`, and missed `q.label`. A single-account label view with `mailbox: "all"` therefore walked `messages_account_list_date_id`, which does not contain `labels_json`, and went back to the table for every row. The condition is now `searchScope === "folder" && (mailbox is not all || label is set)`, and such queries use `messages_list_date_id`.

100k fixture (`seedMailbox(100_000)`, Folder_5 on 1/67 of the messages, no ANALYZE), Node v24.21.0, median of five warm runs in `performance-large.test.ts`, 50 threads, in ms. One-minute load was 8–23 before the fix (16 cores). The after numbers come from a full `OPENMAIL_PERF=1` run at load 52–63 and are only for comparison:

| Measurement                            | Before | After |
| -------------------------------------- | -----: | ----: |
| `weekly`, Folder_5, `mailbox: "all"`   |   2159 |    27 |
| `subject:weekly alpha`, same           |   2460 |    25 |
| `weekly`, same, flat                   |    151 |    13 |
| `weekly`, Folder_5, `mailbox: "inbox"` |   1824 |    31 |

On their own copy of the fixture the reviewer measured 498, 586, 132 and 336 ms before the fix and 9, 11, 6 and 10 ms after.

[search-label-plans.test.ts](../packages/core/src/store/search-label-plans.test.ts) in the default suite compares two labels (`Label_1` and `IMPORTANT`), three mailboxes (`all`/`inbox`/`important`) and three searches, in thread and flat and for all accounts and one account, against reference results. It also checks that every page statement's plan has `SCAN m USING … INDEX messages_list_date_id` and probes the word index by rowid, and that flat page plans have neither `SCAN messages_words VIRTUAL TABLE INDEX 0:M` nor `USE TEMP B-TREE FOR ORDER BY`. With the fix removed these items fail; with only the `testsLabels` half removed, the plan check for single-account `mailbox: "all"` fails. The random searches in [walk-plan-diff.test.ts](../packages/core/src/store/walk-plan-diff.test.ts) give label views a random mailbox, and after the random searches a fixed round runs: 7 labels (a user label, INBOX, IMPORTANT, STARRED, CATEGORY_SOCIAL and CATEGORY_PERSONAL, which Gmail and Outlook test differently) × 5 mailboxes (unset, inbox, all, starred, important) × threads and flat, 70 comparisons in all. Each must take the date walk and is then compared with the plan that starts from rowids on both pages, flags and count. With `OPENMAIL_PERF=1`, seeds 1–4 and 11 show no differences. `performance-large.test.ts` adds four `search current folder in label view…` items with a 200 ms budget.

### performance-large.test.ts

The nine new measurements all use 200 ms, the same as `label:` search. Medians from one `OPENMAIL_PERF=1` run on 2026-10-17 (ms): `search subject: common` 15, `search subject: phrase` 18, `search OR` 94, `search OR is:unread` 85, `search attachment word OR common` 108, `search to: no match` 24, `search cc: no match` 20, `search filename: no match` 20, `search list: no match` 26. The three OR items are only about 2× under the budget, because every run has to build the message id set for attachment text and add attachment hits to the page, so they were not tightened to 150 ms. The others are far under the budget; 200 ms is a regression line, not a target.

### Slow RPCs

The desktop main process's RPC protocol (`apps/desktop/src/main/rpc/rpc-security.ts`, shared by local windows and remote access) records each request's start time. When a request in `TIMED_RPCS` returns after 1 s or longer, it writes one `rpc-slow` line with `logWarning`. The line holds only the RPC name and duration, for example `RPC Threads took 2400 ms`, with no query text or arguments. The diagnostics file records only the code `rpc-slow`. Each RPC writes at most one line per minute, so a burst of slow searches leaves one line. Requests the client aborts do not count.

`TIMED_RPCS` lists only RPCs that read the local database and in-memory state, such as `Threads`, `ThreadCount`, `Thread`, `UnreadCounts`, `UnreadByLabel`, `Labels`, `KnownSenders`, `Accounts` and `Prefs`. They normally return in a few milliseconds, so over 1 s means the local machine is stuck. Before, every non-stream RPC was timed. `AwaitUndoSend` waits for the undo time on every send (about 5.5 s), `Connect` and `Reauth` wait for browser sign-in, `AskAi`, `Summarize`, `ComposeAi` and `AiTriage` wait for the model, `Send`, `Sync`, `SearchServer`, `CheckForUpdates` and `CompactCache` go to the network or disk, and dialogs like `SaveAttachmentsTo` wait for the user. All of these wrote `rpc-slow` and buried the real local stalls. `InlineImages` downloads the raw message the first time it opens, and `SyncHealth` asks the provider, so they are not in the table either. `Thread` is in the table: it reads the stored thread and only downloads again when the cache has evicted the message text. Streams such as `Events` and `Downloads` are not in the table.

## Message text and attachment ranking

An ordinary word query selects message text candidates within a date window and the top FTS-ranked attachment candidates separately, then merges them. The message text window is the request limit, and the attachment window is also the limit. This is bounded candidate ranking and does not guarantee a global relevance order across the whole mailbox. Boolean, exclusion and AROUND queries select candidates with the original conditions, then add attachment sources to the returned threads. Message text and subject use [FTS5 BM25](https://sqlite.org/fts5.html#the_bm25_function) `bm25(index,4,0,0,1)`: subject weight 4, message text weight 1, sender weight 0. Attachments use `bm25(derived_words)`. Both message FTS tables are external-content indexes built on the cached raw `body_text`. Visible message text exists only in semantic vector entries; there is no FTS on it that BM25 can query. Reusing the existing message FTS for candidate order avoids changing indexes or rewriting message text during a read-only search. Source classification, snippets and the exact phrase signal always use message text that went through visibility extraction, so hidden content is never a message hit signal. A more negative score is more relevant. When the word index is unfinished, or for CJK substring queries, search uses the trigram index; short terms that cannot get an FTS score keep date order.

When there are attachment text hits, each list of candidates is first sorted by BM25, then `score(m) = (w_mail + p × exact_mail)/(60+r_mail) + (1 + p × exact_attachment)/(60+r_attachment)` is computed. Ranks start at 1, exact is 0 or 1, and a missing list contributes zero. `w_mail = max(2, (60+N_mail)/60)`, where N is the number of message text candidates; the ordinary attachment weight is 1. If either list contains a consecutive multi-word phrase, the same `p = 1.5 × w_mail - 1` is added: a message text/subject exact hit weighs `w_mail + p` and an attachment exact hit weighs `1 + p`. Subject and visible message text are checked separately and are not joined into one phrase. So when both are exact phrases, mail still wins, and an exact attachment phrase can still beat scattered word hits in mail. A thread hit by both lists adds the two. Each list counts each thread once, so more pages or OCR chunks do not raise the score. Ties sort by date descending. Without attachment text hits, the original date paging order stays. Ranked desktop search loads more by enlarging the candidate window, so it does not page by the date of the last relevance row. The message text weight floor of 2 puts ordinary subject/message text hits first. Above 60 candidates the weight grows with the window, so the last message text candidate still beats the first ordinary attachment; a consecutive phrase lets an attachment pass scattered message text hits. RRF avoids comparing raw BM25 values from the two corpora, message text and attachments. The fixed ordering and hidden text regressions are in `search-snippets.test.ts`.

Snippets are generated for the bounded result window. They take words only from the visible message text of `messageModelText`, not from the provider preview or old message text chunks in the semantic index. Derived text that contains HTML also goes through visible text extraction; plain OCR/PDF extracted text is treated as an untrusted string. A snippet is about 240 UTF-16 units, cut around the first hit, and keeps long phrases whole. When the word index is unfinished, the marks follow the matching trigram/LIKE substring rules too. Fields include `source`, `messageId`, attachment name/index, plain-text `snippet` and UTF-16 `highlights`. React shows them with text nodes and `mark`; MCP and the CLI still put them inside the `untrusted_mail` wrapper. The reader expands the hit message and marks the attachment by its index, so files with the same name are not confused. The reader's existing entry points for PDF page numbers and OCR image regions stay. Ten languages got a new attachment source hint. This round did not start Electron.

The 100k fixture adds one OCR chunk to each attachment, 10,000 in all. Four kinds of fixed text with different lengths, word frequencies and word gaps actually affect BM25. `search mixed body+OCR 200` queries 200 mixed results, the desktop's first search window, with a 100 ms budget; load more still enlarges and reruns the window. `search OCR snippet` queries 50 results through the real Store and checks attachment names and mark ranges, with a 150 ms budget. Broad word searches and derived candidates exclude spam/trash through the maintained `message_search_meta.eligible`, so they do not parse label JSON twice per hit. When every subject has a visible hit, the message text window is full and there is only one word, an ordinary OCR-only hit cannot reach the result page under the weights above, so only attachment hits for threads in that window are read. Multiple words, phrases and message text short of a page still query separate attachment candidates. The FTS path computes attachment BM25 directly on the hit cursor. A thread first picks one newest matching representative message by rank, then reads its snippet and participants. Unread/starred are still aggregated over all matching messages, and the full snippet for every chunk is not read. Message scores are computed once in a materialized CTE. The cursor range is first limited by the min/max candidate rowid, then rowids are filtered with a numeric expression, so FTS does not reopen the cursor and recompute corpus statistics for each rowid. Only the result representative messages and the message text chunks whose visibility must be rechecked are read. This avoids per-row subqueries scanning the FTS set again and again. The broad word list uses CASE to first exclude replies that already have a newer match, then checks MATCH on candidate thread heads. Unread and starred come from short-circuit EXISTS on the matching messages, and both candidate lists share the thread counts and participants already fetched. Visible message text is read only for messages that actually get a snippet, and unused attachment representative messages are not read again. Complex expressions first filter derived text hits, then recheck the original conditions. Within one request, visible text results for identical message text/HTML and snippets and mark ranges for identical chunks are reused; nothing is cached across requests. Merging the hit lists for the same object also skips dedup serialization.

The mixed search profiler is [search-profile.test.ts](../packages/core/src/platform/node/search-profile.test.ts). It times each SQL statement and in-memory step, and collects the full query plans outside the timing. The main SQL dropped from 91.10 to 28.72 ms and the whole request from 157.09 to 76.52 ms. When every thread head on the first page of a common word is a hit, it skips the whole-database FTS set, and falls back when hits are missing or a cursor is used. An appended migration adds covering indexes for the participant and starred queries. The same schema decoding runs synchronously and keeps all boundary validation.

```sh
OPENMAIL_SEARCH_PROFILE=1 NODE_OPTIONS=--max-old-space-size=192 pnpm --filter @openmail/core exec vitest run src/platform/node/search-profile.test.ts
```

The profiler uses `/tmp/openmail-search-profile.db` by default and creates the real 100k fixture in an empty database. The default database is deleted after the connection closes, on success, failure and interrupt. Another test database given explicitly is kept, for comparing several rounds. It warms up twice and takes the median of seven; every SQL prepare in warm runs hits the cache. `OPENMAIL_PROFILE_DATABASE` and `OPENMAIL_PROFILE_REPORT` set the test database and the report location. Raw timings and query plans stay in the temp directory; generated reports are not committed.

## 2026-10-06 regression bisect

The bisect ran between `d0d820a` and `7438fba` and checked both sides of each candidate commit. At each point it first ran `pnpm install --frozen-lockfile` and built core, then ran a temporary budget test that kept only AROUND and long-thread model text. The environment matched `test:perf`: Node v24.21.0, `OPENMAIL_PERF=1`, `OPENMAIL_LOW_MEMORY_TESTS=1`, 192 MiB heap, 8 MiB SQLite page cache. Each point was measured three rounds in a row, each round warmed up on its own and took the median of five; query plan collection was excluded from the timing. System load was about 6–11, so small differences are not evidence of a regression.

The two endpoints and `7fbce29` each generated a full fixture. The other points copied the same 100k database from `7fbce29` after its word index finished and the WAL was truncated, then ran that commit's migrations and `ANALYZE`; these commits have the same schema before migration 37. Measurements ran serially. The table shows the medians of the three rounds, in ms.

| Commit    |            search AROUND | thread model text long chain |
| --------- | -----------------------: | ---------------------------: |
| `d0d820a` | 601.91 / 595.27 / 583.36 |     133.17 / 124.14 / 133.57 |
| `24e3b58` | 608.13 / 632.76 / 601.80 |      111.44 / 100.46 / 97.44 |
| `3dfdebe` | 601.75 / 595.70 / 592.48 |      110.89 / 100.56 / 99.45 |
| `99cd1ef` | 606.17 / 678.08 / 625.84 |     110.58 / 112.39 / 110.03 |
| `94ecc1b` | 619.26 / 658.02 / 606.88 |     362.58 / 351.04 / 351.14 |
| `7fbce29` | 650.05 / 695.32 / 681.77 |     410.73 / 388.55 / 394.73 |
| `be420e7` | 631.27 / 607.16 / 612.63 |     406.09 / 383.61 / 366.62 |
| `9ce7fbc` | 599.76 / 611.23 / 600.54 |     426.85 / 361.87 / 387.64 |
| `4ccf97d` | 634.88 / 597.96 / 593.48 |     425.29 / 406.34 / 411.03 |
| `7438fba` | 611.38 / 610.64 / 616.83 |     443.58 / 379.75 / 378.03 |

AROUND was already over 500 ms at the start point, and the actual `EXPLAIN QUERY PLAN` was identical at all ten historical points, so no commit in this range introduced the problem. Migration 37 did not change this plan, and the original indexes and migrations stay. The cost came from still materializing candidate word positions, a self-join and deduplication when the distance is zero. The fix compiles an ordered zero-distance query into one [FTS5 phrase](https://www.sqlite.org/fts5.html#fts5_phrases), and an unordered query matches the phrase in both directions. Non-zero distance still uses the original position check, and an unfinished index still takes the AND fallback. The plan tests require that zero distance does not read the word position table and that non-zero distance reads it only once.

The long-thread text regression came from `94ecc1b`: its parent `99cd1ef` took about 110 ms and it took about 351 ms. HTML5 sanitizing and visibility checks across several reference widths and media scenarios added per-message extraction cost. The fixture's 204-message long thread has only two distinct plain text/HTML pairs, yet it extracted 204 times. The fix reuses results by full plain text and HTML within one `toModelThread` call. Quote boundaries, flags and the text budget are still handled per message. There is no cross-call cache, and a thread whose messages all have different text gets no benefit from this reuse. The storage split, quote boundary changes and the visible text stage refactor showed no independent regression of similar size.

On the same snapshot, `7438fba` against the fix: each cell lists the medians of the three rounds, with that round's maximum in parentheses, in ms. Both budgets stay at 500 ms.

| Measurement                  |                                              Before |                                               After |
| ---------------------------- | --------------------------------------------------: | --------------------------------------------------: |
| search AROUND                | 611.38 (717.91) / 610.64 (710.98) / 616.83 (632.50) | 365.57 (403.08) / 371.92 (376.95) / 372.83 (380.32) |
| thread model text long chain | 443.58 (465.15) / 379.75 (428.80) / 378.03 (406.81) |       91.04 (95.74) / 89.89 (90.59) / 88.73 (88.92) |

## 2026-10-07 AROUND paging regression investigation (slice 89)

Measured `1b7a975..6c04688` in a separate worktree under `/tmp`; each commit first installed frozen dependencies and built core. The filtered measurement ran only the real Store's `listThreads({ search: '"alpha AROUND 0 beta"', limit: 50 })`, in the same environment as `test:perf`: Node v24.21.0, `OPENMAIL_PERF=1`, `OPENMAIL_LOW_MEMORY_TESTS=1`, 192 MiB heap, 8 MiB SQLite page cache. Each point ran three rounds in a row; each round warmed up once and took the median of five. The `EXPLAIN QUERY PLAN` of the actual SQL was collected separately and not counted. The 1, 5 and 15-minute loads were recorded before and after each round, and the table lists the one-minute range. Measurements ran serially.

The first fixture generated on its own for `6c04688` gave 530.17 / 512.37 / 472.33 ms at load about 9. Full fixtures were also generated at `1b7a975` and `cea6d24`, the word index finished and the WAL truncated, and snapshots saved. The migration 37 snapshot is used for earlier commits. The migration 38 snapshot contains the 10k OCR chunks added in slice 79 and is used for that commit and later ones. Each point copies a snapshot, then runs that commit's own migrations and `ANALYZE`.

The midpoint `b39a8b5` was measured first, then the three candidate commits and both sides of each. The start point was also over budget, so 500 ms could not reliably separate good from bad; no commit in this range was shown to introduce a regression.

| Commit    | AROUND medians of three rounds (ms) | One-minute load range |
| --------- | ----------------------------------: | --------------------: |
| `1b7a975` |            472.56 / 535.39 / 416.41 |            9.69–10.35 |
| `b39a8b5` |            556.33 / 482.89 / 517.36 |            9.44–10.20 |
| `3d1cd3f` |            567.97 / 566.34 / 586.03 |             7.80–7.95 |
| `cea6d24` |            648.79 / 557.77 / 512.90 |             9.27–9.46 |
| `450894d` |            650.22 / 575.99 / 529.56 |             9.04–9.59 |
| `81b69ee` |            471.47 / 531.91 / 520.67 |             8.21–8.34 |
| `6c04688` |            519.87 / 576.53 / 616.87 |             7.41–7.65 |

At every point the main AROUND query materialized all matching messages, then grouped by thread, built an automatic index and sorted, and only then took 50 results. That path began in `6fab95b` and moved into `store-threads.ts` in `7fbce29`. `1b7a975` compiled zero distance into an FTS phrase but kept this whole-database aggregation path. Migration 38 in slice 79 only switched the participant subquery to a covering index; the new snippets and ranking together took under 10 ms in a separate profile. The category filter in slice 86 does not apply to this search, which has no category condition, and migration 39 only resets Outlook sync state. The badge query in slice 88 is not in the filtered measurement, and the write triggers of migration 40 do not run in read-only queries. Round-to-round variation was larger than any stable difference between candidate commits, and the load data is not enough to attribute it on its own.

The fix makes zero-distance AROUND use the existing date paging path: FTS verifies the phrase, the index excludes older matches in the same thread, and snippets and participants are read only after a bounded result page is found. Later optimization for non-zero distance is in the next section. The plan assertions require that zero distance uses the global date and thread date indexes, materializes only `page`, and has no `MATERIALIZE matches`, word position reads or GROUP BY temporary sort; the old implementation made the assertion fail. Behavior tests cover ordered/unordered phrases, distances with leading zeros, same-day ID paging, newer non-matching replies, and unread/starred aggregation over matching messages.

The comparison below uses the same migration 38 snapshot and runs the original implementation, then the fix, on the same `6c04688` code. Each cell is the median of three rounds, with that round's maximum in parentheses, in ms. The budget is still 500 ms and the target is at most 400 ms.

| Implementation |            AROUND medians of three rounds (maximum) | One-minute load range |
| -------------- | --------------------------------------------------: | --------------------: |
| Before         | 588.83 (683.79) / 552.89 (643.73) / 516.34 (829.30) |             8.35–8.79 |
| After          |       87.25 (88.37) / 86.68 (90.08) / 86.19 (87.29) |             7.84–7.84 |

A separate step-by-step profile gave a total median of 455.22 → 89.74 ms and main SQL of 445.19 → 79.55 ms; snippets and ranking showed no change of similar size. Results keep date and ID order, flag aggregation over matching messages and attachment hit semantics. Budgets, migrations and indexes were not changed.

## Non-zero-distance AROUND paging

Slice 90 adds `search AROUND 3`, which calls `listThreads({ search: "alpha AROUND 3 beta", limit: 50 })`. The words come from the 100k fixture's message text. It first takes an unsearched window of at most 50 threads or messages by the date index. FTS NEAR and the position check handle only this window. The exact position check and unread/starred aggregation materialize only the window's messages. The word position virtual table still reads the instance stream by term, but keeps only positions within the window. The FTS range uses `(rowid+0) IN (...)`, so the MATCH cursor is not reopened for each candidate message. When the first window has no exact hit or still cannot settle the whole page, the partial result is discarded and the old whole-database path runs once with the original query and cursor. This limit also bounds the prefix replay of deep-page cursors. Counts keep the whole-database path.

NEAR can hit newer replies whose order or overlap does not fit, so the exact thread head may be older. Paging keeps these threads and stops when the next candidate head is older than the tail of the current result page; the caller's cursor applies after exact heads are resolved. A negated AROUND branch cannot directly negate the NEAR superset, so it is left to the exact check within the window. When the index is not ready it still takes the original AND fallback and does not write the index. `around-pages.test.ts` uses three random seeds and compares against a reference implementation that scans the fixture text directly, without calling the Store's SQL condition generator. It covers ordered/unordered, phrases, repeated words, boolean combinations, chunking, four index readiness states, account and folder scope, matching heads, flags, Unicode ID ties and cursors. `performance-plans.test.ts` checks the candidate date index, message ID lookup within the window and the shared MATCH cursor.

On 2026-10-07, the thread query of `71c9c0c` and the fixed version were compared serially on the same temporary 100k fixture. Node v24.21.0, default Node heap limit, 8 MiB SQLite page cache; the official budget suite still uses the 192 MiB heap limit. Each round warmed up once and took the median of five warm runs; query plans and fixture generation were not timed. Load was read at the end of each round, in the order 1/5/15 minutes.

| Implementation | Round | Median ms | Load average            |
| -------------- | ----: | --------: | ----------------------- |
| Before         |     1 |    851.98 | 21.93 / 124.83 / 211.39 |
| Before         |     2 |    889.21 | 20.25 / 121.08 / 209.05 |
| Before         |     3 |    871.82 | 20.63 / 119.48 / 207.97 |
| After          |     1 |    236.60 | 20.52 / 96.09 / 191.09  |
| After          |     2 |    250.16 | 20.52 / 96.09 / 191.09  |
| After          |     3 |    215.47 | 20.52 / 96.09 / 191.09  |

Extra 20k and 100k sparse fixtures have one thread per message. Except for three messages, the message text is `beta one alpha`; the three are `alpha one beta`. The NEAR prefilter of ordered `"alpha AROUND 2 beta"` hits the whole database, while only three messages match exactly. The budget suite checks a 500 ms limit for thread, message and negated queries, and a 1500 ms limit for a page-40 cursor. Results are written to `/tmp/openmail-around-sparse-performance.json`; `OPENMAIL_SPARSE_PERF_REPORT` changes the path. The 20k report is saved at that path plus `.20000.json`. The default tests use a 5000-message version and assert that the candidate window actually runs at most once, and check the three results and the deep-page results. This count assertion avoids depending only on latency under machine load.

An added comparison for the fallback when the first window has no hit uses the old thread query from `44ca8ff`. Both implementations share the same temporary SQLite connection and fixture, a 192 MiB Node heap and an 8 MiB SQLite cache. After warmup, new and old queries ran alternately 15 times each, and the median was taken; each case first compared the full returned objects. For an ASCII window of a simple AROUND with no derived chunks, the same word boundaries as unicode61 can exclude the whole window, which saves an extra instance stream scan. Unicode, derived chunks, boolean combinations and unfinished indexes keep the SQLite check. When all candidates of single-message threads fall in the cursor's excluded range, it falls back directly. Spam eligibility reads `message_search_meta.eligible`, which triggers already maintain. The original query and cursor stay unchanged.

| Size | Case        | Old path ms | New path ms | Load 1/5/15 min       |
| ---: | ----------- | ----------: | ----------: | --------------------- |
|  20k | sparse      |       51.64 |       46.04 | 17.24 / 21.76 / 29.96 |
|  20k | sparse flat |       52.59 |       46.23 | 16.42 / 21.52 / 29.83 |
|  20k | negated     |       55.78 |       50.41 | 16.42 / 21.52 / 29.83 |
|  20k | deep        |      125.94 |      122.68 | 16.39 / 21.43 / 29.75 |
| 100k | sparse      |      301.15 |      267.33 | 15.18 / 21.00 / 29.50 |
| 100k | sparse flat |      292.80 |      259.05 | 14.15 / 20.59 / 29.25 |
| 100k | negated     |      321.75 |      294.79 | 16.18 / 20.71 / 29.14 |
| 100k | deep        |      759.10 |      705.08 | 19.49 / 21.00 / 29.00 |

The new path's median is below the old path's in every case.

The median of three rounds dropped from 871.82 ms to 236.60 ms. The budget is set to 475 ms, about twice the fixed median and below the 500 ms limit. An earlier baseline round measured 3121.36 ms at load 191.77 / 184.53 / 183.37; that round is not used as a same-load comparison. The full measurement still uses `pnpm test:perf`; to reproduce only this item:

```sh
OPENMAIL_PERF_MEASURE="search AROUND 3" OPENMAIL_PERF_REPORT=/tmp/openmail-around3.json pnpm test:perf
```

## Main thread blocking during sync (slice 97)

Cause: in the first 60 s of a real Outlook first sync (3,787 HTML messages), the main process blocked for up to 670 ms. Provider parsing called `htmlToText` on the main thread, 37.9 s in total. Each write transaction held 200 changes and ran in one go on the main thread; on the real database, at 100 messages per transaction, CPU time peaked at 509 ms.

Fix: HTML extraction goes through the `HtmlText` service, which on Node uses a worker pool (see the [platform inventory](platform-inventory.md)). For 3,799 messages from the real database the output is byte-for-byte the same as on the current thread. `WRITE_BATCH` drops to 20 changes, and the event loop yields between transactions; at 10 messages per transaction CPU time peaks at 104 ms. Batch boundaries were already cut by time, and the cursor is still committed only together with all earlier changes.

`sync-performance.test.ts` (`test:perf`) syncs 2,000 HTML messages through the Node worker pool into an on-disk WAL database. It asserts p99 blocking under 50 ms and the longest block under 300 ms, and when load is below the CPU count it also requires no block over 50 ms. Median of three rounds (2026-10-08, serial, one-minute load 36–52; before the fix means extraction on the current thread plus 200-change batches):

| Implementation | Sync time s | Longest block ms | p99 block ms | Blocks over 50 ms |
| -------------- | ----------: | ---------------: | -----------: | ----------------: |
| Before         |        37.1 |              527 |          387 |               241 |
| After          |        17.3 |               48 |          7.8 |                 0 |

## Write and disk cost

```sh
pnpm --filter @openmail/core build
OPENMAIL_PERF=1 OPENMAIL_PERF_BASELINE_REF=dfe3a46 pnpm perf:cost
```

The script writes the same 100k-message snapshot through the real Store and compares the historical schema with the current indexes. The production settings are WAL, FULL synchronous, automatic checkpoint at 1000 pages, and an 8 MiB WAL retention limit and page cache. Writes take the median of five warm runs, and the timing includes the commit; an unchanged upsert must satisfy `total_changes()=0`. It fails when writes regress by more than 25% or DB+WAL grows more than 15% at the same stage. Space records DB+WAL both after commit and after truncate.

## Conditions and reproduction

The synthetic database runs the real migrations and writes, through `Store.upsertMessage`, 150,000 messages, 3 accounts, 50,001 threads, 20 custom labels, 3,000 company/contact snapshots and 15,000 attachment metadata items. It includes two FTS indexes, correspondent and server contact candidates, 1,000 invitation responses, 1,500 invitation history entries and reminders. Message text and HTML are about 1 KiB. SQLite page cache is 8 MiB and the Node heap limit is 192 MiB.

The SQL baseline is main `1434a8b`, including migration 26. Reads take the median of five warm runs, writes the median of three; the full cache clear is measured once. Query plans come from the real Store SQL, are collected separately and are not counted in read or write times.

```sh
pnpm --filter @openmail/core build
OPENMAIL_LOW_MEMORY_TESTS=1 OPENMAIL_PERF_BASELINE_REF=1434a8b node --expose-gc --max-old-space-size=192 packages/core/scripts/performance.mjs /tmp/openmail-before.json
OPENMAIL_LOW_MEMORY_TESTS=1 node --expose-gc --max-old-space-size=192 packages/core/scripts/performance.mjs /tmp/openmail-after.json
OPENMAIL_LOW_MEMORY_TESTS=1 node --expose-gc packages/core/scripts/sync-memory.mjs
OPENMAIL_LOW_MEMORY_TESTS=1 node --expose-gc packages/core/scripts/idle-memory.mjs
```

The JSON report contains the actual SQL and `EXPLAIN QUERY PLAN`. The scripts clean up the temporary database when they finish.

## Memory and startup

IMAP parses message by message through the ImapFlow iterator with controlled consumption speed. A batch keeps metadata and message text and does not accumulate all raw MIME and attachment bytes. The memory harness runs GC between simulated responses to tell retained objects apart from GC scheduling. Outlook keeps one 50-message delta page, six concurrent conversions and at most 16 events at a time; across pages it keeps only IDs. Regressions cover ordering, move taking precedence over delete, and the final checkpoint. If any page or restart fails, the old cache is not cleared. core commits at most 200 events per batch.

The spelling menu's Set removes its listeners and closures when the window closes. Raw MIME and thread queries have an idle TTL of zero and are released after the reader unmounts; inline and derived images stay for two minutes. The in-memory attachment LRU is capped at 16 MiB and eight messages, and the attachment tree is managed per request. The persistent on-disk attachment cache is a separate layer; its size and cleanup are in the [release notes](release.md#old-mail-and-cache).

Migrations and recovery checks finish before core is ready. The Vision version check, search backfill, media/semantic batches and the first automatic sync start after any window's `ready-to-show`. Node tests verify that a second window can still release the wait after the first window closes, and that listeners are cleaned up. Electron measurements are in the next section. The in-process snapshot and cleanup limits for Apple Contacts are in [Apple Contacts](apple-contacts.md), and the general verification entry points are in [testing](testing.md).

### Desktop cold start and memory measurements (slice 102)

A read-only copy of a real mailbox: 4,065 messages, 2 accounts, a 238 MB database. The launch command is `OPENMAIL_READ_ONLY=1 electron-vite preview`. Builds before and after the change were cold-started alternately, 7 times each, taking the median, at system load 8–12. The baseline is `fc49dd3`. Times count from the start of the Electron main process, in ms. Temporary performance marks and RPC logs in the main process and renderer were added only for measurement and are not committed. An unpackaged launch does one extra Dock icon setup of about 70 ms, included in both groups.

| Metric                              |  Before |   After |
| ----------------------------------- | ------: | ------: |
| main process module evaluation done |     479 |     456 |
| main window `ready-to-show`         |     944 |     852 |
| renderer start to entry script done |     211 |     130 |
| first list rows painted             |    1098 |    1009 |
| `Threads` requests at startup       |       3 |       1 |
| `Labels` RPC                        |   44–56 |       4 |
| renderer entry chunk (uncompressed) | 4.20 MB | 4.01 MB |

The changes:

- The Outlook category query in `listLabels` used to scan every message row through `messages_body_sizes`, and reading `labels_json` meant stepping over the body overflow pages. The query now uses the covering index `messages_thread_labels` (`messages_thread_state` from migration 46, user_version 46), and its time dropped from 58 ms to 2 ms. It runs before the first screen, main-thread SQLite is serial, and later RPCs used to queue behind it. One cold start measured 1.4 s. `performance-plans.test.ts` asserts this plan.
- During a first sync of 2,000 HTML Outlook messages, the longest event loop block was between 62 ms and 1.27 s (5 runs, load 11–14). The blocks came from two synchronous SQL statements: the reset candidate query read `labels_json` and `rfc_message_id`, and the sync health check read `labels_json` and `is_unread`. These columns come after the body columns, so reading them per row walks every message's body overflow pages, and one query took up to 1.27 s with a cold cache. Migration 46 (user_version 46) moves the sync health check and `listLabels` to the covering index `messages_thread_state`, and adds `provider_id` to `messages_account_date`. Reset candidates are first listed from the index, and only real candidates read the full row. After the change the longest block over 5 runs was 25–61 ms and the p95 event loop delay 2.6–3.2 ms. These numbers were measured at load 33–43 (16 cores); the test report is in `sync-performance.test.ts`.
- Sync write transactions used to hold up to 20 changes each. 20 HTML messages of about 105 KB, plus the FTS and `search_flags` triggers, were written in one commit, and under high load a single block exceeded 50 ms. `mailbox-sync.ts` now also splits by body size, about 200 KB of body per transaction, with `Effect.yieldNow` between transactions. After the change, 3 runs of `pnpm test:perf` gave longest blocks of 33, 19 and 29 ms, p99 of 9.1, 8.2 and 7.8 ms, and no blocks over 50 ms, at 1-minute load 8.4, 10.8 and 9.3 (16 cores). The `blocksOver50Ms` assertion applies only when the 1-minute load is below half the core count.
- `pagedList` used to return a wrapper object from `Atom.family`. The family holds its members only weakly, so after GC collected the wrapper, the next read created a new list atom and requested from the first page again. Startup therefore sent three identical `Threads` requests. The old atom kept its loaded pages for the 5-minute idle TTL. Now each family returns the atom directly, and `threads-paging.test.ts` checks after GC that a mounted list does not change.
- The GitHub provider of `electron-updater` now loads on the first update check. The main process loads about 1,100 ES modules at startup. Node compile cache once made module evaluation about 70 ms earlier, but it is not enabled for security reasons; see the [security notes](security.md).
- The `openmail-app` protocol turns on `codeCache`. Chromium generates a bytecode cache for the entry script on the second load, and uses it from the third launch on. The first two launches of a new build still take about 211 ms.
- core declares `"sideEffects": false`. ical.js runs code on import and used to be bundled into the renderer through the schema entry. `bundle-split.test.ts` checks the build output: the entry contains neither ical.js nor the language catalogs, and on-demand pages each get their own chunk.

In the main process CPU profile before the change, about 680 ms before `ready` went to ESM loading, compiling and instantiation; BrowserWindow creation took about 100 ms, in native code. After the change, the critical path to the first list rows is mainly the renderer's first render, about 150 ms, and the main process answers startup RPCs within 10 ms. With minification on, the renderer entry is 1.97 MB, but with a bytecode cache there is no measurable startup difference, so it is not enabled.

Memory was measured after 2 minutes idle following startup, then while opening threads in turn. The JS heap is read after GC, RSS comes from `ps`, in MB. Before and after were measured alternately twice each, with baseline `d5dd012`; the ranges were the same, so they are listed together:

| Point              | Main RSS | Main heap | Renderer RSS | Renderer heap |
| ------------------ | -------: | --------: | -----------: | ------------: |
| idle 2 minutes     |  288–293 |     44–46 |      185–223 |         15–19 |
| 20 threads opened  |  299–311 |     46–51 |      281–296 |         20–26 |
| 60 threads opened  |  305–309 |     47–48 |      327–337 |         21–23 |
| idle another 150 s |  306–310 |     47–48 |      329–335 |         21–22 |

Before the change there were 4 more measurements with temporary logging. In 2 of them the renderer heap reached 40–50 MB after 20 to 60 threads and did not drop back when idle, which fits the duplicate list atoms triggered by GC timing. After the change it stayed at or below 26 MB in all 3 runs. Before the change, 2 runs also had renderer RSS reach 0.9 GB while the JS heap stayed at 23–29 MB; the cause was not found, and it did not occur after the change.

DOM nodes, document count and event listeners do not grow after opening 40 threads. Renderer RSS rises with the threads opened, and the growth is not in the JS heap; it likely comes from Blink layout and image decoding. `messageBackgroundAtom` and `imagesLoadedAtom` used to keep one entry per message or thread ever opened, until the window closed; slice 105 added a cap.

### Main process lazy loading and reader chunk split (slice 105)

Same method as the previous section: the same read-only copy of the real mailbox (made with `.backup`, then upgraded by the current migrations), builds before and after cold-started alternately 7 times each, median, system load 9–28. The baseline is `6315d39`. Module counts come from `Debugger.scriptParsed` under `--inspect-brk`, counted up to `ready-to-show`. Times in ms.

| Metric                                    |  Before |   After |
| ----------------------------------------- | ------: | ------: |
| main process ES modules (to window ready) |   1,069 |     796 |
| main process module evaluation done       |     465 |     389 |
| main window `ready-to-show`               |     867 |     761 |
| renderer start to entry script done       |     132 |     113 |
| first list rows painted                   |    1020 |     927 |
| renderer entry chunk (uncompressed)       | 4.01 MB | 2.99 MB |

- core loads imapflow, nodemailer (SMTP and MailComposer), mailparser and `@effect/ai-anthropic` on first use. A failed dynamic import maps to the original operation's error: a `failure()` ProviderError for IMAP connections and the SMTP transport, PermanentError for MIME builds, “Cannot parse MIME message” for parsing, and the existing ProviderError for AI requests. semver is now imported by function subpath, down from 47 modules to 10. PDF and model inference were already in workers. markdown-it (about 70 modules, about 18 ms to import on its own) still loads at startup: `renderMarkdown` and the draft fingerprint are synchronous portable interfaces, and making them async would change draft parsing and the send path.
- The renderer's `MessageBody` chunk contains the body, the remote image prompt, tracker badges and quote folding. Before the chunk loads, it shows a placeholder box the same as the EmailFrame initial height (120 px). Deciding on remote content needs the parser, so the prompt appears after the chunk loads. The iframe sandbox and CSP did not change. If the chunk fails to load, the body area shows “Couldn't load this message.” and Retry; the failure is not cached, and Retry imports again. Messages embedded in attachments and import previews use the same chunk through `LazyEmailFrame`. Compose code in the entry loads `draft.ts` dynamically through `draft-loader.ts`. `applyComposeSignature` moved from `signatures.ts` to `compose-body.ts`: the RPC definitions refer to the signature schema, which used to pull the whole sanitizing code into the entry. `bundle-split.test.ts` asserts that the entry contains neither `sanitizeReaderHtml` nor DOMPurify.
- The values of `messageBackgroundAtom` and `imagesLoadedAtom` live in a kept-alive Map that keeps 200 messages and 100 threads respectively, in most-recently-set order. Family members only derive from it and no longer stay resident. The main window opens one thread at a time, so the open thread's decisions are not pushed out unless the background is toggled for more than 200 separate messages within that thread. `state/ui.test.ts` covers retention, eviction and refresh order.

## Renderer build

Settings, compose, the editor, calendar, raw message, feedback, accounts and proposal approval load on demand. After `pnpm build`, check the chunk sizes in `apps/desktop/out/renderer`. The initial entry contains Effect 0.86 MB, react-dom 0.65 MB and Base UI 0.61 MB. The message body, EmailFrame, DOMPurify, and core's HTML sanitizing and visible text code (parse5, css-tree, entities) are in `MessageBody` and shared chunks; see the next section. tldts (about 0.18 MB) is still in the entry, because the sender spoofing hint in message headers and link confirmation use it.

The AROUND regression is in `performance-store.test.ts`: 5000 messages finish the background word index first, then run an ordered count, an unordered count and a list query, and the three queries together must take under 3 seconds. Candidates are prefiltered with [FTS5 NEAR](https://sqlite.org/fts5.html#fts5_near_queries), and the word position CTE reads only once per query. When the index is not ready, the request runs only the AND fallback and does not write or backfill the index. This is an automated regression ceiling, not a guarantee of on-device UI latency.

## Local cache management (T07)

The message text budget and the “Keep OpenMail under” limit are off by default. Total storage is `page_count × page_size + WAL + attachment files + recovery copies`; free pages are already inside the database and are not added twice. The UI shows message text, attachments, indexes and other data, free pages, WAL and recovery copies separately. Message text is the UTF-8 logical payload; indexes and other data are estimated as used pages minus message text. Node queries `statfs.bavail` of the volume holding the actual database path, and counts `.corrupt-*`, `.recovery-*` and their WAL files. It skips symbolic links and counts hard links to the same inode once. Recovery copies are kept and are not deleted automatically for the budget.

The effective message text budget is the smaller of the manual budget and the adaptive budget. The adaptive budget is the current message text size minus the larger of the total-storage excess and the disk space shortfall, less reusable pages already present, with a floor of zero. When free space is below `min(5 GiB, volume capacity × 10%)` and incremental reclaim is on, it tightens even with both manual budgets off, and shows a notice. An old database without reclaim does not keep evicting text for low disk; the notice asks for a manual compaction first. A new database turns on incremental mode before creating tables. Starred mail, mail within the retention window, permanently kept labels, drafts and the outbox are still exempt, so the target may not be reachable. The first background check runs one minute after the window is ready, then every hour or when the budget changes. When space is short it bypasses the hourly gate of the text budget. If sync or flush holds the lock, that check is skipped and the next hourly check retries.

Migration 37 fixes the hidden rowid of messages, contact_candidates and contact_organizations as an `INTEGER PRIMARY KEY` with the same value. It keeps the existing indexes, triggers and dependent rows, and does not run VACUUM. core, op-sqlite, smoke, recovery and the current-schema test helpers share the migration foreign key wrapper: it turns foreign keys off before the rebuild transaction, checks foreign key integrity before commit, and restores the original foreign key setting on exit. New messages are still written through `upsertMessage`.

“Compact now” takes the sync and flush mutex permits, then holds the SQL connection exclusively and upgrades the access lock; an idle shared lock from the CLI/MCP also returns busy. A separate Node worker runs VACUUM, incremental reclaim and the checks on its own DatabaseSync connection; the main process only waits for the result, and the UI keeps showing an in-progress state. It also probes for unregistered SQLite writers with BEGIN IMMEDIATE, and SQLITE_BUSY/LOCKED also return busy. Sync, flush, read-only sessions, tables whose rowid cannot be guaranteed and misaligned FTS content are all refused. The first time, after checking disk staging space and a complete FTS index, it runs `auto_vacuum=INCREMENTAL` and one full VACUUM; later runs only run `incremental_vacuum`. The UI shows progress and the result. After automatic eviction, and in hourly checks where free pages reach 1 MiB or WAL reaches 8 MiB, it reclaims all free pages by the actual freelist and runs `wal_checkpoint(TRUNCATE)`, but only when incremental mode is already on; it never runs the first full VACUUM automatically. Free pages from before the first compaction still take file space, so the target may need a manual compaction to reach.

`platform/node/cache-management.test.ts` covers measurement, low-disk LRU and every exemption, migration of sparse rowids in old databases, FTS search and dependent rows before and after compaction, the sync/flush mutex, and refusal for read-only and unsafe rowids. The phone's default CacheStorage adapter returns empty disk statistics and zero WAL/recovery copy bytes, and does not tighten for low disk; see the [mobile notes](../apps/mobile/README.md). Electron was not started and on-device compaction time was not measured. Total storage reads `body_cache_budget.total_bytes`. The UI refreshes every minute or on window focus, and thread changes do not trigger a directory scan. Byte counts use each language's Intl long unit plural format, with GB as its own unit.

The migration 37 measurement first builds a schema 36 database, then writes the 100k fixture's messages and 10,000 OCR chunks with SQL that has only schema 36 columns. The current Store queries columns added later, so it does not go through the Store; the schema 36 triggers fill FTS, the word table, search metadata and contact candidates as usual. Message rowids are `3i + 7`, with gaps. The test then runs migration 37 and every later migration in order, times only migration 37, and checks that rowids are unchanged, foreign keys are intact and FTS integrity-check passes. The time must be under 12,000 ms × `OPENMAIL_PERF_FACTOR` × max(1, calibration ratio). On 2026-10-16 it ran twice on a 16-core Mac at one-minute load 4.7–11: 3,407.6 ms (calibration ratio 0.87) and 4,368.7 ms (calibration ratio 0.96), with a logical database of 580,440,064 bytes before the upgrade, Node v24.21.0, 8 MiB page cache and FULL synchronous. When a SQL step costing about 12 s more was added to migration 37, the test failed the budget; when messages were copied without rowids, the rowid check failed. This rebuild also moved to a worker. Before starting the worker, the desktop app draws an “Upgrading local database…” window and closes it on completion or failure. The `window-all-closed` keep-alive listener during the upgrade stays until DesktopLive registers the normal shutdown logic and creates the main window, so closing the upgrade window by hand does not quit or cancel the migration. If the WAL truncate after a committed upgrade is delayed because a read transaction is busy, it only logs a warning and continues startup without repeating the migration. The preflight requires free space on the data volume of at least the database's logical size; if not met, it does not rebuild and asks the user to free space. The worker checks once more, in case space changed after the preflight. The phone's op-sqlite uses the same foreign key wrapper and native async SQL, but has no volume space preflight or full VACUUM worker; a full compaction explicitly returns unavailable.

```sh
OPENMAIL_PERF=1 OPENMAIL_LOW_MEMORY_TESTS=1 pnpm --filter @openmail/core exec vitest run src/platform/node/migration37-performance.test.ts
# The report defaults to /tmp/openmail-migration37-performance.json; set OPENMAIL_MIGRATION_REPORT to change it.
```

Regression tests for these fixes cover FK-on smoke and phone upgrades keeping dependent tables, repeated pressure checks deducting free pages, no further deletion when reclaim is off, the worker refusing to run VACUUM on the caller's thread, heartbeat responses, a real child-process CLI shared lock, a direct SQLite writer, an upgrade with too little space keeping the database bytes, and byte plurals in ten languages.

Account scope in single-account search: the `recent` CTE of the thread fast path used to test the account only inside CASE, so a single-account search scanned every account in `messages_account_list_date_id` and ran CASE on every row, and its time grew with the whole database. Now `WHERE` puts `accountScope(…, "m.account_id")` first, then the CASE. On a 100k database the reviewer measured `from:nobody weekly` on a 100-message account dropping from 111 ms to 0.6 ms, and `is:unread weekly` on a large account from 131 ms to 8 ms. [search-account-scope-plans.test.ts](../packages/core/src/store/search-account-scope-plans.test.ts) in the default suite checks the single-account thread page's `recent` and the flat page's statement: the account filter comes before the first CASE, and the plan is `messages_account_list_date_id (account_id=?`. Removing the fix, removing the outer `accountScope` in `messagePage`, or setting `labelWalk` to `true` each makes it fail. `performance-large.test.ts` adds `search one account from: no match and common word` (200 ms), `search one account from: and common word` (200 ms), `search one account is:unread and common word` (200 ms) and `search one account common word` (150 ms), on the fixture's 33k-message gmail account. Medians from one `OPENMAIL_PERF=1` run each on 2026-10-17 were 103, 98, 126 and 88 ms before the fix and 48, 22, 30 and 33 ms after.
