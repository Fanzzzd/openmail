import { touchIcon } from "../../../ui/styles";

/** A borderless icon button in the composer's header, footer and attachment chips. */
export const quiet = `rounded-control p-1 ${touchIcon} text-a11y-muted outline-offset-0 outline-a11y-focus hover:bg-fill-hover focus-visible:outline-[3px] data-popup-open:bg-fill-pressed`;

/** A form row; it marks its focused text field with an accent underline, and buttons in it keep their own outline. */
export const row =
  "flex items-start gap-2 border-b border-separator px-4 has-[input:focus]:border-a11y-focus has-[input:focus]:shadow-[inset_0_-1px_0_var(--a11y-focus)]";
/** The label at the start of a form row. */
export const label = "flex h-9 w-14 shrink-0 items-center text-a11y-muted";
