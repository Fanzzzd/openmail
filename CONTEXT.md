# Domain context

OpenMail caches mail on the local machine. The desktop app, the CLI and the MCP server share one database, one operation queue and one set of permissions through core. The mobile app reuses the portable core with the device's own database and secure storage.

## Terms

| Term                     | Meaning                                                                                                                                                        |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Account                  | A signed-in Gmail, personal Outlook or IMAP mailbox, with its provider identity and sync state.                                                                |
| Provider                 | Gmail, Outlook or IMAP. A `ProviderAdapter` turns the protocol into core changes and operations.                                                               |
| Optional service         | Per-account contacts, calendar or provider settings. OpenMail records the scope grant and the local on/off switch separately.                                  |
| Read-only session        | `OPENMAIL_READ_ONLY=1` blocks remote writes. Network reads, token refresh and local writes still run.                                                          |
| Sync health report       | Compares local and provider counts per folder or label, with cursor age and pending operations. It does not prove that contents match.                         |
| Message                  | The local mirror of a server message. The local ID includes the account identity; `providerId` is the server ID.                                               |
| Thread                   | Messages in one account grouped by `threadId`. Lists and tools usually locate a thread by the ID of a representative message.                                  |
| Message text             | The plain-text content of a message. HTML is a separate reading representation that OpenMail sanitizes and isolates.                                           |
| Draft                    | Local editable content in the `drafts` table. Its local ID is separate from the server draft or message ID.                                                    |
| Label                    | One representation of Gmail labels and Outlook or IMAP folders. Operations must follow each provider's semantics.                                              |
| Profile                  | A group of accounts, shown as a space in the UI. It sets the account scope, notification hours and window choice. A profile is not an account.                 |
| Command                  | A serializable change to mail. `Mailbox.perform` checks permissions and runs it.                                                                               |
| Actor                    | The identity and entry point of a user or agent. It feeds policy decisions and the audit log.                                                                  |
| Proposal                 | An agent command waiting for the user's approval. Writes from MCP and from the built-in assistant both go through the proposal flow.                           |
| Operation queue          | `pending_ops`, the durable queue of local changes waiting to reach the provider. It supports claiming, retries and error records.                              |
| Failed operation         | `FailedOp`. `failed_ops` stores push failures and send warnings. Desktop and mobile query them through Mailbox.                                                |
| Reset verification queue | Reset or Outlook conflict candidates stored in prefs under `sync-reset:<account>`. Unverified entries stay, and the next sync continues verifying them.        |
| Undo journal             | `UndoJournal`. `undo_batches` stores the inverse state of batch and single-message operations so undo survives a restart. Undo checks for later changes first. |
| Derived data             | Search text and vectors, AI summaries and triage suggestions. Stored separately; never overwrites provider mail.                                               |
| Model                    | The streaming Effect service for a third-party language model. The current implementation is Anthropic.                                                        |
| ModelRuntime             | The on-device embedding inference interface. Its permissions are separate from the text grant for the third-party Model.                                       |
| MailToolkit              | Core's set of model tools. The CLI, the MCP server and the built-in assistant reuse its schemas and handlers.                                                  |
| Platform port            | A SQL, file, secret, OAuth, MIME, network or worker service that core needs from the host.                                                                     |
| Layer                    | The Effect unit that supplies a concrete implementation for a service.                                                                                         |

- `messageId` means different things at different boundaries. Providers return the server ID. Mailbox and Store parameters take the local ID with the account prefix. The RFC Message-ID lives in `rfcMessageId`; it comes from the header and usually includes `<…>`. The three are not interchangeable.
- A `MailOp` is a single change to mail, such as read, star, move or label. A `Command` adds the target and approval semantics. A `QueuedOp` also covers draft saves, deletes and reconcile.
- A queued send (`queueSend`) stores the intent to deliver offline or at a scheduled time. A delayed send (`queueUndoSend`) stores the short wait for undo send. Both write to the outbox and show as waiting; the delayed send carries the `desktopUndo` flag.
- `FolderScope` (mailbox, accountIds, label) is the target of a whole-folder operation. It does not include search, paging or unread filters. A label or folder scope is also informally called a "label scope".

