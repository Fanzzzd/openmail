import { Effect, Option, Schema } from "effect";
import type { SqlClient } from "effect/sql";
import { InvalidInput } from "./errors.js";
import { all, run } from "./sql-rows.js";

/**
 * Remote access settings: whether the Mac publishes OpenMail to the owner's
 * tailnet through Tailscale Serve, and which tailnet logins may use it. Stored
 * in the prefs table under one key, without a migration. Off by default.
 */
export const RemoteAccessSettings = Schema.Struct({
  enabled: Schema.Boolean,
  /** Tailnet login names (user@provider) that may sign in. */
  allowlist: Schema.Array(Schema.String),
  /** True once this Mac's own tailnet login was added, so an emptied list stays empty. */
  ownerSeeded: Schema.Boolean,
  /** The 127.0.0.1 port of the local server; 0 until first chosen. Reused so the serve mapping stays recognisable. */
  port: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 65_535 })),
  /** Optional Tailscale Service (svc:name) instead of a port on this node. Empty for none. */
  service: Schema.String,
});
export type RemoteAccessSettings = typeof RemoteAccessSettings.Type;

export const DEFAULT_REMOTE_ACCESS: RemoteAccessSettings = {
  enabled: false,
  allowlist: [],
  ownerSeeded: false,
  port: 0,
  service: "",
};

const MAX_LOGINS = 64;
const SERVICE = /^svc:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
// Tailscale login names look like user@example.com or user@github.
const LOGIN = /^[^\s@,;<>"'`\\]{1,128}@[^\s@,;<>"'`\\]{1,128}$/u;

export const sameLogin = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Trims and checks the settings; duplicate logins collapse case-insensitively. */
export function normalizeRemoteAccess(
  input: RemoteAccessSettings,
): Effect.Effect<RemoteAccessSettings, InvalidInput> {
  const service = input.service.trim().toLowerCase();
  if (service && !SERVICE.test(service))
    return Effect.fail(new InvalidInput({ message: "Use a service name such as svc:openmail" }));
  const allowlist: string[] = [];
  for (const raw of input.allowlist) {
    const login = raw.trim();
    // oxlint-disable-next-line no-control-regex
    if (!LOGIN.test(login) || /[\u0000-\u001f\u007f]/.test(login))
      return Effect.fail(
        new InvalidInput({ message: "Enter a tailnet login such as name@github" }),
      );
    if (!allowlist.some((existing) => sameLogin(existing, login))) allowlist.push(login);
  }
  if (allowlist.length > MAX_LOGINS)
    return Effect.fail(new InvalidInput({ message: "Too many tailnet logins" }));
  return Effect.succeed({ ...input, service, allowlist });
}

const KEY = "remote-access:settings";
const Row = Schema.Struct({ value_json: Schema.String });

/** The Store's SQL for remote access settings. */
export function makeRemoteAccessStore(sql: SqlClient.SqlClient) {
  const remoteAccess = all(Row)(sql`SELECT value_json FROM prefs WHERE key=${KEY}`).pipe(
    Effect.map((rows) =>
      Option.getOrElse(
        Schema.decodeUnknownOption(Schema.fromJsonString(RemoteAccessSettings))(
          rows[0]?.value_json,
        ),
        () => DEFAULT_REMOTE_ACCESS,
      ),
    ),
  );
  const setRemoteAccess = (settings: RemoteAccessSettings) =>
    run(sql`INSERT INTO prefs (key,value_json) VALUES (${KEY},${JSON.stringify(settings)})
      ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json`);
  return { remoteAccess, setRemoteAccess };
}
