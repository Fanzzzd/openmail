import {
  MailboxLive,
  ModelAnthropic,
  MobileBackgroundStorageLive,
  StoreLive,
  mobileOAuthLayer,
  mobileProvidersLayer,
  opSqliteLayer,
} from "@openmail/core/portable";
import { Layer } from "effect";
import { FetchHttpClient } from "effect/http";
import { open } from "@op-engineering/op-sqlite";
import { configLayer, readMobileConfig } from "./config";
import { cryptoLayer } from "./crypto";
import { prepareMailDirectory, filesLayer } from "./files";
import { authSession, browserLayer } from "./oauth";
import { readerCapabilitiesLayer } from "./runtime";
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
