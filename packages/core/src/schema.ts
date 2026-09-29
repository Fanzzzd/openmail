// Schemas and errors with no Node dependencies, for code that runs in a
// browser (the desktop renderer, later the mobile app). `@openmail/core`
// itself pulls in node:sqlite, the keychain and IMAP.
export * from "./domain.js";
export * from "./errors.js";
export { IMAP_PRESETS, ImapConnectInput, ImapPreset } from "./imap-presets.js";
export { Mailbox, MailboxEvent, ModelThread, SyncState } from "./mailbox.js";
