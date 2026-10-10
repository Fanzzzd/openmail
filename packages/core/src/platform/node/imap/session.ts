import { Effect, Option, Predicate } from "effect";
import type { ImapFlow } from "imapflow";
import type { Account, ImapSettings } from "../../../domain.js";
import { AuthError, InvalidInput, ProviderError } from "../../../errors.js";
import { resolveImapSettings } from "../../../imap-settings.js";
import { isLoginRefusal } from "../../../reauth.js";
import { Secrets, type ConnectInput } from "../../../services.js";
import type { HtmlText } from "../../html-text.js";
import { IDLE_RENEW_MS } from "../imap-idle.js";

// NetEase (163, 126, yeah.net) rejects SELECT with "Unsafe Login" unless the
// client identifies itself with the IMAP ID command. imapflow sends ID with
// these fields when the server advertises it, and again after LOGIN when the
// first answer was empty.
const CLIENT_INFO = { name: "openmail", version: "0.1.0", vendor: "openmail" };

// Errors

// imapflow marks failed logins with `authenticationFailed`; nodemailer uses EAUTH / 535.
// Both only exist once the server answered the login, so TCP and TLS already succeeded.
// A 4xx SMTP auth reply (454 temporary failure) is retryable.
export function isAuthFailure(error: unknown): boolean {
  if (!Predicate.isObject(error)) return false;
  const refused =
    ("authenticationFailed" in error && error.authenticationFailed === true) ||
    ("code" in error && error.code === "EAUTH") ||
    ("responseCode" in error && error.responseCode === 535);
  return (
    refused &&
    isLoginRefusal({
      imapCode:
        "serverResponseCode" in error && Predicate.isString(error.serverResponseCode)
          ? error.serverResponseCode
          : undefined,
      smtpCode:
        "responseCode" in error && typeof error.responseCode === "number"
          ? error.responseCode
          : undefined,
    })
  );
}

/** The server said NO to a command: the folder or message is not there, or the op is refused. */
export function isRefusal(error: unknown): boolean {
  return Predicate.isObject(error) && "responseStatus" in error && error.responseStatus === "NO";
}

/** The server's own words when there are any, else the error message. */
export function describe(error: unknown): string {
  if (Predicate.isObject(error) && "responseText" in error) {
    const text = error.responseText;
    if (Predicate.isString(text) && text) return text;
  }
  return error instanceof Error ? error.message : String(error);
}

/** Maps a thrown IMAP or SMTP error onto the provider failure types. */
export function failure(
  accountId: string,
  host: string,
  error: unknown,
): AuthError | ProviderError {
  // "socket disconnected before secure TLS connection was established" is a dropped network.
  const dropped =
    Predicate.isObject(error) &&
    "code" in error &&
    Predicate.isString(error.code) &&
    /^(?:ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ETIMEOUT|EPIPE|ENETUNREACH|EHOSTUNREACH)$/.test(
      error.code,
    );
  if (!dropped && /STARTTLS|TLS|certificate/i.test(describe(error)))
    return new ProviderError({
      message: `${host}: TLS is required before authentication. ${describe(error)}`,
    });
  if (isAuthFailure(error)) {
    return new AuthError({
      accountId,
      message: `${host} rejected the login: ${describe(error)}`,
      reason: "imap_auth_failed",
    });
  }
  if (/unsafe login/i.test(describe(error))) {
    return new ProviderError({
      message: `${host} blocked the session as an unsafe login. Turn on IMAP in the web settings and use the client authorization code.`,
    });
  }
  return new ProviderError({ message: `${host}: ${describe(error)}` });
}

// Connections

export interface ImapConnection {
  accountId: string;
  settings: ImapSettings;
  client: ImapFlow;
}

/** A pooled connection with the adapter's HTML-to-text service. */
export interface Session extends ImapConnection {
  htmlText: HtmlText;
}

function ignore(): void {
  // Nothing to do: the command waiting on the socket rejects with the same error.
}

/** Logs out politely; a session that cannot is closed. */
const logout = ({ client }: ImapConnection) =>
  Effect.tryPromise(() => client.logout()).pipe(
    Effect.catch(() => Effect.sync(() => client.close())),
  );

// A failed load maps like a failed connection.
const load = <A>(accountId: string, host: string, module: () => Promise<A>) =>
  Effect.tryPromise({ try: module, catch: (error) => failure(accountId, host, error) });

