import { Context, type Effect } from "effect";
import type { ImageDownloader } from "../compose/compose-images.js";
import type { MediaError } from "../ai/media.js";

export interface AttachmentFileCache {
  version(): number;
  get(accountId: string, key: string, maxBytes: number): Promise<Uint8Array | null>;
  set(
    accountId: string,
    key: string,
    data: Uint8Array,
    maxBytes: number,
    version?: number,
  ): Promise<void>;
  trim(maxBytes: number): Promise<void>;
  size(accountId?: string): Promise<number>;
  clear(accountId?: string): Promise<void>;
}
export class AttachmentFiles extends Context.Service<
  AttachmentFiles,
  {
    readonly open: (directory: string) => AttachmentFileCache;
  }
>()("openmail/AttachmentFiles") {}
/** Owns DNS resolution and pinned TCP/TLS requests. A plain fetch cannot satisfy this port. */
export class ImageNetwork extends Context.Service<
  ImageNetwork,
  { readonly download: ImageDownloader }
>()("openmail/ImageNetwork") {}
export interface PdfOptions {
  readonly timeoutMs?: number;
  readonly maxPages?: number;
  readonly renderPage?: number;
  readonly workerUrl?: URL;
}
export class PdfWorker extends Context.Service<
  PdfWorker,
  {
    readonly extract: (
      data: Uint8Array,
      options?: PdfOptions,
    ) => Effect.Effect<readonly { page: number; text: string; png?: string }[], MediaError>;
  }
>()("openmail/PdfWorker") {}
export const AppVerifier = Context.Reference<{
  readonly verify: (bundle: string) => Promise<boolean>;
}>("openmail/AppVerifier", {
  defaultValue: () => ({ verify: () => Promise.resolve(false) }),
});

export type InferenceRequest =
  | { kind: "text"; text: string; mode: "query" | "passage" }
  | { kind: "query"; text: string }
  | { kind: "image"; data: Uint8Array };
export interface InferenceProcess {
  send(message: InferenceRequest): void;
  onMessage(listener: (message: unknown) => void): () => void;
  onFailure(listener: () => void): () => void;
  kill(): Promise<void>;
}
export type InferenceProcessLauncher = (entry: string, root: string) => InferenceProcess;
