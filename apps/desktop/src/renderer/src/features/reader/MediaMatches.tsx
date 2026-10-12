import { useAtomValue } from "@effect/atom-react";
import { Trans, useLingui } from "@lingui/react/macro";
import { AsyncResult } from "effect/reactivity";
import { useRef, useState } from "react";
import type { DerivedChunk } from "../../../../shared/api";
import { resultError } from "../../lib/errors";
import { mediaImageAtom } from "../../state/queries";
import { Dialog } from "../../ui/Dialog";

/** Shows the original image with the OCR hit mapped onto its natural dimensions. */
function ImageMatch({ chunk, onClose }: { chunk: DerivedChunk; onClose: () => void }) {
  const { t, i18n } = useLingui();
  const result = useAtomValue(mediaImageAtom(chunk));
  const data = AsyncResult.getOrElse(result, () => null);
  const error = resultError(i18n, result);
  const region = chunk.region;
  const highlight = useRef<HTMLSpanElement>(null);
  return (
    <Dialog
      aria-label={t`Image region`}
      onClose={onClose}
      className="flex max-h-[85vh] w-[min(900px,90vw)] flex-col p-4"
    >
      <div className="mb-3 flex items-center justify-between gap-3">
        <p className="truncate font-medium">{chunk.source.name}</p>
        <button type="button" onClick={onClose} className="rounded px-2 py-1 hover:bg-black/5">
          <Trans>Close</Trans>
        </button>
      </div>
      <div className="overflow-auto">
        {error && <p role="alert">{error}</p>}
        {!data && !error && (
          <p>
            <Trans>Loading image…</Trans>
          </p>
        )}
        {data && region && (
          <div className="relative w-full">
            <img
              src={data}
              alt={chunk.source.name}
              className="block h-auto w-full"
              onLoad={() => highlight.current?.scrollIntoView({ block: "center" })}
            />
            <span
              ref={highlight}
              aria-label={t`Matched image region`}
              className="pointer-events-none absolute border-2 border-amber-500 bg-amber-300/25"
              style={{
                left: `${(region.box.x / region.imageWidth) * 100}%`,
                top: `${(region.box.y / region.imageHeight) * 100}%`,
                width: `${(region.box.width / region.imageWidth) * 100}%`,
                height: `${(region.box.height / region.imageHeight) * 100}%`,
              }}
            />
          </div>
        )}
      </div>
      <p className="mt-3 shrink-0">{chunk.text}</p>
    </Dialog>
  );
}
export function MediaMatches({ chunks }: { chunks: readonly DerivedChunk[] }) {
  const [selected, setSelected] = useState<DerivedChunk | null>(null);
  if (!chunks.length) return null;
  return (
    <section className="mx-4 mb-3 rounded-lg bg-amber-500/5 p-3 text-[13px]">
      <h3 className="mb-2 font-medium">
        <Trans>Content matches</Trans>
      </h3>
      <ul className="space-y-2">
        {chunks.slice(0, 20).map((chunk, index) => (
          <li key={index}>
            <p className="text-a11y-muted">
              {chunk.source.kind === "body" ? (
                <Trans
                  context="message text"
                  comment="Email message text, never an anatomical body."
                >
                  Message body
                </Trans>
              ) : (
                chunk.source.name
              )}
              {chunk.page !== null && (
                <>
                  {" "}
                  · <Trans>Page {chunk.page}</Trans>
                </>
              )}
              {chunk.region !== null && (
                <>
                  {" "}
                  · <Trans>Image region</Trans>
                </>
              )}
            </p>
            {chunk.region ? (
              <button
                type="button"
                className="text-left text-a11y-accent hover:underline"
                onClick={() => setSelected(chunk)}
              >
                {chunk.text}
              </button>
            ) : (
              <p>{chunk.text}</p>
            )}
          </li>
        ))}
      </ul>
      {selected && <ImageMatch chunk={selected} onClose={() => setSelected(null)} />}
    </section>
  );
}
