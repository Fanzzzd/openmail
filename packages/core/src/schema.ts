// Schemas and errors with no Node dependencies, for code that runs in a
// browser (the desktop renderer, later the mobile app). `@openmail/core`
// itself pulls in node:sqlite, the keychain and IMAP.
export * from "./compose-text.js";
export * from "./domain.js";
export * from "./errors.js";
export { IMAP_PRESETS, ImapConnectInput, ImapPreset } from "./imap-presets.js";
export { Mailbox, MailboxEvent, ModelThread, SyncState } from "./mailbox.js";
export { type HeldSend, holdSend } from "./undo-send.js";
export * from "./print.js";
export * from "./reader-html.js";
export * from "./reading.js";
export * from "./trackers.js";

export * from "./organization.js";
export * from "./search.js";

export { htmlToText } from "./mime.js";
