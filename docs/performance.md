# Performance

Measured on this Mac with Node v24.21.0 and `node:sqlite`. No Electron, dev app, packaged app, model download or real account was started.

The scratch database uses real migrations and `Store.upsertMessage`: 150,000 messages, 3 accounts, 50,001 conversations, 20 custom labels, 3,000 company/contact snapshots, 15,000 attachment descriptors, both FTS indexes, incoming/sent/server contact candidates, 1,000 invite responses, 1,500 cached invite revisions, and reminders. Bodies contain about 1 KiB of synthetic text/HTML. SQLite page cache: 8 MiB; Node heap limit: 192 MiB. SQL baseline: main `1434a8b` with migration 26. Reads use five warm runs, writes three; the table reports medians in milliseconds. Plans come from the actual Store statements, captured separately from read/write timing. Full cache eviction is one timed run with plan capture.

```sh
pnpm --filter @openmail/core build
OPENMAIL_LOW_MEMORY_TESTS=1 OPENMAIL_PERF_BASELINE_REF=1434a8b node --expose-gc --max-old-space-size=192 packages/core/scripts/performance.mjs /tmp/openmail-before.json
OPENMAIL_LOW_MEMORY_TESTS=1 node --expose-gc --max-old-space-size=192 packages/core/scripts/performance.mjs /tmp/openmail-after.json
OPENMAIL_LOW_MEMORY_TESTS=1 node --expose-gc packages/core/scripts/sync-memory.mjs
OPENMAIL_LOW_MEMORY_TESTS=1 node --expose-gc packages/core/scripts/idle-memory.mjs
```

The JSON reports contain every SQL statement and `EXPLAIN QUERY PLAN`. The historical runner skips broad FTS cases because they can stall for minutes. The common-word lower bound was measured before the targeted FTS fix, with earlier indexes already present; that query was stopped after more than three minutes. Common result-count and company baselines are intermediate pre-fix measurements; invitation-cache/trigram-common baselines are N/A. Temporary databases are removed on completion. Historical SQL modules are compiled from git without changing the checkout.

| Path                   |         Before ms | After ms |
| ---------------------- | ----------------: | -------: |
| label first page       |              3.99 |     4.32 |
| label next page        |              3.99 |     4.03 |
| label unread           |              1.64 |     1.77 |
| label flat             |              1.39 |     1.06 |
| inbox first page       |            395.29 |     1.24 |
| thread count           |            185.83 |    24.33 |
| unread account badges  |            230.70 |    12.43 |
| unread label badges    |            167.35 |    18.59 |
| inbox label badges     |            157.55 |    14.32 |
| FTS trigram            |              3.07 |     8.69 |
| word search            |              2.93 |     5.89 |
| word search common     | >180000 (timeout) |     6.18 |
| search count common    |            186.88 |    41.94 |
| FTS trigram common     |               N/A |    25.00 |
| Gmail operators        |             21.48 |    18.20 |
| contacts prefix        |             35.32 |    25.99 |
| contacts empty         |            100.87 |    30.57 |
| contacts company       |             81.63 |    19.10 |
| sender history         |              0.08 |     0.08 |
| invite lookup          |             67.66 |     0.01 |
| reminder scan          |              0.02 |     0.01 |
| invite response lookup |              0.01 |     0.01 |
| cached invite history  |               N/A |     0.40 |
| invite siblings        |               N/A |     0.03 |
| cache candidates       |             66.50 |     0.13 |
| rule backfill page     |              0.87 |     0.60 |
| cache eviction scan    |              0.14 |     0.09 |
| label change           |             16.93 |    19.87 |
| sync 1000 new          |            326.11 |   381.33 |
| sync 1000 re-upsert    |            109.06 |    28.03 |
| full cache eviction    |           9680.99 |  1461.93 |

Every measured UI read is below 50 ms. Sync batches and eviction run in the background. Label changes toggle one label on 100 messages; sync measures 1,000 new messages and 1,000 unchanged re-upserts. Eviction scans in 200-row pages and clears 1,364 expired bodies.

