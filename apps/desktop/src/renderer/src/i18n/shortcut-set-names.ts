import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import type { ShortcutSet } from "../../../shared/shortcuts";

/** The keymaps a person can pick, in Settings and on the first-run step. */
export const SET_NAMES: { value: ShortcutSet; label: MessageDescriptor }[] = [
  { value: "mimestream", label: msg`Mimestream` },
  { value: "gmail", label: msg`Gmail` },
  { value: "apple", label: msg`Apple Mail` },
];