/** One IMAP session, logged out when the scope closes. */
export function openImap(accountId: string, settings: ImapSettings, password: string) {
  const connect = Effect.gen(function* () {
    const { ImapFlow } = yield* load(accountId, settings.imapHost, () => import("imapflow"));
    const client = yield* Effect.sync(() => {
      const c = new ImapFlow({
        host: settings.imapHost,
        port: settings.imapPort,
        secure: settings.imapPort === 993,
        doSTARTTLS: settings.imapPort !== 993 ? true : undefined,
        auth: { user: settings.username, pass: password },
        clientInfo: CLIENT_INFO,
        logger: false,
        disableAutoIdle: true,
        maxIdleTime: IDLE_RENEW_MS,
        connectionTimeout: 20_000,
      });
      // Socket errors after connect arrive as events; the pending command rejects too.
      c.on("error", ignore);
      return c;
    });
    yield* Effect.tryPromise({
      try: () => client.connect(),
      catch: (error) => failure(accountId, settings.imapHost, error),
    }).pipe(Effect.onError(() => Effect.sync(() => client.close())));
    return { accountId, settings, client } satisfies ImapConnection;
  });
  return Effect.acquireRelease(connect, logout);
}

/** Runs one imapflow call, mapping its rejection onto provider failures. */
export function call<A>(
  s: ImapConnection,
  f: (client: ImapFlow, signal: AbortSignal) => Promise<A>,
) {
  const abort = () => s.client.close();
  return Effect.tryPromise({
    try: async (signal) => {
      signal.addEventListener("abort", abort, { once: true });
      try {
        signal.throwIfAborted();
        return await f(s.client, signal);
      } finally {
        signal.removeEventListener("abort", abort);
      }
    },
    catch: (error) => failure(s.accountId, s.settings.imapHost, error),
  });
}

/** ImapFlow swallows command/socket errors into false or undefined, never an empty UID set. */
export const searchUids = Effect.fnUntraced(function* (
  s: ImapConnection,
  query: Parameters<ImapFlow["search"]>[0],
) {
  const found = yield* call(s, (client) => client.search(query, { uid: true }));
  if (found === false || found === undefined)
    return yield* new ProviderError({ message: `${s.settings.imapHost}: IMAP UID SEARCH failed` });
  return found;
});

/** LIST omission alone can mean a hidden/unselectable folder or an incomplete listing. */
export const confirmFolderGone = Effect.fnUntraced(function* (s: ImapConnection, path: string) {
  const absent = yield* call(s, async (client) => {
    try {
      await client.status(path, { uidValidity: true });
      return false;
    } catch (error) {
      // ImapFlow emits NotFound only after STATUS NO plus an empty exact-path LIST.
      if (Predicate.isObject(error) && "code" in error && error.code === "NotFound") return true;
      throw error;
    }
  });
  if (!absent) return false;
  const listed = yield* call(s, (client) => client.list({ listOnly: true }));
  return !listed.some((folder) => folder.path === path);
});

export function smtpTransport(
  accountId: string,
  settings: ImapSettings,
  password: string,
  onDataSent?: () => void,
) {
  return Effect.acquireRelease(
    Effect.map(
      load(accountId, settings.smtpHost, () => import("nodemailer")),
      ({ createTransport }) =>
        createTransport({
          host: settings.smtpHost,
          port: settings.smtpPort,
          secure: settings.smtpSecure,
          requireTLS: !settings.smtpSecure,
          auth: { user: settings.username, pass: password },
          connectionTimeout: 20_000,
          // Nodemailer emits this after its dot-stuffed DATA stream, including the terminator, ends.
          // Consume only the phase marker; never log protocol bodies or credentials.
          logger: {
            trace: ignore,
            debug: ignore,
            info: (data: unknown) => {
              if (
                Predicate.isObject(data) &&
                "tnx" in data &&
                data.tnx === "message" &&
                "outByteCount" in data
              )
                onDataSent?.();
            },
            warn: ignore,
            error: ignore,
            fatal: ignore,
          },
        }),
    ),
    (transport) => Effect.sync(() => transport.close()),
  );
}

export const password = (secrets: Secrets["Service"], account: Account) =>
  secrets.get(account.id).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.fail(
            new AuthError({
              accountId: account.id,
              message: "No stored password. Add the account again.",
              reason: "keychain_missing",
            }),
          ),
        onSome: Effect.succeed,
      }),
    ),
  );

export const settingsOf = (account: Account) =>
  account.imap
    ? Effect.succeed(account.imap)
    : Effect.fail(
        new AuthError({
          accountId: account.id,
          message: "The account has no IMAP settings. Add it again.",
          // Adding the account again is the fix, the same as for a refused login.
          reason: "imap_auth_failed",
        }),
      );

export const connect = Effect.fnUntraced(function* (input: ConnectInput) {
  if (input.provider !== "imap") {
    return yield* new InvalidInput({ message: `Not an IMAP sign-in: ${input.provider}` });
  }
  const settings = yield* resolveImapSettings(input.input);
  const email = input.input.email.trim();
  const accountId = `imap:${email.toLowerCase()}`;
  const { password: pass } = input.input;
  const s = yield* openImap(accountId, settings, pass);
  yield* call(s, (c) => c.noop());
  const transport = yield* smtpTransport(accountId, settings, pass);
  yield* Effect.tryPromise({
    try: () => transport.verify(),
    catch: (error) => failure(accountId, settings.smtpHost, error),
  });
  return { email, secret: pass, imap: settings };
}, Effect.scoped);
