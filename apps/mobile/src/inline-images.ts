import { useEffect, useMemo, useState } from "react";

const EMPTY: Readonly<Record<string, string>> = {};
/** Message IDs are stable across unrelated mailbox revisions and HTML toggles. */
export class MessageInlineImages {
  private readonly values = new Map<string, Promise<Readonly<Record<string, string>>>>();
  constructor(private readonly fetch: (id: string) => Promise<Record<string, string>>) {}
  load(id: string, html: string): Promise<Readonly<Record<string, string>>> {
    if (!/cid:/i.test(html)) return Promise.resolve(EMPTY);
    const existing = this.values.get(id);
    if (existing) return existing;
    const value = Promise.resolve()
      .then(() => this.fetch(id))
      .catch((error: unknown) => {
        this.values.delete(id);
        throw error;
      });
    this.values.set(id, value);
    return value;
  }
}
type ImageState =
  | { kind: "ready"; value: Readonly<Record<string, string>> }
  | { kind: "loading" }
  | { kind: "failed" };
export function useMessageInlineImages(
  id: string,
  html: string,
  visible: boolean,
  fetch: (id: string) => Promise<Record<string, string>>,
) {
  const loader = useMemo(() => new MessageInlineImages(fetch), [fetch]);
  const [result, setResult] = useState<{
    id: string;
    loader: MessageInlineImages;
    state: ImageState;
  } | null>(null);
  const needsImages = visible && /cid:/i.test(html);
  useEffect(() => {
    if (!needsImages)
      return () => {
        /* No pending CID request. */
      };
    let active = true;
    void loader
      .load(id, html)
      .then((value) => {
        if (active) setResult({ id, loader, state: { kind: "ready", value } });
        return null;
      })
      .catch(() => {
        if (active) setResult({ id, loader, state: { kind: "failed" } });
      });
    return () => {
      active = false;
    };
  }, [loader, id, needsImages, html]);
  const state: ImageState = !needsImages
    ? { kind: "ready", value: EMPTY }
    : result?.id === id && result.loader === loader
      ? result.state
      : { kind: "loading" };
  return { ...state, value: state.kind === "ready" ? state.value : EMPTY };
}
