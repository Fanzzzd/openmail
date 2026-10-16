# Changelog

All notable changes to OpenMail are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## Unreleased

The first public version. Everything below is new.

### Accounts and sync

- Gmail and personal Outlook through OAuth, with OpenMail's built-in clients or your own. The browser page after sign-in is a centered card with a status icon and follows light or dark mode. iCloud, Yahoo, QQ, 163, Fastmail and any IMAP/SMTP server with an app password.
- Local-first storage in SQLite (`node:sqlite`), shared by the desktop app, the CLI and the MCP server.
- Incremental sync, an offline change queue with retries, resumable backfill of older mail, and IMAP IDLE for new-mail signals.
- Sync health check that compares server and local counts per folder. Sync resets delete only inside the listed window and confirm mass deletions with the server.
- Local cache rules per folder and label, with an attachment cache and a cache settings page.
- A dropped IMAP connection, such as Wi-Fi turning off mid-sync, counts as a network failure and shows "Can't reach the mail server right now."

### Reading and search

- Conversation and single-message views, find in message, quoted text folding, raw source and EML export, print and PDF.
- Remote images load by default; you can ask per message or load only from known senders. Known trackers are removed under every setting.
- Sender authentication badges, link confirmation for mismatched or international domains, and warnings for dangerous attachments.
- Full-text search over local mail with boolean, phrase, date, size and attachment operators, merged with server search, recent searches and match highlights.
- Optional on-device OCR (macOS Vision), PDF text and semantic search.
- Attachments you open in other apps are copied to an internal folder. Unchanged copies are deleted after 7 days, Settings → Local cache clears the rest, and Time Machine skips the folder.
- Replying to or forwarding an HTML message keeps its quote as a read-only block below an editable body. Edit quoted text joins the quote into the editor.
- A Sent copy that fails to save is tried again after 1 h, 2 h, 4 h and so on, at most a day apart, up to 10 tries in 7 days. After that OpenMail shows the notice.
- The word index is finished before CLI and MCP search and before `openmail sync`. If another process holds the write lock, `openmail search` prints a note on stderr and the MCP `search` tool returns `search_notice`: results are approximate until the index is done.
- Date and size operators without a valid value, such as `newer:foo` or `larger:xyz`, are searched as plain text. MCP `search` and `openmail search --json` list them under `ignored`, and `openmail search` prints a note on stderr with the accepted forms.
- Opening remote-session launchers, key material, certificates and the other risky attachment types needs Save first. vCard and vCalendar files open in the in-app preview.
- Inline images in a message whose raw source is over 8 MB show as broken. OpenMail no longer downloads the whole message on every open. Attachments still download normally.
- A space typed after plain words in the search field stays. The search field keeps focus when results replace the list, as in the narrow layout or with the reading pane hidden.

### Writing and organizing

- Composer with rich text, plain text and Markdown, autosaved drafts synced both ways, undo send, send and archive, templates, signatures and From address choice.
- Batch actions, snooze, labels and nested folders, Gmail categories, Outlook Focused inbox, server filters and vacation replies.
- A new message in a snoozed conversation ends the snooze and returns the conversation to the Inbox.
- Replies and forwards go out when Gmail or Outlook no longer has the original message. IMAP replies stay threaded.
- IMAP setup asks for a sender name, which appears in the From line.
- Calendar invites with RSVP and recurrence, and contact suggestions from the server and, optionally, Apple Contacts.
- Copy to folders is a menu item in the conversation and batch menus, so the arrow keys reach it. Enter opens its form after the menu closes.
- A draft saved on this Mac that is only waiting to sync closes without a prompt. The prompt now reads "This draft has unsaved changes or couldn't sync." and appears for unsaved changes or a sync that stopped.

### Desktop

- Keyboard-first: three shortcut sets, link hints, Back and Forward, command menus.
- `openmail list --space` takes a space name or id. A space name cannot repeat another space's name (any letter case), cannot be `none`, cannot equal another space's id and cannot be blank once control and format characters are removed. Names are compared after NFKC normalization, and a name with a control character such as a line break is refused.
- A space name with a line break or tab says "A space name can't contain line breaks or tabs." A name that equals another space's id says "That is another space's id. Choose another name."
- The space editor rings the selected icon in dark mode, clears a save error once you edit the name, and names each color in words for screen readers.
- Spaces to group accounts, notification hours by space, menu bar and Dock integration, multiple windows, `mailto:` and `openmail:` links.
- Responsive layout from three panes down to one.
- Interface in English, Simplified Chinese, Czech, Dutch, French, German, Italian, Japanese, Russian and Spanish.
- Accessibility checks with axe, keyboard paths and screen reader labels.
- Close window (⌘W) closes an open menu, Select list or suggestion list, Settings page, dialog or inline composer first, then the window.
- Closing a dialog returns focus to the control that opened it, including a dialog opened from Settings.
- Czech, French, Italian, Russian and Spanish labels start with a capital where the English text does.
- Send feedback shows a redacted diagnostics preview with accounts numbered and hashes keyed per install. Copy diagnostics pastes it into a GitHub issue.
- After three unexpected stops within five minutes, OpenMail offers to continue, reset the local mail cache and re-sync, or quit.

### AI and agents

- Optional AI per account, off by default: summaries, a mail assistant (⌘J), writing help and triage suggestions. Changes the assistant proposes wait for your approval.
- CLI (`openmail`) and an MCP server for Claude Code, Codex, Claude and Cursor. Tools are read-only by default; write tools only create AI suggestions (called proposals in `list_proposals`, `read_proposal` and `openmail proposals`), and sending always needs confirmation in the app.
- MCP tools return the `busy` error when another OpenMail process holds the write lock past the timeout. The activity row each call writes no longer fails the call while the lock is held. OpenMail retries it in the background.
- MCP stays responsive while another process holds the write lock during the search backfill. Each backfill step waits at most 200 ms for the lock and tries again later.
- `openmail accounts add` and `openmail accounts reauth` print the sign-in URL after "If nothing opens, visit:", so you can open it by hand over SSH or on a Mac with no browser.
- A failed `openmail sync` says "Sync could not finish. Run it again, or add --log-level warn to see why." instead of promising an automatic retry.
- The CLI logs only errors by default. `--log-level warn` shows diagnostics, and `openmail mcp` logs warnings.
- `openmail search -newsletter` reads words that start with `-` as query text. `--` before the query also works.
- Connect AI apps from Settings, with a diff to review before any config file changes.
- Claude Sonnet 5.5, Opus 5.5 and Haiku 5.5 appear by product name with a cost note. Automatic triage stops at 100 conversations per day.

### Remote access

- Use your mailbox from a phone browser over Tailscale Serve. Off by default, bound to 127.0.0.1, limited to an allowlist of Tailscale logins and of RPCs.

### Mobile (preview)

- Expo app sharing core: Gmail, Outlook and IMAP accounts, threads, compose, search, background refresh and local notifications. Not yet tested on real devices.
