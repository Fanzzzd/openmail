// Compatibility exports for the Node IMAP provider.
export { openImap, smtpTransport } from "./imap/session.js";
export {
  type SyncFolder,
  mapFolders,
  threadIdOf,
  attachmentNodes,
  type Flags,
  folderLabels,
  toIncoming,
  parseHeaders,
  stripBcc,
} from "./imap/parse.js";
export { fetchMessages } from "./imap/pull.js";
export { makeImapWith, makeImap } from "./imap/pool.js";
export {
  encodeProviderId,
  decodeProviderId,
  uidSet,
  parseUidSet,
  readCursor,
  FolderState,
  trackImapBackfill,
} from "../../imap-cursor.js";
export { resolveImapSettings } from "../../imap-settings.js";
export { mimeAddresses as addresses } from "../mail-codec.js";
