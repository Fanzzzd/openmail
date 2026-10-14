import {
  mobileMailCodecLayer,
  type MobileDatabaseState,
  mobileMediaLayer,
  PortableMailbox,
  MobileBackgroundStorageLive,
  mobileOAuthLayer,
  opSqliteLayer,
  PlatformHost,
} from "@openmail/core/portable";
import { Layer } from "effect";
import { attachmentFilesLayer } from "./attachment-cache";
import { FetchHttpClient } from "effect/http";
import { configLayer, readMobileConfig } from "./config";
import { cryptoLayer } from "./crypto";
import { filesLayer } from "./files";
import { openMobileDatabase } from "./database-recovery";
import { authSession, browserLayer } from "./oauth";
import { clearShareCopies } from "../received-attachments";
import { transportLayer } from "./transport";
import { secretsLayer } from "./secrets";

export function mobileMailboxLayer(inspection?: MobileDatabaseState) {
  clearShareCopies();
  const config = readMobileConfig();
  const database = opSqliteLayer(() => openMobileDatabase(inspection));
  const platform = Layer.mergeAll(
    database,
    configLayer(config),
    secretsLayer,
    transportLayer,
    cryptoLayer,
    hostLayer,
    filesLayer,
    readerCapabilitiesLayer,
    browserLayer,
    FetchHttpClient.layer,
    mobileOAuthLayer(authSession(config)).pipe(Layer.provide(FetchHttpClient.layer)),
  );
  return Layer.mergeAll(
    PortableMailbox({ imapIdle: false, backgroundFlush: false, localDraftQueue: true }),
    MobileBackgroundStorageLive,
  ).pipe(Layer.provide(platform));
}

/** The device time zone from Hermes Intl, read on each call. */
const hostLayer = Layer.succeed(PlatformHost, {
  timeZone: () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
});

const readerCapabilitiesLayer = Layer.mergeAll(
  mobileMailCodecLayer,
  mobileMediaLayer,
  attachmentFilesLayer,
);
