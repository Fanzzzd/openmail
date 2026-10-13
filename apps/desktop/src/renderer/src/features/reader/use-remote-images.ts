import { useAtom, useAtomValue } from "@effect/atom-react";
import { shouldLoadRemote, type remoteImageMode } from "@openmail/core/schema";
import { AsyncResult } from "effect/reactivity";
import type { Message } from "../../../../shared/api";
import { imageSendersAtom, knownSendersAtom } from "../../state/queries";
import { imagesLoadedAtom } from "../../state/ui";
import { readerThreadKey } from "./reader-selection";

/** Which messages of the thread load remote images, and the button that loads them for all. */
export function useRemoteImages({
  stored,
  messages,
  single,
  selectedId,
  imageMode,
}: {
  stored: readonly Message[];
  messages: readonly Message[];
  single: boolean;
  selectedId: string;
  imageMode: ReturnType<typeof remoteImageMode>;
}) {
  const addresses = [
    ...new Set(messages.map((m) => m.from.address.trim().toLowerCase())),
  ].toSorted();
  const known = AsyncResult.getOrElse(
    useAtomValue(knownSendersAtom(stored[0]?.accountId ?? "", addresses)),
    (): readonly string[] => [],
  );
  const imageSenders = AsyncResult.getOrElse(
    useAtomValue(imageSendersAtom),
    (): readonly string[] => [],
  );
  const isKnown = (m: Message) => known.includes(m.from.address.trim().toLowerCase());
  const [imagesLoaded, setImagesLoaded] = useAtom(
    imagesLoadedAtom((single ? selectedId : readerThreadKey(stored[0])) ?? selectedId),
  );
  // Only messages on screen at the click load; later arrivals ask again.
  const loadImages = () =>
    setImagesLoaded(new Set([...imagesLoaded, ...messages.map((m) => m.id)]));
  const loadsRemote = (m: Message) =>
    imagesLoaded.has(m.id) ||
    shouldLoadRemote(m, {
      remoteImages: imageMode,
      imageSenders,
      knownSender: isKnown(m),
    });
  return { imageSenders, loadImages, loadsRemote };
}
