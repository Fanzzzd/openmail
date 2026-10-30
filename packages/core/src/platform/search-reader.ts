import { Context, type Effect } from "effect";
import type { InvalidInput } from "../domain/errors.js";
import type { ThreadQuery, ThreadSummary } from "../domain/message.js";

/** Optional off-thread local search. Node provides it for file databases; portable stays inline. */
export interface SearchReader {
  readonly threads: (query: ThreadQuery) => Effect.Effect<ThreadSummary[], InvalidInput>;
  readonly count: (query: ThreadQuery) => Effect.Effect<number, InvalidInput>;
}
export const SearchReader = Context.Reference<SearchReader | null>("openmail/SearchReader", {
  defaultValue: () => null,
});

/** Transport for the core-owned search child. Desktop supplies Electron utilityProcess. */
export interface SearchProcess {
  send(message: unknown): void;
  onMessage(listener: (message: unknown) => void): () => void;
  onFailure(listener: () => void): () => void;
  /** Resolves only when the process has exited, including during a synchronous SQLite statement. */
  kill(): Promise<void>;
}
export type SearchProcessLauncher = (entry: string, database: string) => SearchProcess;
