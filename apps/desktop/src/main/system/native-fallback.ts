/** Native message boxes for when no renderer can draw the React prompt. */
import { showMessageBox } from "../windows/reveal";

/** Resolves with the index of the chosen button. The first button is the default and Cancel unless set. */
export const nativeAsk = (options: {
  type: "info" | "warning" | "error";
  message: string;
  detail?: string;
  buttons: readonly string[];
  defaultId?: number;
  cancelId?: number;
}) =>
  showMessageBox({
    type: options.type,
    message: options.message,
    ...(options.detail ? { detail: options.detail } : {}),
    buttons: [...options.buttons],
    defaultId: options.defaultId ?? 0,
    cancelId: options.cancelId ?? 0,
  }).then((result) => result.response);
