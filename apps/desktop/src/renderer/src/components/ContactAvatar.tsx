import { useAtomValue } from "@effect/atom-react";
import { AsyncResult, Atom } from "effect/reactivity";
import { DEFAULT_PREFS } from "@openmail/core/schema";
import { useState } from "react";
import type { Message } from "../../../shared/api";
import { avatarColor, displayName } from "../format";
import { contactPhotoAtom, prefsAtom } from "../state/queries";
const noPhoto = Atom.make(AsyncResult.success(null));
export function ContactAvatar({ message: m }: { message: Message }) {
  const prefs = AsyncResult.getOrElse(useAtomValue(prefsAtom), () => DEFAULT_PREFS);
  const photo = AsyncResult.getOrElse(
    useAtomValue(prefs.contactPhotos ? contactPhotoAtom(m.accountId, m.from.address) : noPhoto),
    () => null,
  );
  const [failed, setFailed] = useState<string | null>(null);
  return (
    <span
      className={`flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-full text-[15px] font-semibold text-white ${avatarColor(m.from.address)}`}
    >
      {photo && photo !== failed && /^data:image\/(png|jpeg|gif|webp);base64,/.test(photo) ? (
        <img
          src={photo}
          alt=""
          className="size-full object-cover"
          onError={() => setFailed(photo)}
        />
      ) : (
        displayName(m.from).slice(0, 1).toUpperCase()
      )}
    </span>
  );
}
