# 0001 Core folders by domain

Status: accepted.

## Context

The top level of `packages/core/src` held about 320 files, with only two subfolders, `outlook/` and `platform/`. New contributors could find code only by file-name prefix. madge found 15 import cycles in core and 12 in the desktop source. All of them went through `import type`, so the existing oxlint rule `import/no-cycle` missed them, because it ignores type imports by default. Files such as `tools.ts`, `db.ts`, `gmail.ts`, `search.ts`, `domain.ts` and `services.ts` were over 1,000 lines.

## Decision

Core source files go into folders by the domains in [CONTEXT.md](../../CONTEXT.md). Folder names use terms already in the glossary. Files keep their names, so git history and file names in existing docs stay searchable.

| Folder               | Contents                                                                                                    |
| -------------------- | ----------------------------------------------------------------------------------------------------------- |
| Top level            | Package entries only: `index.ts`, `common.ts`, `portable.ts`, `schema.ts`                                   |
| `domain/`            | Domain schemas, error types, MailOp and folder scope, categories, organize rules                            |
| `mailbox/`           | The Mailbox service and its `mailbox-*.ts` parts, policy, the read-only session, undo, outbox               |
| `store/`             | The Store port, `store-*.ts` queries, row decoding                                                          |
| `db/`                | Append-only migrations, the migration runner, search-flag SQL, database capabilities                        |
| `sync/`              | Sync health reports, sync reset, failure categories, header backfill, token keep-alive, backoff             |
| `providers/`         | The ProviderAdapter port, capabilities, HTTP, retry, diagnostics, optional services, OAuth clients, reauth  |
| `providers/gmail/`   | The Gmail adapter, split into fetch, history, send and labels                                               |
| `providers/outlook/` | The Outlook adapter (formerly `outlook/` and `outlook-*.ts`), Graph paging                                  |
| `providers/imap/`    | IMAP cursors, presets and IDLE scheduling shared by both platforms. The protocol stays in `platform/`       |
| `calendar/`          | Calendar events, time and recurrence rules, invite parsing, the Windows time-zone table, provider calendars |
| `contacts/`          | Contacts and Apple Contacts snapshots                                                                       |
| `compose/`           | Composer body, formatting, Markdown drafts, signatures, recipients                                          |
| `mime/`              | MIME parsing, TNEF, attachment policy and reader attachments, Message-ID                                    |
| `reader/`            | Reader HTML cleaning, trackers, link and sender safety, printing, reader rules                              |
| `visible-text/`      | Visible-text extraction for the message text models see                                                     |
| `search/`            | Query parsing, FTS, bigrams, ranking, snippets and highlights                                               |
| `ai/`                | Model, ModelRuntime, local indexing, vector search, the model's message view                                |
| `tools/`             | The MailToolkit, one module per group of tools. `tool-pages.ts` handles paging and budgets                  |
| `app/`               | Desktop integration: link and notification decisions, updates, remote access, feedback                      |
| `platform/`          | Platform ports. `platform/node/` and `platform/react-native/` are unchanged                                 |

Rules:

- Node-specific code still lives only in `platform/node/`. `platform-imports.test.ts` walks all of `src`, so new folders are checked automatically.
- The package export paths do not change. Only the dist files that `exports` in `package.json` points to change. Production code in desktop, the CLI and mobile imports core only through the entries. Deep paths in tests move with the files.
- Tests sit in the same folder as the source file they test. An integration test that covers several modules goes in the domain folder it mainly checks. Node process tests go in `platform/node/`.
- Split large files along interface boundaries, not by line count. Callers import the new modules directly. No compatibility file re-exports the old path.
- The target is about 800 lines at most for non-generated source files. `db/migrations.ts` is an exception: `MIGRATIONS` is append-only SQL data, and splitting it would blur the rule "append at the end".
- The desktop's RPC declarations live by domain in `shared/rpcs/` (accounts, reading, attachments, organize, changes, compose, AI, desktop and others). Each file exports one RPC array. `shared/rpc.ts` combines them into the single `MailRpcs` group, and callers still import from `shared/rpc`. `shared/remote-policy.ts` lists the remotely callable RPCs by tag, whatever file declares them.

## Import cycles

Shared types move down into leaf modules, which breaks every cycle. The gate is oxlint's `import/no-cycle` with `ignoreTypes: false`, so cycles made of type imports fail too. The check takes about 1 second across the repo. `pnpm exec oxlint` is already in the pre-commit checks, and no dependency is added.

## Consequences

- New files go into the matching domain folder. Only entry files may sit at the top level, and `platform-imports.test.ts` checks this.
- Source paths in docs include the folder.
- A one-time move causes conflicts in unmerged branches. Only this one branch was changing code at the time, so the cost was low.
