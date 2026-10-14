import { ShareMenu, type BrowserWindow } from "electron";
import { Effect } from "effect";
import { DeviceError, type Mailbox } from "@openmail/core";

export const shareMessageLink = (
  mailbox: Mailbox["Service"],
  parent: BrowserWindow | null,
  request: { id: string; kind: "message" | "thread" | "web" },
) =>
  Effect.gen(function* () {
    if (process.platform !== "darwin" || !parent || parent.isDestroyed())
      return yield* new DeviceError({ message: "Message sharing is unavailable." });
    const url = yield* request.kind === "web"
      ? mailbox.reading.messageWebUrl(request.id)
      : mailbox.reading.privateMailLink(request.id, request.kind);
    // Share one URL chosen by the user. Never include message text or tokens.
    yield* Effect.try({
      try: () => {
        if (parent.isDestroyed()) throw new Error("Window closed");
        new ShareMenu({ urls: [url] }).popup({ window: parent });
      },
      catch: () => new DeviceError({ message: "Message sharing is unavailable." }),
    });
    return yield* Effect.void;
  });
