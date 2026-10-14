# IMAP thread IDs on desktop and mobile

Status: records the current behaviour and recommends unifying it. This change does not alter the algorithm.

## Algorithms and known differences

Node's [threadIdOf](../../packages/core/src/platform/node/imap/parse.ts) uses `references`, `inReplyTo` and `messageId` as parsed by MailCodec, and takes the first valid ID in that order. A References array is first joined with spaces. Each field is matched against `<([^<>\s]+)>`. If nothing matches, the field is split on whitespace and any word containing `@` is accepted. The next field is tried only when a field has no valid ID. If all are missing, providerId is used.

React Native's [mobileIncoming](../../packages/core/src/platform/react-native/imap-parse.ts) reads the References and Message-ID strings from the `headers` Map. It picks one non-empty field with `references || parsed.inReplyTo || messageId`, then matches `<([^<>]+)>`. It does not accept bare IDs, and it does not try the next field after a failed match. Whitespace inside the angle brackets is kept. A non-string headers value counts as an empty string. When the match fails, providerId is used.

The MIME adapters also shape the input: Node uses mailparser and React Native uses postal-mime. A [regression test](../../packages/core/src/platform/node/imap-thread-ids.test.ts) feeds the raw headers below to each real codec and pins the current results. The React Native providerId is `9:1:INBOX`.

| Headers                                                                                       | Node threadId                                                           | React Native threadId |
| --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | --------------------- |
| `Message-ID: bare@example.test`                                                               | `bare@example.test`                                                     | `9:1:INBOX`           |
| `Message-ID: <child@example.test>`, `References: root@example.test`                           | `root@example.test`                                                     | `9:1:INBOX`           |
| `Message-ID: <child@example.test>`, `References: noise`, `In-Reply-To: <parent@example.test>` | `noise`, because the Node codec normalizes References to angle brackets | `9:1:INBOX`           |

Valid standard reference chains usually agree. One more difference is purely in the algorithm: for a `references: "noise"` value that has not been normalized, Node goes on to In-Reply-To, while React Native falls straight back to providerId.

## One account on two devices

Desktop and phone each have their own database. Server identity is still UIDVALIDITY, UID and folder path. threadId only controls local grouping and does not change a message's server identity. The messages above can join a reference chain on desktop and form single-message threads on the phone. After a move, providerId changes, which can also change the phone's thread key.

When valid References are missing and In-Reply-To is present, [Store.upsertMessage](../../packages/core/src/store/store-messages.ts) tries to inherit the threadId of the local parent message. If it finds no parent, it keeps the existing row's threadId. Whether the parent is cached, each device's sync window and the order history is read all affect the final grouping. The same account can show different thread counts and different bulk-action scopes. Reminders, snoozes and derived summaries stored per thread do not line up across devices on their own. Message text and attachments are never lost just because threadIds differ.

## Options for unifying

- Unify on Node: both platforms share valid-ID parsing, field fallback and bare-ID support. The codecs' output also needs one input format, so odd values such as `noise` stop diverging between codecs.
- Unify on React Native: both platforms pick a field first and then match angle brackets. The change is smaller, but desktop would split existing bare reference chains, and an odd field would still block fallback.
- Define a new shared algorithm: build normalized IDs from the cached raw headers, fall back field by field, and set explicit rules for repeated References, whitespace, bare IDs and odd values. Both codecs supply the same input. The result is more stable, but it must be versioned and the old cache recomputed.

## Migration requirements

After unifying the algorithm, recomputing only newly fetched mail is not enough. One database would then hold two sets of thread keys.

1. Append a version and recompute progress to the end of MIGRATIONS in `db/migrations.ts`. Do not change existing migrations. Recompute per account and make it resumable. Fill old rows that lack headers through the existing backfill first. Pause related grouping changes so they cannot race the recompute.
2. Use `UPDATE thread_id` or the `ON CONFLICT DO UPDATE` in the existing `upsertMessage`, so the rowid and local ID of each message stay the same. Do not use `INSERT OR REPLACE`. messages_fts is an external-content table and must stay aligned by rowid. Check row counts, rowids, FTS search and integrity before and after the migration.
3. Record the member mapping from old threads to new threads. Threads can merge or split, so define how the reminder dates and foreign keys in `thread_reminders` and `snoozed_messages` migrate. Migrate threadIds in undo records by member, and invalidate old `derived` thread summaries. The existing update triggers on `message_badges` and `message_search_meta` re-project those rows, but this still needs checking.
4. Keep the providerId, RFC Message-ID and copy progress of pending_ops, as well as drafts and the outbox. A thread recompute must not change their server identity or send anything again.
5. Add migration regression tests for Node and React Native databases, merges and splits, parents outside the window, missing headers, and resuming after a restart. The runtime and the database migration must use the same algorithm version.

Recommendation: adopt a new shared algorithm that keeps Node's per-field fallback and bare-ID support, with raw headers as the single input. Settle the rules for odd values and for merging and splitting reminders first, then write the appended migration. This change only pins the differences in a test and does not recompute the cache.
