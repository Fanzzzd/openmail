# Using mail through the CLI and MCP

Run `pnpm build` first, then sign in to the accounts and sync. The CLI and MCP use NodeMailbox and the same local database, and they do not start Electron. Mobile reuses the portable Mailbox with the device's own storage. The module and permission structure is in the [architecture](architecture.md).

## CLI for people

From the repo root, run `node packages/cli/dist/cli.js <command>`. After a global install you can use `openmail` directly:

```sh
pnpm --dir packages/cli link --global
openmail config google --client-id <id> --client-secret <secret>
openmail config microsoft --client-id <id>
openmail accounts add gmail
openmail accounts add outlook
openmail accounts add imap --preset icloud --email me@icloud.com
openmail accounts reauth gmail:me@example.com
openmail spaces add Work --icon 🏭 --color blue
openmail spaces assign gmail:me@example.com <space-id>
openmail list --space <space-id> --label <label-id>
openmail search 'from:alice@example.com has:attachment'
openmail show '<message-id>' --thread
openmail proposals list
openmail proposals reject <id>
openmail agents write-mode
openmail audit --limit 20
```

The OAuth registration steps are in [Google](setup-google.md) and [Microsoft](setup-microsoft.md). The IMAP `--preset` takes `icloud`, `yahoo`, `qq`, `163`, `fastmail` or `custom`. `custom` needs `--imap-host` and `--smtp-host`. The password is read from `--password`, then `OPENMAIL_IMAP_PASSWORD`, then an interactive prompt. With the prompt, the password does not appear in the command.

`list` and `search` print one line per conversation: the time, sender, subject and the message ID for `show`. Unread lines carry `*`. When there is a next page, the last line gives the `--cursor`. `--json` prints `{threads, next_cursor}`, and the row fields match core's `ThreadSummary`. Spaces (called Profile in core) are managed with `openmail spaces` and filtered with `list --space`. The old `openmail profiles` and `--profile` still work but no longer appear in the help. `spaces assign` and `spaces remove` accept a space ID, or a name that only one space uses (case-insensitive). A missing account or space, or a name that matches several spaces, is an error with exit code 1. A usage error (missing argument, unknown argument or subcommand) does not print the full help. It writes only the error, the usage and a `--help` hint to stderr, with exit code 2.

`list`, `search`, `show`, `sync` and `health` are commands a person types in a terminal. They read all enabled accounts through Mailbox as the user and do not check the per-account AI permission. The reason: the user's own shell can already read the SQLite file, so a permission check here would stop no one. The AI permission only restricts the agent entry points, `openmail tool <tool-name>` and `openmail mcp`.

Changes from these commands enter the audit log as `user:cli`. `agents write-mode` only shows Changes by AI apps (Read only or Ask me first; `--json` prints `{"changes_by_ai_apps":"read_only"|"ask_me_first"}`). Passing a mode argument fails. The setting must be changed in the app's settings. The CLI can only list (`proposals list`) and reject (`proposals reject`) proposals. It cannot approve them. Approval happens only in the app's AI suggestions. An agent that can run a shell can also call the CLI, so an approval in the CLI does not count as the user's own confirmation. The old `proposals approve` still parses but does not appear in the help. Calling it fails with exit code 1 and tells the user to approve in the app. Core's `decideProposal` also rejects every approval that does not come from the app. The CLI has no send command. Sending must be reviewed in the app.

