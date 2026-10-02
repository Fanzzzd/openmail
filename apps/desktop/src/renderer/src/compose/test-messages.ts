import type { ComposeMessages } from "../components/Composer";
export const testMessages = {
  couldntLoadTheOriginalAttachments: (reason: string) =>
    `Couldn't load the original attachments: ${reason}`,
  saving: `Saving…`,
  couldntSave: `Couldn't save`,
  keptOnThisMac: `Kept on this Mac`,
  couldntSync: `Couldn't sync`,
  savedOnThisMacRetryingSyncAutomatically: `Saved on this Mac. Retrying sync automatically.`,
  saved: `Saved`,
  savedOnThisMacSyncsWhenOnline: `Saved on this Mac. Syncs when online.`,
  waitForAttachmentsToFinishLoading: `Wait for attachments to finish loading.`,
  listSeparator: ", ",
  theseAreNotEmailAddresses: (list: string) => `These are not email addresses: ${list}`,
  addAtLeastOneRecipient: `Add at least one recipient`,
  attachmentsExceedThe30MBComposeLimit: `Attachments exceed the 30 MB compose limit.`,
  couldntReadTheAttachmentTryAddingIt: `Couldn't read the attachment. Try adding it again.`,
  couldntLoadTheOriginalAttachmentsTryAgain: `Couldn't load the original attachments. Try again.`,
  chooseBeforeInsertingAnImage: (editBody: string) =>
    `Choose ${editBody} before inserting an image.`,
  couldntInsertTheImageUseAPublic: `Couldn't insert the image. Use a public PNG, JPEG, GIF or WebP image up to 8 MB.`,
  useAnImageUpTo8MB: `Use an image up to 8 MB.`,
  usePNGJPEGGIFOrWebPImages: `Use PNG, JPEG, GIF or WebP images up to 8 MB.`,
  couldntReadTheImage: `Couldn't read the image.`,
  chooseBeforeInsertingATemplate: (editBody: string) =>
    `Choose ${editBody} before inserting a template.`,
  couldntReadTheClipboardAttachment: `Couldn't read the clipboard attachment.`,
  gmailSize: `Gmail attachments exceed 25 MB in total. Remove attachments before sending.`,
  gmailBlocked: (filename: string) =>
    `Gmail blocks ${filename}. Remove this attachment before sending.`,
  outlookSize: `This app supports Outlook attachments up to 3 MB in total. Large attachment uploads are not supported yet. Remove attachments before sending.`,
} satisfies ComposeMessages;
