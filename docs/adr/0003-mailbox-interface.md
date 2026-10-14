# 0003 Group the Mailbox interface

Status: accepted. Migrated in steps 1 to 4; the final group list is under Result.

## Context

`Mailbox` in `packages/core/src/mailbox/mailbox.ts` is one `Context.Service` with about 142 members. The implementation is already split: `mailbox-live.ts` builds the service from parts (`mailbox-reading.ts`, `mailbox-drafts.ts`, `mailbox-outbox.ts`, `mailbox-apply.ts`, `mailbox-sync.ts`, `mailbox-accounts.ts`, `mailbox-ai.ts` and others) and spreads each part's `service` object into one flat record.

Callers do not see those parts. Desktop (`shared/mailbox-handlers.ts`, 247 lines that map RPCs to members), the CLI commands, the MCP toolkit and mobile all take the flat record. 13 production files and 81 test files `yield* Mailbox`. A reader of `mailbox.ts` finds section comments (Accounts, Reading, Changes, Drafts, Sync and so on), but the type does not enforce them. The promise in the file comment, that policy, audit and the change queue hold for every caller, is visible only by reading each part.

## Decision

Keep `Mailbox` as the one service and the one layer. Give it named groups that match the existing parts. Each group is a plain object typed from its part, so a group's type is the `service` the part already returns.

| Group               | Members today                                                                                             | Part                                                         |
| ------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `mailbox.reading`   | `threads`, `thread`, `readerThread`, `rawMessage`, attachments, inline images, `labels`, `searchServer`   | `mailbox-reading.ts`                                         |
| `mailbox.organize`  | `perform`, `modifyWithUndo`, `undoBatch`, snooze, labels and favorites, filters, vacation, folder actions | `mailbox-apply.ts`, `mailbox-batch.ts`, `mailbox-filters.ts` |
| `mailbox.proposals` | `decideProposal`, `proposals`, failed ops, audit, agent activity, agent write mode                        | `mailbox-apply.ts`                                           |
| `mailbox.compose`   | drafts (`openDraft`, `saveDraft`, `discardDraft`...), signatures, templates, recipients                   | `mailbox-drafts.ts`                                          |
| `mailbox.outbox`    | `queueSend`, undo send, `cancelQueuedSend`, `flushQueuedSends`, `sendAgain`                               | `mailbox-outbox.ts`                                          |
| `mailbox.accounts`  | `connect`, `reauth`, account settings, optional services, OAuth clients, profiles (spaces)                | `mailbox-accounts.ts`                                        |
| `mailbox.ai`        | AI settings, summaries, `askAi`, `composeAi`, triage, semantic search, local models                       | `mailbox-ai.ts`                                              |
| `mailbox.sync`      | `sync`, `pollInbox`, backfill, cache windows, `syncHealth`, connectivity                                  | `mailbox-sync.ts`, `mailbox-storage.ts`                      |
| `mailbox.calendar`  | invitations, calendar events, contacts snapshot                                                           | `mailbox-features.ts`                                        |

Rules for the groups:

- A group is a namespace, not a separate service. There is still one `Mailbox` tag and one `MailboxLive` layer, so tests and the desktop keep providing one layer.
- Every member that changes mail stays reachable only through a group that runs policy and audit. `organize`, `compose` and `outbox` keep their current entry points; no group exposes the store.
- Some members are written inline in `mailbox-live.ts` today (prefs, templates, contact suggestions). They move into their group's part file in step 2.
- Members that do not fit a group (prefs, updates, remote access, notification actions) go into `mailbox.app`. Prefer a small `app` group over stretching another group's meaning.
- The desktop RPC files in `shared/rpcs/` already group by domain. Each RPC handler calls the matching group, so a reader can go from an RPC file to one group.

## Migration