To check sync only, run `openmail health --json`, and add `--account <id>` for a single account. The report only compares provider and local counts. It does not sync or repair data. The fields are explained only in the [sync notes](sync-correctness.md#sync-health-check). The command implementation is in [cli.ts](../packages/cli/src/cli.ts).

To block remote writes, set `OPENMAIL_READ_ONLY=1` before the CLI or MCP starts. In this mode the process can still read the network and credentials, refresh tokens and write local state. `sync` does not push the existing queue. The MCP default of read tools and this session switch separately control the tool entry points and remote writes. The detailed boundary is maintained only in the [architecture](architecture.md#read-only-session). An MCP config can add `"env": { "OPENMAIL_READ_ONLY": "1" }`.

## Connecting AI apps

In the app's Settings → AI Access → AI apps, each client has a card: Claude Code, Codex, Claude (desktop) and Cursor. The card shows whether the client is installed, whether the `openmail` entry exists, whether it points to the current app, and the client's recent tool calls. Connect, Reconnect and Disconnect first open a confirmation dialog that lists the commands to run and the config file diff. They run only after you confirm. The mechanism, backups and atomic writes are maintained only in the [security notes](security.md#connecting-ai-apps).

| Client      | How it connects                                                                   | Config file                                                       |
| ----------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Claude Code | `claude mcp add-json --scope user openmail <entry JSON>`                          | top-level `mcpServers` in `~/.claude.json`                        |
| Codex       | `codex mcp add openmail -- <command>`; edits the file to reconnect or with no CLI | `[mcp_servers.openmail]` in `~/.codex/config.toml`                |
| Claude      | Edits the file directly                                                           | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Cursor      | Edits the file directly                                                           | `~/.cursor/mcp.json`                                              |

In the packaged app, `<command>` is `/Applications/OpenMail.app/Contents/MacOS/OpenMail --mcp`. In a dev build it is `node <repo>/packages/cli/dist/cli.js mcp`. When the app's data directory is not the default (for example with `--user-data-dir`), the entry includes `OPENMAIL_HOME`. Checking Allow AI suggestions adds `--allow-writes`. Set up by hand on the card gives commands or JSON to copy.

To connect by hand, run from the repo root:

```sh
claude mcp add --scope user --transport stdio openmail -- node "$(pwd)/packages/cli/dist/cli.js" mcp
codex mcp add openmail -- node "$(pwd)/packages/cli/dist/cli.js" mcp
```

The JSON for both Claude and Cursor uses `mcpServers`:

```json
{
  "mcpServers": {
    "openmail": {
      "command": "/Applications/OpenMail.app/Contents/MacOS/OpenMail",
      "args": ["--mcp"]
    }
  }
}
```

After linking the CLI globally (`pnpm --dir packages/cli link --global`), `command` can also be `openmail` with `args` set to `["mcp"]`. Claude started from Finder has a short PATH. If it cannot find the command, use the absolute path that `command -v openmail` prints. `openmail mcp`, `openmail-mcp` and `OpenMail --mcp` all run on stdio, and stdout carries only protocol frames.

The server instructions tell the model to call `access_status` first. It returns the readable accounts, the number of hidden accounts and the reasons (AI text permission off, account disabled), this client's write permission, whether the proposal tools are offered, and where the user can change these. `read_only_session` is true when this session cannot change mail: there are no proposal tools, the write permission is read only, or `OPENMAIL_READ_ONLY` is set. The last case is also reported on its own as `remote_writes_disabled`. Hidden accounts are given only as a count, never as addresses.

The top-level `openmail --help` lists only the commands for people. The agent tools are all under `openmail tool`. `openmail tool --help` shows only the first sentence of each tool's description, and `openmail tool <tool-name> --help` shows the full text. `--allow-writes` appears only on the three proposal tools. Snapshots in [mcp-server.test.ts](../packages/cli/src/mcp-server.test.ts) pin the help output.

## Reading and paging

`openmail tools --json` returns the current tool names, descriptions and input schemas. Tools are called only through `openmail tool <tool-name>`. The names match MCP. Calls run as `agent:mcp:openmail-cli` and check the AI permission. Input goes in `--input-json` and output comes from `--json`. Arguments and results match MCP. `openmail tool <tool-name> --help` lists the tool's arguments, types and descriptions from the schema.

```sh
openmail tool list_threads --input-json '{"mailbox":"snoozed","limit":20}' --json
openmail tool search --input-json '{"query":"from:alice@example.com has:attachment","server":true}' --json
openmail tool semantic_search --input-json '{"query":"travel plans","account_id":"gmail:me@example.com"}' --json
openmail tool read_thread --input-json '{"message_id":"gmail:me@example.com/m1","token_budget":12000}' --json
openmail tool list_labels --input-json '{"account_id":"gmail:me@example.com"}' --json
openmail tool list_templates --json
openmail tool read_template --input-json '{"id":"template:1"}' --json
openmail tool suggest_contacts --input-json '{"query":"Alice"}' --json
openmail tool list_attachments --input-json '{"message_id":"gmail:me@example.com/m1"}' --json
openmail tool attachment_text --input-json '{"message_id":"gmail:me@example.com/m1","attachment_index":0}' --json
openmail tool list_invites --input-json '{"message_id":"gmail:me@example.com/m1"}' --json
openmail tool calendar_overlap --input-json '{"message_id":"gmail:me@example.com/m1","key":"key returned by the invite"}' --json
openmail tool list_proposals --json
```

| Tool                                  | Returns, and arguments for the next call                                                                                                                                                                           |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `access_status`                       | Readable accounts, the hidden account count and reasons, the write permission, whether proposal tools exist, whether the session can change mail, and next steps for the user. Reads no mail                       |
| `list_accounts`, `list_profiles`      | Account or space IDs (called profile in MCP), passed to lists, search and draft proposals                                                                                                                          |
| `list_labels`                         | Gmail user labels, Outlook/IMAP folders and Gmail categories. The IDs filter lists                                                                                                                                 |
| `list_threads`                        | Conversation summaries. `id` is the representative message ID, used for reading and organize proposals. `mailbox: "snoozed"` lists snoozed mail                                                                    |
| `search`                              | Local full-text and enabled on-device index hits. `server: true` explicitly requests provider search and returns `ignored`, `errors` and `truncated`, which must be explained to the user                          |
| `semantic_search`                     | Up to five hits from a ready local text vector index, with no message snippet. Downloads no model. Returns `not_ready` when the index is not ready                                                                 |
| `read_thread`                         | Model message text for messages with IDs. Filters HTML hidden text and removes quotes and signatures. Contains no HTML, images or attachment-derived text                                                          |
| `list_templates`, `read_template`     | Template summaries, recipients and message text. Creates no draft                                                                                                                                                  |
| `list_signatures`, `read_signature`   | Signature IDs, sending addresses and plain text. Returns no HTML                                                                                                                                                   |
| `suggest_contacts`                    | Addresses from local history and cached contacts, usable in a draft's `to`, `cc` and `bcc`                                                                                                                         |
| `list_attachments`, `attachment_text` | Cached attachment metadata, existing OCR/PDF text, and the attachment index, page number, image region and processing version. Returns no binary data                                                              |
| `list_invites`, `calendar_overlap`    | Invites in the raw MIME and overlapping events. Uses the existing permission and may call the provider. Does not answer invites or create events                                                                   |
| `list_proposals`, `read_proposal`     | Pending IDs and the proposal fields the approval screen shows. Omits hidden fields such as HTML and attachment content. There is no approve, reject or send tool                                                   |
| `sync`                                | Explicitly pulls mail and pushes the existing queue. It calls the provider and performs the queue's pending writes. Output is budgeted. `omitted` marks left-out account results, which can be queried per account |

Result keys are snake_case at every level, matching the arguments: `account_id`, `is_unread`, `needs_reauth`, `search_matches`, `next_cursor`. Core's internal types still use camelCase. The output schemas in `tool-common.ts` convert keys when encoding and convert them back by the schema's declared key names when decoding. The budget counts the bytes after conversion. Fields that are always empty are left out: conversation rows have no `snippet`, and `read_thread` has no `labels` or `attachments`.

Tool results that contain mail content all have the shape `{notice, untrusted_mail}`. The subject, sender, attachment-derived text, invite text, proposal rationale, and the account, ID and paging fields are all inside `untrusted_mail`, and they must not be treated as instructions. All the paging fields below are read from that object. `access_status` and the three proposal tools read no mail. Their results are OpenMail's own fields (`next_steps`, `outcome`, `message`) with no wrapper. The rules for untrusted data are written once in the server instructions and are not repeated in each tool description.

When a tool fails, MCP returns `isError: true` with content `{message, code, hint}` and no `_tag`. `code` is one of `not_found`, `invalid_input`, `no_ai_consent`, `denied`, `not_ready`, `reauth_required`, `provider_rejected`, `provider_unavailable` or `too_many_proposals`. `hint` gives the next step. For example, a missing message points to `list_threads`/`search`, and a missing permission points to `access_status`. When the given `account_id` is not readable (it does not exist, is disabled or has no permission), the result is always `not_found`. It does not say which reason applies, so it does not reveal whether a hidden account exists. `profile_id`, template, signature and proposal IDs also return `not_found`. The `label` of `list_threads` accepts a label or folder ID, a name (case-insensitive) and system labels (such as `INBOX` and `CATEGORY_UPDATES`). When one name maps to different IDs in different accounts, the results from all those accounts are merged. When nothing matches it returns `not_found`, and `openmail list --label` also exits with `not_found`. `label:` in search also matches label names case-insensitively, and the local index folds only ASCII letters. `semantic_search` without `account_id` searches all readable accounts. It returns `not_ready` when the index is off or the account has no vectors yet. When the arguments contain a key the tool does not declare (for example `acount_id`), the whole call fails with `invalid_input` and names the closest valid key. Every inputSchema in tools/list has `additionalProperties: false`. A `cursor` that is not a `next_cursor` from the same tool with the same filters also returns `invalid_input`, and the hint says to omit `cursor` to start from the first page. Arguments that do not match the input schema also come back as a tool failure (`invalid_input`), not as JSON-RPC `-32602`, so the model can read the reason and correct it. MCP 2025-11-25 recommends this. Effect's McpServer turns argument errors into `InvalidParams`. `mcp-server.ts` wraps each tool at registration and turns that into an `isError` result. An unknown tool name is still a protocol error. Draft recipients are validated one by one. If any entry is not an address (for example only a name), the whole call fails and names that entry. Nothing is silently dropped. A proposal the policy rejects (`denied`) also comes back as a failure. A successful result gives both `structuredContent` and the same JSON as text. Since MCP 2025-06-18, a tool that declares an outputSchema should return `structuredContent` and, for older clients, also include the serialized JSON in TextContent. The outputSchemas in tools/list describe only the wrapper and top-level fields. The row structure is in the results themselves. With the default 20 tools, tools/list stays under 20 KB, and no description exceeds 400 characters.

Lists page with `next_cursor`. For the next page, keep the same filters and pass it as `cursor`. A conversation cursor holds both the time and the ID, so mail with the same time is not skipped between pages. When `search` results (MCP and `openmail search`) are sorted by time, they also continue from the last row's time and ID. If a conversation disappears between pages (for example it was archived elsewhere and then synced), nothing is skipped or repeated. When results are sorted by relevance (attachment text hits), there is no time order to continue from, so they continue by position. Other lists page by position in the current result. After mail or the index changes, query again. Each page holds at most 100 rows. Search pages through at most the first 200 candidates. `truncated` signals more results, and the query must be narrowed. Semantic search returns at most five candidates, and contact suggestions at most 100.

`token_budget` limits tokens conservatively by the UTF-8 bytes of the result JSON. The default is 12000 and the range is 2000 to 24000. When the budget is short, the result has fewer complete rows plus a cursor. A single row over budget is an error. Long text in summaries, participants and similar fields are shortened. IDs keep their original values. Template, signature and proposal text is read in parts with `next_offset`. Long attachment-derived text is split by line, and `text_offset` marks the position in the original. `read_thread` also uses `token_budget` to limit the full JSON. It may leave out earlier messages, and `truncated` counts the message text characters removed. `list_threads` pages only with `cursor`. It has no time-based `before` argument, so conversations at the same moment are not lost. The `mode` of `draft_message` is `new`, `reply` or `reply_all`, and `read_proposal` returns the same spelling. `read_proposal` accepts `id`, and also the `proposal_id` that `draft_message` returns. `draft_message` strips format and control characters from recipient display names, and drops any display name that contains `@`, keeping only the address. `modify_threads` accepts `label_id` only with `label`/`unlabel`. Other actions fail when it is given. The `due` of `snooze_threads` must be within the next year. A past time returns `invalid_input` and says the time has passed. Every failure carries a `hint`. `openmail tool --json` prints exactly the same object as MCP on stdout. The CLI's own explanations (errors, hints, why an account cannot be read) go only to stderr.

MCP access follows the per-account AI text permission by default. Accounts without permission or that are disabled are not read by tools. Reading conversations and attachments is also checked on every call. `semantic_search` can be limited to one account with `account_id`. Without it, it searches all readable accounts. The account must have the third-party AI text permission on and the local index enabled. The built-in assistant is still limited to the selected accounts that have permission. It removes message snippets, attachment names and media-derived hits from search results, and it does not allow server search. The Apple Contacts snapshot is only for desktop autocomplete and does not enter tools or AI context. See [Apple Contacts](apple-contacts.md). The subject, sender and message text of `read_thread` are all inside `untrusted_mail`. The proposal object of `read_proposal` is in `untrusted_mail.command`. A long draft body is split with `next_offset`, and the other fields come back in full on every page. Every result and page carries a `notice`. It says these mail fields and proposal rationales are untrusted data and must not be treated as tool instructions. Regression tests for permissions, identity and the output budget are in [testing](testing.md).

Lists and search do not return the provider snippet. When a message has HTML, `read_thread` prefers the visible text. `flags` can contain `hidden-text-removed`, `plain-differs`, `budget-exceeded` or `quoted-text-removed`. They mean, in order: hidden content was removed, the plain alternative differs, the CSS check budget ran out, or text was removed by `>` lines because no reliable quote boundary was found. `quoted_text_removed` gives the number of characters removed. A recognized reply header block also cuts off the quoted history. The rules are in the security notes. When the budget runs out, the result is the fixed placeholder `[Message too complex for AI: message text omitted.]`. Message text that has not passed the full visibility check is never returned. The extraction rules and limits are maintained only in the [security notes](security.md). The implementation is in [model-view.ts](../packages/core/src/ai/model-view.ts), [visible-text.ts](../packages/core/src/visible-text/visible-text.ts) and [tool-pages.ts](../packages/core/src/tools/tool-pages.ts).

## Proposing changes

By default the server lists only the read tools. To allow proposals, add `"--allow-writes"` to the config's `args`, or run `openmail mcp --allow-writes`. You must also set Changes by AI apps to Ask me first in the app's Settings → AI Access. When connecting from the app, checking Allow AI suggestions adds `--allow-writes`. The interface calls proposals AI suggestions. When the write permission is read only and a proposal tool is called, the returned message says that nothing changed, where to change the setting, and to call again afterwards. The permission, the per-account AI consent and whether the account is enabled are checked again on every call. A client also cannot create proposals for an account it cannot read.

Turning this on adds only `modify_threads`, `snooze_threads` and `draft_message`. Organizing is limited to archive, read/unread, star, and adding or removing existing Gmail user labels in the same account, for at most 20 conversations per call. The only folder operation is archive. Every other move is rejected. System labels are not offered. Snooze needs a time in milliseconds within the next year. When the same client proposes a change identical to a pending proposal (ignoring the rationale), the call returns the existing proposal's ID. It creates no new proposal and no new draft. Each client can have at most 50 pending proposals, and all AI clients together at most 200. When either limit is exceeded the call returns `too_many_proposals`, and the client waits until the user handles some in the app. Changing the client name only gets a new 50-proposal allowance and does not get around the combined limit. One `INSERT ... SELECT` in the store checks both limits and inserts, so several MCP processes proposing at once cannot exceed them. Drafts support only plain-text new messages, replies and reply-all. A new message must give `to` and `subject`. A reply can leave them out. Without `to`, `cc` and `bcc`, a reply goes to the original sender, and reply-all also copies the original's other recipients (without your own address). Without `subject`, it uses `Re:` plus the original subject.

The write permission is stored as `off`, `propose` or `allow`. The interface offers only Read only and Ask me first. The old `allow` shows as Ask me first, and no caller changes mail directly because of `allow`. MCP only creates proposals. The app shows every conversation, the real label names, the exact snooze time or the full draft for a person to approve. Drafts are saved only on this machine. They are queued for upload only after the user saves them in the app. Sending always needs confirmation in the app. CLI tool calls run as `agent:mcp:openmail-cli`, and MCP handshakes run as `agent:mcp:<clientInfo.name>`. Both are written to the audit log. When an MCP session reads the client name, it first applies NFC normalization, collapses whitespace (including newlines and Unicode line separators) to one space, removes all other control and bidirectional format characters, and keeps at most 64 code points. If nothing is left, the name is recorded as `mcp`. When the CLI prints proposals and the audit log, and when the app shows them, control and format characters always appear as `\u{…}` escapes. Names stored by older versions also cannot drive the terminal or change text direction. The audit log stores only the operation kind, account, recipient count and hashes. After a proposal is decided, its command text and rationale are cleared. When a permission is revoked or an account is removed, that account's pending proposals and drafts are rejected and cleared. Audit entries and decided proposals from older versions are cleaned by the same rule on first launch, and a prefs marker records this, so the audit table is not scanned again. When a permission is revoked, deleting drafts that were already uploaded also enters the queue and retries on failure. Provider copies waiting for deletion do not reappear during sync.

```sh
openmail tool modify_threads --allow-writes --input-json '{"message_ids":["gmail:me@example.com/m1"],"action":"archive","rationale":"This notice has been handled."}' --json
openmail tool draft_message --allow-writes --input-json '{"account_id":"gmail:me@example.com","to":["alice@example.com"],"subject":"Progress","body":"I will reply tomorrow.","rationale":"Prepare a draft for the user to check first."}' --json
```

Do not retry while a proposal is waiting for approval. Permanent delete, emptying the trash, rule creation, forwarding settings, account/OAuth/settings changes, calendar event creation and AI settings have no tool entry point. MCP proposals cannot be approved through the CLI. CLI commands such as classic account setup remain for the user to run by hand and are not part of the model Toolkit.
