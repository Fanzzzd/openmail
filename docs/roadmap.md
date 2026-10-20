# Roadmap

> Maintainer notes: the owner's working to-do list, including checks only the owner can run on real accounts ("Owner to-do"). It is not a public commitment.

The desktop goal is to match Mimestream's mail features and to support personal Outlook and IMAP/SMTP. Mobile reuses core. The item-by-item parity evidence stays in [parity](parity.md). This page tracks current progress and acceptance items.

## Progress (2026-10-07)

This page follows the current code. In the table below, "done" means the product path and automated regressions exist. Real accounts, device permissions and the public release are accepted separately. The sync reset deletion guard, Outlook delta paging, the stale cache sweep and the conflict queue are all merged. Every reset delete candidate must be verified. IMAP search failures, Graph continuation pages and Outlook contact folder traversal have fixes. The sync rules and evidence are in the [sync notes](sync-correctness.md#重置删除保护).

| Area                         | Done                                                                                                                                                                                                                                  |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mail actions and reliability | Batch and single-message actions, persistent undo records, queue retries, offline state protection, draft recovery, database recovery, redacted provider diagnostics, read-only sessions and sync health checks                       |
| Compose                      | Rich text formatting, plain text and Markdown, template variables and Bcc, named signatures, Gmail signature sync, sender address choice, contact groups, companies and photos, attachments and send safeguards                       |
| Reading and calendar         | Conversation order, quote folding, find in message text, raw message and EML, attachment interop, meeting entry points, invitation history and responses, conflict lookup, confirmed creation of recognizable events                  |
| Search and organizing        | Boolean and exclusion, phrases, field, date, size, category and Message-ID operators, word index with trigram fallback, server search, rule editing and applying to past mail, snooze                                                 |
| Desktop integration          | Keyboard and native menus, Profiles, notification hours, menu bar and Dock, drafts from opened files, spell checking, persistent attachment cache, account and update settings                                                        |
| AI                           | Model service, per-account text consent, streamed summaries with caching, mail assistant, compose diff preview, rewrite and translate, triage suggestions with their own switch, local semantic search                                |
| Apple Contacts               | Explicit authorization, in-process snapshot, group preferred address, photos, contact card jump and vCard import entry point                                                                                                          |
| Engineering checks           | Performance query plans and memory regressions, accessibility and keyboard regressions, renderer module split, real App, RPC and Mailbox mail flows, parser fuzzing and axe checks, catalog checks for ten languages                  |
| Platform and mobile          | Node platform split, portable entry, Expo project, op-sqlite, SecureStore and AuthSession adapters, Gmail, Outlook and IMAP/SMTP, restricted reading, compose with confirmed send, background refresh, local notifications and badges |

Evidence for the newer capabilities is in [read-only and optional services](architecture.md#read-only-session), [mail content protection](security.md), [the sync health report](sync-correctness.md#同步健康检查) and [the test entry points](testing.md). [db/migrations.ts](../packages/core/src/db/migrations.ts) has migrations 1 to 37. Migration 37 pins the rowid of the external-content FTS table so the database can safely reclaim free pages. T07 added whole-database metering, a capacity target, an LRU that adapts to low disk space, and worker compaction. It keeps starred mail, mail inside the retention period, labels marked keep forever, drafts and the outbox. The target is not a hard cap on the whole database. New databases use incremental reclaim from the start. Old databases need the user to click compact the first time. Checks for shared access, sync, read-only mode and index safety block unsafe compaction. Migration 36 and the outbound reliability rules are in the [sync notes](sync-correctness.md#出站操作队列). The 100,000-message budget, the migration 37 upgrade measurement and the compaction limits are in [performance](performance.md).

O30 added Gmail's exclude-chats condition and extra label actions, and Outlook conditions, exceptions, and category and copy actions. Native read-only rules, previews with missing metadata and the capped candidate search still have limits, so they stay partial. See [rule coverage](server-rule-coverage.md). S08 supports headers, user labels and AROUND proximity. A distance of zero uses an FTS phrase. Other distances are checked against word positions. Colored stars and complex OCR highlighting and ranking are still missing, so they stay partial. R40 added English and Chinese dates, six repeat patterns, confirmed creation and .ics export. The limits for ambiguous dates and lossless Outlook mapping are in [date rules](calendar-dates.md) and [parity](parity.md).

Basic reading, writing and sending for Gmail and personal Outlook have records of verification on real accounts. For later capabilities, the fake provider, fake Model, temporary databases and DOM regressions do not replace acceptance of new scopes, real models, native permissions and the release. The test entry points are in [testing](testing.md). Measurement conditions are in [performance](performance.md).

## Owner to-do

- OAuth: enable the APIs and permissions in your own consoles as described for [Google](setup-google.md) and [Microsoft](setup-microsoft.md). Contacts, calendar and provider settings connect per account, one at a time. Turning one off does not revoke the remote grant. When an old grant lacks a permission, sign in again from the optional services entry. Gmail permanent delete also needs `https://mail.google.com/`, granted again through the app's permanent delete permission entry. Normal sending and receiving does not need this scope. The basis for the permissions is [Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes).
- Release: provide your own Apple Developer signing identity and notarization credentials. Verify Developer ID, notarization, Gatekeeper, the keychain and native dependencies on both architectures, and auto-update from GitHub Releases. Build and credential details are maintained only in the [release notes](release.md).
- Mobile registration: create your own Google iOS and Android clients and Microsoft native redirect, and configure the bundle ID, package name and signing details. Create a development build as described in the [mobile notes](../apps/mobile/README.md). Verify native SQLite, FTS5, WAL, Metro, OAuth for both providers and paging of large mailboxes. Expo Go does not cover these.
- Push decision: decide whether to add a relay service. Then design Gmail watch and Graph subscriptions, APNs and FCM, device registration, renewal and the privacy contract. Desktop polling and IMAP IDLE are implemented. Mobile has OS-scheduled background incremental refresh and local notifications. There is no remote push.

Acceptance on real accounts and systems also covers:

1. Draft round trips for all three providers, alias and signature switching, attachments and large attachments, offline push, permanent delete and emptying the trash.
2. Cold cache and backfill past 90 days, search scope and truncation, nested folders, filters on new mail and past matches, auto-reply time zones, snooze and restart.
3. Gmail and Outlook invitation responses, recurring instances, cancellations and organizer notices. IMAP iTIP REPLY. Contact paging and refresh after revoking access.
4. In the signed build: notification permission and actions, Dock and Profiles, default mail client, links on cold start, spell checking, printing and PDF.
5. Apple Contacts system authorization, partial authorization, revoking access, contact card jump and import confirmation. The test limits are in [Apple Contacts](apple-contacts.md#verification-limits).
6. With your own API key, verify real model requests, cancellation and cost for summaries, the assistant, compose and triage. For the on-device index, also verify Vision, sqlite-vec and ONNX in the signed release build.

## Remaining features

Native capabilities follow the feature IDs in [parity](parity.md):

| Feature ID      | Remaining scope                                                                                                                                                                                                |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A05             | ASWebAuthenticationSession and choice of authorization browser                                                                                                                                                 |
| C51, I01 to I05 | System autocorrect, inline predictions, Apple Writing Tools and the system ChatGPT extension. Explicit grammar checking exists and still needs acceptance on a real Mac                                        |
| N11             | Focus Filter and App Intents per Profile                                                                                                                                                                       |
| N17, N19, M05   | Universal Links, Associated Domains, an HTTPS fallback page and a system share extension for receiving content. Sharing links out exists and still needs acceptance on a real Mac                              |
| M06 to M08      | Acceptance of the Photos picker and Continuity Camera on a real Mac. Markup write-back is not implemented                                                                                                      |
| M11, P06, P07   | Liquid Glass native controls, matching WebKit behavior, macOS App Sandbox                                                                                                                                      |
| M01             | A single Universal app. The current config builds separate arm64 and x64 packages. Intel hardware and ONNX limits are in the release notes                                                                     |
| R40             | Apple Calendar. Dates support only a bounded English and Chinese grammar. Common repeat rules are covered. Rules Outlook cannot express losslessly (month end, leap day, 5th weekday, exceptions) are rejected |

Other gaps include Workspace Directory, acceptance of real grants for optional services, some Gmail search extensions and rule conditions, Gmail server draft labels and stars, and real-time push. Google restricted-scope verification, Advanced Protection and CASA are external reviews. Built-in AI is implemented. I01 to I05 still refer only to Apple native capabilities.

Past slice updates are kept in git. parity keeps the current capability counts. Read the module entry points from [CONTEXT.md](../CONTEXT.md) and [architecture](architecture.md).

## Mobile

### Core platform interface

Node-only implementations live in `packages/core/src/platform/node/`. Mobile loads Mailbox, Store, migrations and the HTTP providers from `@openmail/core/portable`. The interface is in [the architecture's Platform ports](architecture.md#platform-ports). The file-by-file list is in the [platform dependency inventory](platform-inventory.md).

### Mobile basics

Mobile has Expo, React Native, op-sqlite, SecureStore, PKCE authorization in the system browser, account, mailbox and conversation lists, paging, restricted HTML reading, pull-to-sync and ten languages. The root `build` only compiles the language catalogs and checks types. Automated tests use the Node SQLite shim and mocks of native services.

### Mobile mail flows and background work

Mobile has organizing and undo, multi-select, configurable swipes, VoiceOver actions, reply, forward and rich text compose, file and photo attachments, local drafts and a persistent send queue. IMAP/SMTP uses the portable protocol and native TCP/TLS, and requires TLS or STARTTLS. Reader attachments download through core. The implementation is in [mobile platform assembly](../apps/mobile/src/platform/index.ts), the [IMAP adapter](../packages/core/src/platform/react-native/imap.ts) and the [compose screen](../apps/mobile/app/compose.tsx).

Background refresh, local notifications and badges are off by default. The OS decides when background tasks run. In the background, mobile only pulls Inbox changes. It does not backfill, send or push the organizing queue. Notifications show only the sender by default, not the message text. There is no remote push. The code and native patches are in [background.ts](../apps/mobile/src/background.ts) and the [mobile notes](../apps/mobile/README.md#foreground-and-background-sync-and-native-permissions).

Automated tests use the SQLite shim, chunked protocol streams and mocks of native services. They cannot prove TLS, Metro, notifications, locked-screen storage or background wakeups on a real device. Database recovery has a startup integrity check, a quarantine copy, salvage of readable user records, a recovery report, resuming an interrupted reinstall and a provider resync. In the background, a corrupt database stops the task and is not rebuilt. Mobile has no free disk space query and no full compaction entry yet. PDF text extraction and fixed-address image download return unavailable explicitly. On-device inference is not supported. The capability table, recovery limits, permissions and real-device acceptance are maintained only in the [mobile notes](../apps/mobile/README.md).
