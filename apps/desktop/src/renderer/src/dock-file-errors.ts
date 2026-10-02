import { msg } from "@lingui/core/macro";
import type { MessageDescriptor } from "@lingui/core";
import type { DockFileReason } from "../../shared/dock-files";

export const DOCK_FILE_MESSAGES: Record<DockFileReason, MessageDescriptor> = {
  tooMany: msg`Too many attachments. Attach up to 256 files.`,
  notFile: msg`Only regular files can be attached. Folders cannot be attached.`,
  tooLarge: msg`Attachments exceed the 30 MB compose limit.`,
  changed: msg`An attachment changed while reading. Try adding it again.`,
  unreadable: msg`Could not read the attachments. Check the files and their permissions.`,
};