1. Add the groups next to the flat members. `mailbox-live.ts` sets `reading: readingMailbox.service` and so on, and keeps the spread. The `Mailbox` type gains the group fields. No caller changes. One commit.
2. Move callers group by group, smallest first: `ai`, `calendar`, `outbox`, then the rest. Each commit moves the desktop handlers, CLI commands, MCP tools, mobile and tests for one group, and removes that group's flat members from the type. `pnpm check-types` finds every caller that still uses a removed member.
3. When the flat record is empty, delete the spread in `mailbox-live.ts`. `Mailbox` is then the composition of the groups.
4. Update `docs/architecture.md` and CONTEXT.md with the group names, and record the final group list here.

Each step leaves `pnpm build && pnpm check-types && pnpm test` green, so the migration can stop between steps. Steps 2 and 3 touch many test files; run them when few branches are open.

## Consequences

- A caller, or an agent reading the code, sees about ten names on `Mailbox` instead of 142, and each name leads to one part file.
- Test fakes that build a partial `Mailbox` can fill only the groups they use.
- Member names inside a group can drop their prefix later (`mailbox.ai.summary` instead of `aiSummary`). That rename is not part of this migration.
- The remote RPC table in `shared/remote-policy.ts` lists RPC tags, not Mailbox members, so it does not change.

## Result

The migration ran as planned with these changes to the table:

- `sendAs` and `syncSendAs` sit in `organize`, next to the organization part that implements them.
- `readOnlySession` sits in `proposals`, next to the write modes.
- `messageAccounts` and `threadCount` sit in `reading`. `markUnreadFrom`, `unsubscribe`, `setClassificationOverride`, `createLabelAndApply` and `undoHistory` sit in `organize`.
- `closeSessions` and `syncHealth` sit in `sync`. `takeNotifications`, `diagnosticsState` and `events` sit in `app`.
- `accounts`, `sync` and `proposals` clash with a member of the same name. Those groups joined the type in their own step, and the members are now `mailbox.accounts.accounts`, `mailbox.sync.sync` and `mailbox.proposals.proposals`. Renaming them is part of the later prefix rename.
- Inline members moved to `mailbox-app.ts` (app), `mailbox-compose.ts` (signatures, templates, recipients), `mailbox-ai.ts` (local models), `mailbox-storage.ts` (cache size) and `mailbox-accounts.ts` (`initializeProfiles`). The wrappers for `searchServer`, `changeLabel` and `setAiAccount` moved into their parts as callbacks.

Final groups, 178 members:

| Group       | Members | Interface          | Parts                                                                                                         |
| ----------- | ------- | ------------------ | ------------------------------------------------------------------------------------------------------------- |
| `reading`   | 24      | `MailboxReading`   | `mailbox-reading.ts`                                                                                          |
| `organize`  | 36      | `MailboxOrganize`  | `mailbox-apply.ts`, `mailbox-batch.ts`, `mailbox-organization.ts`, `mailbox-filters.ts`, `mailbox-folders.ts` |
| `proposals` | 12      | `MailboxProposals` | `mailbox-apply.ts`                                                                                            |
| `compose`   | 27      | `MailboxCompose`   | `mailbox-drafts.ts`, `mailbox-outbox.ts`, `mailbox-compose.ts`, `mailbox-features.ts`                         |
| `outbox`    | 10      | `MailboxOutbox`    | `mailbox-outbox.ts`, `mailbox-drafts.ts`                                                                      |
| `accounts`  | 16      | `MailboxAccounts`  | `mailbox-accounts.ts`, `mailbox-services.ts`                                                                  |
| `ai`        | 17      | `MailboxAi`        | `mailbox-ai.ts`, `mailbox-reading.ts`                                                                         |
| `sync`      | 16      | `MailboxSync`      | `mailbox-sync.ts`, `mailbox-cache.ts`, `mailbox-storage.ts`                                                   |
| `calendar`  | 9       | `MailboxCalendar`  | `mailbox-features.ts`, `mailbox-apply.ts`                                                                     |
| `app`       | 11      | `MailboxApp`       | `mailbox-app.ts`                                                                                              |
