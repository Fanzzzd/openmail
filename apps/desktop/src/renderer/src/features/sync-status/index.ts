// Public surface for other features: always-loaded modules only (see tests/layers.test.ts).
export {
  KeychainNotice,
  reauthText,
  ReauthNotice,
  SidebarAccountIssues,
  SyncStatusAnnouncement,
  syncFailures,
} from "./MailStatusNotice";
export { syncErrorText } from "./sync-failure-text";
