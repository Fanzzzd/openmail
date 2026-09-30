import { MailtoDraft } from "@openmail/core/schema";
import { Schema } from "effect";

export const DesktopEvent = Schema.Union([
  Schema.TaggedStruct("OpenThread", { id: Schema.String }),
  Schema.TaggedStruct("Compose", { draft: MailtoDraft }),
  Schema.TaggedStruct("Command", {
    command: Schema.Literals(["settings", "help", "compose", "inbox"]),
  }),
]);
export type DesktopEvent = typeof DesktopEvent.Type;

/** Only links survive a busy editor; menu commands always act immediately or are dropped. */
export function desktopEventRoute(
  event: DesktopEvent,
  busy: boolean,
): "dispatch" | "defer" | "drop" {
  return event._tag === "Command" ? (busy ? "drop" : "dispatch") : "defer";
}
export const DefaultClientStatus = Schema.Struct({
  available: Schema.Boolean,
  isDefault: Schema.Boolean,
});
export type DefaultClientStatus = typeof DefaultClientStatus.Type;
