import {
  MailboxLive,
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
import { secretsLayer } from "./secrets";

export function mobileMailboxLayer() {
  const config = readMobileConfig();
  const database = opSqliteLayer(() => {
    const directory = prepareMailDirectory();
    return open({ name: "mail.db", location: directory });
  });
  const platform = Layer.mergeAll(
    database,
    configLayer(config),
    secretsLayer,
    cryptoLayer,
    filesLayer,
    readerCapabilitiesLayer,
    browserLayer,
    FetchHttpClient.layer,
    mobileOAuthLayer(authSession(config)).pipe(Layer.provide(FetchHttpClient.layer)),
  );
  const services = Layer.mergeAll(StoreLive, mobileProvidersLayer).pipe(
    Layer.provideMerge(platform),
  );
  return MailboxLive({ imapIdle: false, backgroundFlush: false }).pipe(Layer.provide(services));
}
