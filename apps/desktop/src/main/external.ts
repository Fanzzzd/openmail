import { shell } from "electron";
import { externalUrl } from "../shared/external-url";

/** Mail/provider URLs never select a local app or pass credentials to the browser. */
export async function openExternal(value: string): Promise<void> {
  const url = externalUrl(value);
  if (!url) throw new Error("External URL rejected");
  await shell.openExternal(url);
}
