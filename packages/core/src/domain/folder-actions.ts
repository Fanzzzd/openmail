import { Schema } from "effect";
import { MailboxView } from "./message.js";
import type { FeatureScopeMissing, InvalidInput, ProviderFailure } from "./errors.js";

/** Folder identity only: list filters, search and paging never constrain whole-folder actions. */
export const FolderScope = Schema.Struct({
  mailbox: MailboxView,
  accountIds: Schema.optionalKey(Schema.Array(Schema.String)),
  label: Schema.optionalKey(Schema.String),
});
export type FolderScope = typeof FolderScope.Type;
export const DeleteFolder = Schema.Literals(["trash", "spam"]);
export type DeleteFolder = typeof DeleteFolder.Type;
export type PermanentDeleteBatch =
  | { readonly kind: "complete"; readonly ids: readonly string[] }
  | {
      readonly kind: "partial";
      readonly ids: readonly string[];
      readonly error: ProviderFailure | FeatureScopeMissing | InvalidInput;
    };
export function deleteFolderForMailbox(mailbox: typeof MailboxView.Type): DeleteFolder | null {
  return mailbox === "trash" || mailbox === "spam" ? mailbox : null;
}
export interface FolderListOptions {
  readonly newestFirst?: boolean;
  readonly unreadOnly?: boolean;
  readonly includeChildren?: boolean;
}
export interface FolderPage {
  readonly ids: readonly string[];
  readonly next: string | null;
}
export const FOLDER_BATCH_LIMIT = 100;
export const FOLDER_MESSAGE_LIMIT = 100_000;
export const SELECTED_DELETE_LIMIT = 1000;
export const GMAIL_PERMANENT_DELETE_SCOPE = "https://mail.google.com/";