## Module entry points

Core paths are relative to `packages/core/src`. [ADR 0001](docs/adr/0001-core-layout.md) maps directories to domains.

| Location                                                                                     | Responsibility                                                                                                      |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `domain/`, `store/service.ts`, `providers/adapter.ts`, `mailbox/mailbox.ts`                  | Domain schemas, the Store and ProviderAdapter ports, the Mailbox interface callers use.                             |
| `mailbox/mailbox-live.ts`, `mailbox/mailbox-*.ts`                                            | Assembles sync, policy, queue and audit. Split into batch, folder, cache, contacts and calendar, organizing and AI. |
| `store/store.ts`, `store/store-*.ts`, `db/`                                                  | SQLite queries, projections and append-only migrations. Message writes go through `upsertMessage`.                  |
| `providers/gmail/`, `providers/outlook/`, `platform/node/imap/`                              | Provider adapters. A fetch produces Changes, and Mailbox writes them to the store.                                  |
| `platform/react-native/imap.ts`, `platform/mail-socket.ts`                                   | Mobile IMAP/SMTP protocol and portable transport. The app supplies the native TCP/TLS Layer.                        |
| `mailbox/read-only.ts`, `providers/optional-services.ts`, `mailbox/mailbox-services.ts`      | The allowlist of read-only methods, per-service scopes and the local on/off switch.                                 |
| `sync/sync-reset.ts`, `store/store-sync-reset.ts`                                            | Bounded reset deletes, durable conflict candidates, stale-cache scans and provider existence checks.                |
| `sync/sync-health.ts`, `store/store-sync-health.ts`, `providers/provider-diagnostics.ts`     | The sync health report, local counts and redacted provider failure events.                                          |
| `ai/model.ts`, `mailbox/mailbox-ai.ts`, `store/store-ai.ts`, `ai/model-view.ts`              | Third-party models, account grants, caching, triage and the message text context models see.                        |
| `tools/`                                                                                     | The tool set (one module per group of tools), identity, paging and output budgets.                                  |
| `ai/indexer.ts`, `ai/semantic-indexer.ts`, `store/store-media.ts`, `store/store-semantic.ts` | On-device OCR and PDF derived text, vectors and retrieval.                                                          |
| `platform/`, `platform/node/`, `platform/react-native/`                                      | Portable ports, the Node implementation, and mobile SQL, OAuth and MIME adapters with no React Native dependency.   |
| `apps/desktop/src/main`, `preload`, `shared`                                                 | Windows and system capabilities, the sandboxed preload, the RPC schema and Mailbox handlers.                        |
| `apps/desktop/src/renderer/src/app`, `features`, `state`, `ui`                               | Hooks that assemble the UI, components by feature, Effect atoms and shared components.                              |
| `packages/cli/src/cli.ts`, `packages/cli/src/commands/`, `packages/cli/src/mcp-server.ts`    | CLI commands for people (one module per group) and the stdio MCP server. Both use NodeMailbox.                      |
| `apps/mobile/app`, `apps/mobile/src/platform`                                                | Expo routes, the mobile UI and OS Layers. They call only the portable Mailbox.                                      |
| `apps/desktop/src/renderer/src/e2e`                                                          | Full mail-flow tests against the real App, RPC, Mailbox and a temporary SQLite database.                            |
| `apps/desktop/scripts/smoke.mjs`                                                             | Starts the production build on a copy of the database and checks the window and the sync health report.             |
| `apps/mobile/src/background.ts`, core `mailbox/mobile-background.ts`                         | OS background incremental refresh, local notifications, badges and durable deduplication.                           |

## Where the rules live

Read [AGENTS.md](AGENTS.md) before changing code. [Architecture](docs/architecture.md) covers module interfaces and data flow. Read the [platform inventory](docs/platform-inventory.md) before changing platform code. The [agent guide](docs/agents.md) covers model tools and approval rules, and [Apple Contacts](docs/apple-contacts.md) covers the Contacts integration. [Testing](docs/testing.md) lists the test entry points, and the [roadmap](docs/roadmap.md) covers product scope and real-account acceptance. Each of these documents maintains its own detailed rules.
