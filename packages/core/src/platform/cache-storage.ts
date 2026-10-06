import { Context, Effect } from "effect";
import type { CacheFiles, CacheCompactionResult } from "../cache.js";

/** Measurement result when the platform cannot see the database files or volume. */
export const UNMEASURED_CACHE_FILES: CacheFiles = { walBytes: 0, recoveryBytes: 0, disk: null };

/** Mobile adapters may opt out until native volume statistics are available. */
export const CacheStorage = Context.Reference<{
  readonly measure: (databaseFile: string) => Effect.Effect<CacheFiles>;
}>("openmail/CacheStorage", {
  defaultValue: () => ({
    measure: () => Effect.succeed(UNMEASURED_CACHE_FILES),
  }),
});

export type CacheMaintenanceRequest =
  | { readonly file: string; readonly kind: "compact"; readonly full: boolean }
  | {
      readonly file: string;
      readonly kind: "upgrade";
      readonly script: string;
      readonly version: number;
    };
/** Full on-disk compaction must run outside the caller's JS thread. */
export interface CacheMaintenanceService {
  readonly run: (request: CacheMaintenanceRequest) => Effect.Effect<CacheCompactionResult>;
}
export const CacheMaintenance = Context.Reference<CacheMaintenanceService>(
  "openmail/CacheMaintenance",
  {
    defaultValue: () => ({ run: () => Effect.succeed("unavailable") }),
  },
);
