import { deviceFailure, type Mailbox } from "@openmail/core";
import { Effect } from "effect";
import type { OpenDialogOptions } from "electron";

type ShowFolderDialog = (
  options: OpenDialogOptions,
) => Promise<{ canceled: boolean; filePaths: string[] }>;

/** The person picks the folder in a native dialog; the renderer never supplies the path. */
export const chooseAttachmentFolder = (
  m: { readonly app: Pick<Mailbox["Service"]["app"], "prefs" | "setPrefs"> },
  show: ShowFolderDialog,
) =>
  Effect.gen(function* () {
    const current = (yield* m.app.prefs).attachmentSaveFolder;
    const choice = yield* Effect.tryPromise({
      try: () =>
        show({
          ...(current?.kind === "custom" ? { defaultPath: current.path } : {}),
          properties: ["openDirectory", "createDirectory"],
        }),
      catch: deviceFailure,
    });
    const folder = choice.filePaths[0];
    if (choice.canceled || !folder) return null;
    yield* m.app.setPrefs({ attachmentSaveFolder: { kind: "custom", path: folder } });
    return folder;
  });