Migration 30 follows the coordinator’s allocation. Main includes migrations 27, 28 and 29; there are no placeholders. Covering indexes avoid fetching bodies for counts, suggestions and provider-ID lookups; the trimmed RFC ID has its own index. The multi-account list walks the global date/id index instead of sorting the entire inbox. Trigger-maintained badge/search projections remove repeated JSON expansion and MIME-body reads from counts. FTS checks inside a thread now probe its rowids instead of iterating the whole hit set; a bounded 2,049-hit probe chooses date-first paging for common terms. Company completion uses one combined name/address/company FTS document with prefix indexes, preserving mixed-token matches and account ownership. Its contentless-delete index avoids duplicating original strings. [SQLite FTS5 reference](https://sqlite.org/fts5.html#contentless_delete_tables). Local-draft badges now count rows without decoding draft bodies or attachments. Identical upserts execute no UPDATE, preserving rowids and FTS indexes.

Remaining plan scans are bounded or necessary: date-index walks stop at the page limit; exact badge/contact counts scan their compact projections; FTS enumerates matching rowids. Participant sorts cover the few messages in each of 50 selected conversations. Badge totals sort only label/account groups; contact ranking sorts distinct addresses. Small account/pref/progress tables also scan. No UI query sorts the full messages table.

Migration 30 drops the superseded account/thread and untrimmed RFC indexes. Query-plan tests cover unread counts, thread labels, provider IDs, trimmed RFC IDs and pending operations. Concurrent openers retry migration lock contention for up to 120 seconds, while ordinary SQL keeps the five-second busy timeout; a two-process regression holds the migration lock beyond five seconds.

The populated upgrade took 2.26 s once. Database plus WAL grew from 578.7 to 677.6 MiB. New inserts cost 17% more because indexes and projections are maintained; repeated sync becomes cheaper. These are warm synthetic measurements, not cold-disk or live-network latency.

## Memory and startup

| Measurement                                                             |    Before |    After |
| ----------------------------------------------------------------------- | --------: | -------: |
| IMAP batch, 25 messages with 4 MiB attachments, peak extra ArrayBuffers | 178.7 MiB | 28.0 MiB |
| Closed-window spelling cleanup closures after 1,000 windows             |     1,000 |        0 |
| Visible list rows rendered on a selection change                        |        12 |        2 |

IMAP now parses sources through ImapFlow’s iterator with backpressure; the batch keeps message metadata/text, not all raw MIME and attachment buffers. The memory harness uses GC between simulated responses to distinguish retained buffers from collector scheduling. Outlook keeps one 50-message delta page, six concurrent conversions, and a 16-event queue; only message IDs survive across pages. Regression tests cover ordered upserts, move-wins deletion and final checkpoints. Reset cleanup waits for all pages to succeed, preserving cached mail when any delta page or restart fails. Core still commits at most 200 events per sync batch.

Three local, non-TLS IDLE connections used 779 KiB extra heap. After 100/200/300 connect-close cycles, retained heap was 1,815/1,734/1,831 KiB, with zero sockets and zero message-event listeners left. This plateau includes library initialization; TLS/server memory is outside the measurement.

Window maps, notification sets, drag slots, update listeners, RPC clients and timers were audited for close/finalizer cleanup. The spelling-menu array retained every closed window; a Set now removes each listener and closure on close. Raw MIME and thread bodies have zero idle TTL, releasing content when their reader/dialog unmounts. Inline images and derived images stay cached for two minutes to avoid refetching during reader remounts. Attachment LRU remains bounded at 16 MiB and eight messages; attachment trees are request-scoped.

Mandatory schema migrations and recovery checks run before core becomes available. Vision revision probing, search backfill, media/semantic batches and initial auto-sync now wait for any current or future window’s `ready-to-show`; vision getters retain the loaded revision. Node tests verify that startup waits for this event, a second window releases the gate after the first closes, and listeners are removed. Actual Electron first-paint/RSS timing was deliberately not measured. The React list test uses a Node DOM and real row renders; reader state/selection lifecycle tests cover cached-content changes.

## Renderer chunks

Initial renderer build: 3,301.19 kB JS in one entry, 714.56 kB gzip, before rebasing onto the AI slice. The rebuilt renderer also includes that slice and slice 30’s lazy language catalogs; their savings are included in the entry size. Settings, composer/editor, invite/calendar, raw source, feedback, account setup, profile editing and proposal review now load through local Suspense boundaries. Hooks, styles and action names moved out of settings modules to keep imports from pulling settings into mail. The small AI shortcut/summary controller stays eager so its keyboard shortcut works; its settings and proposal dialog are lazy. Markdown rendering is in core; there is no renderer chart or markdown library to split.

| Chunk             |      kB | gzip kB |
| ----------------- | ------: | ------: |
| index             | 2673.53 |  573.55 |
| Settings          |  223.19 |   42.73 |
| Composer          |  107.14 |   23.89 |
| ComposeEditor     |   95.24 |   22.63 |
| catalog (ru)      |   86.08 |   24.98 |
| ServerSettings    |   77.39 |   15.65 |
| catalog (ja)      |   66.90 |   22.52 |
| catalog (fr)      |   59.60 |   21.62 |
| catalog (de)      |   57.32 |   21.64 |
| catalog (it)      |   56.53 |   21.11 |
| catalog (es)      |   56.51 |   21.35 |
| catalog (cs)      |   55.07 |   21.92 |
| catalog (nl)      |   54.07 |   21.17 |
| catalog (en)      |   47.21 |   19.39 |
| catalog (zh-CN)   |   44.75 |   19.85 |
| SystemSettings    |   36.01 |    7.73 |
| InviteBanner      |   33.36 |    7.07 |
| AddAccountDialog  |   28.80 |    6.89 |
| Proposals         |   19.95 |    4.89 |
| ProfileEditor     |   15.73 |    4.17 |
| RadioGroup        |   12.75 |    3.32 |
| Feedback          |   10.60 |    2.84 |
| RawMessage        |    8.19 |    2.47 |
| SegmentedControl  |    3.64 |    1.45 |
| CreateLabelDialog |    2.13 |    0.89 |
| Button            |    0.72 |    0.35 |

Sizes come from `out/renderer`, with gzip computed by Python. Shared React, Effect/RPC/schema, Base UI and mail/reader code remain in the entry. Splitting reduces initial parsing rather than total installed bytes. Regenerate these sizes after `pnpm build`; hashed filenames will change.
