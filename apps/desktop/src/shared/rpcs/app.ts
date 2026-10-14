import { NativeMenuState } from "../native-actions";
import {
  CacheDatabaseSize,
  CacheCompactionResult,
  CacheSize,
  UpdateState,
  OlderResult,
  BackfillState,
  CacheWindow,
  CacheWindowInput,
  ThreadQuery,
} from "@openmail/core/schema";
import { NotificationPermission, NotificationActionCapabilities } from "../desktop";
import { Schema } from "effect";
import { Rpc } from "effect/rpc";
import { error } from "./fields";

/** Menu state, spellcheck, cache, notifications, updates and backfill. */
export const AppRpcs = [
  Rpc.make("SetNativeMenuState", { payload: { state: NativeMenuState } }),
  Rpc.make("SpellcheckLanguages", {
    success: Schema.Struct({ languages: Schema.Array(Schema.String), automatic: Schema.Boolean }),
  }),
  Rpc.make("CacheDatabaseSize", { success: CacheDatabaseSize }),
  Rpc.make("CompactCache", { success: CacheCompactionResult }),
  Rpc.make("CacheSize", { success: Schema.Array(CacheSize) }),
  Rpc.make("ClearCache", { payload: { accountId: Schema.optionalKey(Schema.String) } }),
  Rpc.make("InitializeProfiles", {
    payload: {
      accept: Schema.Boolean,
      names: Schema.Struct({ personal: Schema.String, work: Schema.String }),
    },
  }),
  Rpc.make("NotificationActionCapabilities", { success: NotificationActionCapabilities }),
  Rpc.make("NotificationPermission", { success: NotificationPermission }),
  Rpc.make("RequestNotificationPermission", { success: NotificationPermission }),
  Rpc.make("OpenNotificationSettings", { success: Schema.Boolean }),
  Rpc.make("UpdateState", { success: UpdateState }),
  Rpc.make("CheckForUpdates", { payload: { download: Schema.Boolean } }),
  Rpc.make("BackfillState", { success: Schema.Array(BackfillState) }),
  Rpc.make("PauseBackfill", { payload: { accountId: Schema.String, paused: Schema.Boolean } }),
  Rpc.make("FetchOlder", { payload: { query: ThreadQuery }, success: OlderResult, error }),
  Rpc.make("CacheWindows", { success: Schema.Array(CacheWindow) }),
  Rpc.make("SetCacheWindow", { payload: { input: CacheWindowInput }, error }),
] as const;
