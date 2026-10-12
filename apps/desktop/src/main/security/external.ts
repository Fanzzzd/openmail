import { cleanLink } from "@openmail/core/schema";
import { shell } from "electron";
import { externalUrl } from "../../shared/external-url";

/** Mail/provider URLs never select a local app or pass credentials to the browser. */
export async function openExternal(value: string, clean = true): Promise<void> {
  const url = externalUrl(value);
  if (!url || new URL(url).protocol === "mailto:") throw new Error("External URL rejected");
  await shell.openExternal(cleanLink(url, clean));
}
