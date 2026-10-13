import { Effect, Option, Scope, Semaphore } from "effect";
import { ImapCommandError, ImapWire, MailTransport, MailWire, mailQuote } from "../mail-socket.js";
import { Secrets } from "../auth.js";
import { MailCodec } from "../mail-codec.js";
import { encodeProviderId, readCursor, type ImapCursor } from "../../providers/imap/imap-cursor.js";
import type { Account, ImapSettings } from "../../domain/account.js";
import { AuthError, PermanentError, ProviderError } from "../../domain/errors.js";
import { Buffer } from "../bytes.js";
import { isLoginRefusal } from "../../providers/reauth.js";
import { failure, fetchRawIn, mobileIncoming, type Folder } from "./imap-parse.js";
import type { ProviderAdapter } from "../../providers/adapter.js";
import { imapSettingsKey } from "../../providers/imap/imap-settings.js";

/**
 * Connections for the portable IMAP adapter: credentials, one-off sessions,
 * the long-lived push connection per account, and the per-account state that
 * survives between operations (namespaces, queued Message-IDs, copy progress).
 */
export const makeMobileImapSessions = Effect.gen(function* () {
  const transport = yield* MailTransport;
  const secrets = yield* Secrets;
  const codec = yield* MailCodec;
  const observedSent = new Set<string>();
  const namespaces = new Map<string, ImapCursor>();
  const pushMessageIds = new Map<string, Map<string, string>>();
  const copiedDestinations = new Map<string, Set<string>>();
  const copiedFor = (accountId: string) => {
    let copies = copiedDestinations.get(accountId);
    if (!copies) {
      copies = new Set();
      copiedDestinations.set(accountId, copies);
    }
    return copies;
  };
  const messageIdsFor = (accountId: string, queued?: ReadonlyMap<string, string>) => {
    let ids = pushMessageIds.get(accountId);
    if (!ids) {
      ids = new Map();
      pushMessageIds.set(accountId, ids);
    }
    for (const [id, messageId] of queued ?? []) ids.set(id, messageId);
    return ids;
  };
  const pushState = (account: Account, path: string, cursor?: string) =>
    readCursor(Option.fromNullishOr(cursor)).folders[path] ??
    namespaces.get(account.id)?.folders[path];
  const credentials = (account: Account) =>
    Effect.gen(function* () {
      if (!account.imap) return yield* new PermanentError({ message: "Missing IMAP settings" });
      const stored = yield* secrets.get(account.id);
      if (Option.isNone(stored))
        return yield* new AuthError({
          accountId: account.id,
          message: "No stored app password",
          reason: "keychain_missing",
        });
      return { settings: account.imap, pass: stored.value };
    });
  const open = async (
    settings: ImapSettings,
    pass: string,
    accountId: string,
    signal: AbortSignal,
  ) => {
    const socket = await transport.connect({
      host: settings.imapHost,
      port: settings.imapPort,
      tls: settings.imapPort === 993,
      signal,
    });
    const client = new ImapWire(new MailWire(socket));
    return client.run(signal, async () => {
      try {
        const greeting = await client.response();
        if (!/^\* (OK|PREAUTH)\b/i.test(greeting.text))
          throw new ProviderError({ message: "Invalid IMAP greeting" });
        await client.capability();
        if (settings.imapPort !== 993) {
          if (!client.capabilities.has("STARTTLS"))
            throw new ProviderError({ message: "IMAP requires STARTTLS" });
          await client.command("STARTTLS");
          await client.wire.upgrade();
          await client.capability();
        }
        if (!/^\* PREAUTH\b/i.test(greeting.text)) {
          try {
            if (Array.from(pass).some((character) => character.charCodeAt(0) > 127)) {
              const literal = Buffer.from(pass, "utf8");
              await client.command(
                `LOGIN ${mailQuote(settings.username)} {${literal.length}}`,
                literal,
              );
            } else await client.command(`LOGIN ${mailQuote(settings.username)} ${mailQuote(pass)}`);
          } catch (error) {
            if (
              error instanceof ImapCommandError &&
              error.status === "NO" &&
              isLoginRefusal({ imapCode: error.responseCode, text: error.text })
            )
              throw new AuthError({
                accountId,
                message: "IMAP login rejected",
                reason: "imap_auth_failed",
              });
            throw error;
          }
        }
        await client.capability();
        if (client.capabilities.has("ID"))
          await client.command('ID ("name" "openmail" "version" "0.1.0" "vendor" "openmail")');
        return client;
      } catch (error) {
        socket.close();
        throw error;
      }
    });
  };
  const session = <A>(
    account: Account,
    work: (
      client: ImapWire,
      settings: ImapSettings,
      pass: string,
      signal: AbortSignal,
    ) => Promise<A>,
  ) =>
    credentials(account).pipe(
      Effect.flatMap(({ settings, pass }) =>
        Effect.tryPromise({
          try: async (signal) => {
            const client = await open(settings, pass, account.id, signal);
            try {
              return await client.run(signal, () => work(client, settings, pass, signal));
            } finally {
              client.wire.socket.close();
            }
          },
          catch: failure,
        }),
      ),
    );
  const incoming = async (client: ImapWire, path: Folder, validity: string, uid: number) => {
    const row = await fetchRawIn(client, encodeProviderId(path.path, validity, uid));
    if (row.flags.includes("\\Deleted")) throw new PermanentError({ message: "Message is gone" });
    if (!(row.raw instanceof Uint8Array))
      throw new PermanentError({ message: "Missing mail source" });
    return mobileIncoming(await codec.parse(row.raw), path, validity, uid, row.flags, row.size);
  };
  const owner = yield* Effect.serviceOption(Scope.Scope);
  const pushClients = new Map<string, { client: ImapWire; key: string }>();
  const pushLocks = new Map<string, Semaphore.Semaphore>();
  if (Option.isSome(owner))
    yield* Scope.addFinalizer(
      owner.value,
      Effect.sync(() => {
        for (const pool of pushClients.values()) pool.client.wire.socket.close();
      }),
    );
  const pushSession = <A>(
    account: Account,
    work: (client: ImapWire, signal: AbortSignal) => Promise<A>,
  ) => {
    let lock = pushLocks.get(account.id);
    if (!lock) {
      lock = Semaphore.makeUnsafe(1);
      pushLocks.set(account.id, lock);
    }
    return credentials(account).pipe(
      Effect.flatMap(({ settings, pass }) =>
        Effect.tryPromise({
          try: async (signal) => {
            const key = imapSettingsKey(settings);
            let pool = pushClients.get(account.id);
            if (pool && pool.key !== key) {
              pool.client.wire.socket.close();
              pushClients.delete(account.id);
              pool = undefined;
            }
            if (pool) {
              try {
                await Effect.runPromise(
                  Effect.tryPromise((noopSignal) =>
                    pool!.client.run(noopSignal, () => pool!.client.command("NOOP")),
                  ).pipe(Effect.timeout("5 seconds")),
                  { signal },
                );
              } catch {
                pool.client.wire.socket.close();
                pushClients.delete(account.id);
                pool = undefined;
                signal.throwIfAborted();
              }
            }
            const client = pool?.client ?? (await open(settings, pass, account.id, signal));
            if (Option.isSome(owner)) pushClients.set(account.id, { client, key });
            const abort = () => {
              client.wire.socket.close();
              if (pushClients.get(account.id)?.client === client) pushClients.delete(account.id);
            };
            signal.addEventListener("abort", abort, { once: true });
            try {
              return await client.run(signal, () => work(client, signal));
            } catch (error) {
              client.wire.socket.close();
              pushClients.delete(account.id);
              throw error;
            } finally {
              signal.removeEventListener("abort", abort);
              if (Option.isNone(owner)) client.wire.socket.close();
            }
          },
          catch: failure,
        }),
      ),
      lock.withPermits(1),
    );
  };
  const closeSessions: NonNullable<ProviderAdapter["closeSessions"]> = (id) =>
    Effect.forEach(
      id ? [id] : [...pushClients.keys()],
      (accountId) =>
        Effect.sync(() => {
          const pool = pushClients.get(accountId);
          pool?.client.wire.socket.close();
          pushClients.delete(accountId);
        }).pipe(pushLocks.get(accountId)?.withPermits(1) ?? ((effect) => effect)),
      { discard: true },
    );

  return {
    transport,
    secrets,
    codec,
    observedSent,
    namespaces,
    pushMessageIds,
    copiedDestinations,
    copiedFor,
    messageIdsFor,
    pushState,
    credentials,
    open,
    session,
    incoming,
    owner,
    pushClients,
    pushLocks,
    pushSession,
    closeSessions,
  };
});
