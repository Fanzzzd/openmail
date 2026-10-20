import { cleanLink } from "@openmail/core/schema";
import { openExternalUrl } from "../windows/reveal";
import { externalUrl } from "../../shared/external-url";

/** Mail/provider URLs never select a local app or pass credentials to the browser. */
export async function openExternal(value: string, clean = true): Promise<void> {
  const url = externalUrl(value);
  if (!url || new URL(url).protocol === "mailto:") throw new Error("External URL rejected");
  await openExternalUrl(cleanLink(url, clean));
}
