import { msg } from "@lingui/core/macro";

export const EDIT_MESSAGE_TEXT = msg({
  message: "Edit body",
  context: "message text action",
  comment:
    "Button that enables editing the email's text. Body means message text, never a person's body.",
});

/** Shown in place of an empty value. Pickers keep their own "None" option. */
export const NO_VALUE = msg({
  message: "None",
  context: "empty value",
  comment:
    "Shown in place of a value that is empty, such as no Cc recipients or no event location. Not an option in a list.",
});
