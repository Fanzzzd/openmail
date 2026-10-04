import {
  ImageNetwork,
  mobileMailCodecLayer,
  MediaError,
  PdfWorker,
  ProviderError,
  MailboxLive,
  ModelAnthropic,
  MobileBackgroundStorageLive,
  StoreLive,
  mobileOAuthLayer,
  mobileProvidersLayer,
  opSqliteLayer,
} from "@openmail/core/portable";
import { Effect, Layer } from "effect";
import { attachmentFilesLayer } from "./attachment-cache";
import { FetchHttpClient } from "effect/http";
import { open } from "@op-engineering/op-sqlite";
import { configLayer, readMobileConfig } from "./config";
import { cryptoLayer } from "./crypto";
import { prepareMailDirectory, filesLayer } from "./files";
import { authSession, browserLayer } from "./oauth";
import { clearShareCopies } from "../received-attachments";
import { transportLayer } from "./transport";
import { secretsLayer } from "./secrets";

export function mobileMailboxLayer() {
  clearShareCopies();
  const config = readMobileConfig();
  const database = opSqliteLayer(() => {
    const directory = prepareMailDirectory();
    return open({ name: "mail.db", location: directory });
  });
  const platform = Layer.mergeAll(
    database,
    configLayer(config),
    secretsLayer,
    transportLayer,
    cryptoLayer,
    filesLayer,
    readerCapabilitiesLayer,
    browserLayer,
    FetchHttpClient.layer,
    mobileOAuthLayer(authSession(config)).pipe(Layer.provide(FetchHttpClient.layer)),
  );
  const services = Layer.mergeAll(StoreLive, mobileProvidersLayer, ModelAnthropic).pipe(
    Layer.provideMerge(platform),
  );
  return Layer.mergeAll(
    MailboxLive({ imapIdle: false, backgroundFlush: false, localDraftQueue: true }),
    MobileBackgroundStorageLive,
  ).pipe(Layer.provide(services));
}

// MIME and attachment cache are portable; media extraction still needs a native worker.
const readerCapabilitiesLayer = Layer.mergeAll(
  mobileMailCodecLayer,
  Layer.succeed(PdfWorker, {
    extract: () =>
      Effect.fail(new MediaError({ message: "PDF extraction is unavailable on mobile" })),
  }),
  Layer.succeed(ImageNetwork, {
    download: () =>
      Effect.fail(
        new ProviderError({ message: "Pinned image transport is unavailable on mobile" }),
      ),
  }),
  attachmentFilesLayer,
);
