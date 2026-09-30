import { Schema } from "effect";

/** Localized by the renderer's Lingui catalog, reused by native menus and notifications. */
export const DesktopLabels = Schema.Struct({
  settings: Schema.String,
  newWindow: Schema.String,
  compose: Schema.String,
  help: Schema.String,
  archive: Schema.String,
  trash: Schema.String,
  noUnread: Schema.String,
  showInbox: Schema.String,
  allAccounts: Schema.String,
  file: Schema.String,
  edit: Schema.String,
  window: Schema.String,
  newMessages: Schema.String,
});
export type DesktopLabels = typeof DesktopLabels.Type;
