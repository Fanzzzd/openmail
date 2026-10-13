import { useLingui } from "@lingui/react/macro";

export function useComposeMessages() {
  const { t } = useLingui();
  return {
    couldntLoadTheOriginalAttachments: (reason: string) =>
      t`Couldn't load the original attachments: ${reason}`,
    saving: t`Saving…`,
    couldntSave: t`Couldn't save`,
    keptOnThisMac: t`Kept on this Mac`,
    couldntSync: t`Couldn't sync`,
    savedOnThisMacRetryingSyncAutomatically: t`Saved on this Mac. Retrying sync automatically.`,
    saved: t`Saved`,
    savedOnThisMacSyncsWhenOnline: t`Saved on this Mac. Syncs when online.`,
    waitForAttachmentsToFinishLoading: t`Wait for attachments to finish loading.`,
    listSeparator: t({ message: ", ", comment: "Separator between list items" }),
    theseAreNotEmailAddresses: (list: string) => t`These are not email addresses: ${list}`,
    addAtLeastOneRecipient: t`Add at least one recipient`,
    attachmentsExceedThe30MBComposeLimit: t`Attachments exceed the 30 MB compose limit.`,
    couldntReadTheAttachmentTryAddingIt: t`Couldn't read the attachment. Try adding it again.`,
    couldntLoadTheOriginalAttachmentsTryAgain: t`Couldn't load the original attachments. Try again.`,
    chooseBeforeInsertingAnImage: (editBody: string) =>
      t({
        message: `Choose ${editBody} before inserting an image.`,
        context: "message text instruction",
        comment: "editBody is the exact translated Edit body button label. Preserve it unchanged.",
      }),
    couldntInsertTheImageUseAPublic: t`Couldn't insert the image. Use a public PNG, JPEG, GIF or WebP image up to 8 MB.`,
    useAnImageUpTo8MB: t`Use an image up to 8 MB.`,
    usePNGJPEGGIFOrWebPImages: t`Use PNG, JPEG, GIF or WebP images up to 8 MB.`,
    couldntReadTheImage: t`Couldn't read the image.`,
    chooseBeforeInsertingATemplate: (editBody: string) =>
      t({
        message: `Choose ${editBody} before inserting a template.`,
        context: "message text instruction",
        comment: "editBody is the exact translated Edit body button label. Preserve it unchanged.",
      }),
    couldntReadTheClipboardAttachment: t`Couldn't read the clipboard attachment.`,
    gmailSize: t`Gmail attachments exceed 25 MB in total. Remove attachments before sending.`,
    gmailBlocked: (filename: string) =>
      t`Gmail blocks ${filename}. Remove this attachment before sending.`,
    outlookSize: t`Outlook.com messages are limited to 25 MB, including message text and attachments. Remove attachments before sending.`,
    outlookItemSize: t`Outlook cannot upload attached messages of 3 MB or more. Remove this attachment before sending.`,
  };
}
export type ComposeMessages = ReturnType<typeof useComposeMessages>;
