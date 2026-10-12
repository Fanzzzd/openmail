import type { Mailbox } from "@openmail/core";
import { InvalidInput, type PrefsPatch } from "@openmail/core/schema";
import { Effect, Stream } from "effect";
import { mailboxHandlers } from "../../shared/mailbox-handlers";
import { rendererPrefs } from "../../shared/renderer-prefs";
import { REMOTE_PREF_KEYS } from "../../shared/remote-policy";
import { RemoteRpcs } from "./remote-rpcs";

export const remotePrefs = (patch: PrefsPatch): Effect.Effect<PrefsPatch, InvalidInput> =>
  Object.keys(patch).every((key) => REMOTE_PREF_KEYS.has(key))
    ? rendererPrefs(patch)
    : Effect.fail(new InvalidInput({ message: "This setting is only available on the Mac." }));

/**
 * Handlers for remote clients. Shared ones are the desktop's own core handlers;
 * the rest never reach the Mac's windows, files, clipboard or OS services.
 */
export const remoteHandlers = (m: Mailbox["Service"]) =>
  RemoteRpcs.of({
    // Each browser connection owns its waiting sends, apart from desktop windows.
    ...mailboxHandlers(m, { ownerPrefix: "remote:" }),
    SetPrefs: ({ patch }) =>
      remotePrefs(patch).pipe(Effect.flatMap((allowed) => m.setPrefs(allowed))),
    DesktopEvents: () => Stream.never,
    WindowUiEvents: () => Stream.never,
    SetNativeMenuState: () => Effect.void,
    SetDesktopLabels: () => Effect.void,
    SetActiveSpace: () => Effect.void,
    SetWindowRoute: () => Effect.void,
    SetSendState: () => Effect.void,
    // A phone coming online says nothing about the Mac's own connection.
    NetworkChanged: () => Effect.void,
    NotificationActionCapabilities: () => Effect.succeed({ buttons: false, selection: false }),
    AttachmentCapabilities: () => Effect.succeed({ share: false }),
    NativeComposeCapabilities: () =>
      Effect.succeed({ photos: false, continuity: false, grammar: false }),
    Downloads: () => Stream.concat(Stream.make([]), Stream.never),
    UpdateState: () => Effect.succeed({ status: "disabled" as const }),
    CrashReportPending: () => Effect.succeed(false),
    ClaimInlineDraft: () => Effect.succeed(true),
    AppleContactsStatus: () => Effect.succeed({ status: "unsupported" as const, revision: 0 }),
    SpellcheckLanguages: () => Effect.succeed({ languages: [], automatic: true }),
  });
