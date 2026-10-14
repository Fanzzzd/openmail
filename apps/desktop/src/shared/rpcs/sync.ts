import { MailboxEvent, SyncResult, SyncState } from "@openmail/core/schema";
import { Schema } from "effect";
import { Rpc } from "effect/rpc";

/** Sync runs and the mailbox event stream. */
export const SyncRpcs = [
  Rpc.make("Sync", { success: Schema.Array(SyncResult) }),
  Rpc.make("NetworkChanged", { success: Schema.Void }),
  Rpc.make("SyncState", { success: SyncState }),
  /** Sync state, progress and change notices as they happen. */
  Rpc.make("Events", { success: MailboxEvent, stream: true }),
] as const;
