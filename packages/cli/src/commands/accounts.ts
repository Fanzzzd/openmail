/** config, accounts and spaces: OAuth clients, signing in and account groups (Profile in core). */

import { Argument, Command, Flag, Prompt } from "effect/cli";
import { Config, Console, Effect, Option, Redacted } from "effect";
import {
  IMAP_PRESETS,
  Mailbox,
  isImapHostname,
  PROFILE_COLORS,
  oauthProvider,
  printable,
} from "@openmail/core";
import {
  CLI,
  type Failed,
  fail,
  findSpace,
  jsonFlag,
  noAccount,
  optionalString,
  optionalInt,
  print,
} from "./common.js";
import { accountTable, outcomeText, signInCommand, signsInByAdding } from "../format.js";
import { withProgress } from "../sync-progress.js";

const configGoogle = Command.make(
  "google",
  {
    clientId: Flag.String("client-id").pipe(
      Flag.withDescription("Client ID of your Desktop app OAuth client in Google Cloud"),
    ),
    clientSecret: Flag.String("client-secret").pipe(
      Flag.withDescription("Client secret of the same OAuth client"),
    ),
  },
  Effect.fn(function* ({ clientId, clientSecret }) {
    const mailbox = yield* Mailbox;
    yield* mailbox.accounts.setClient({ google: { clientId, clientSecret } });
    yield* Console.log("Saved Google OAuth client.");
  }),
).pipe(Command.withDescription("Set the Google OAuth desktop client (docs/setup-google.md)"));

const configMicrosoft = Command.make(
  "microsoft",
  {
    clientId: Flag.String("client-id").pipe(
      Flag.withDescription("Application (client) ID of your Azure app registration"),
    ),
  },
  Effect.fn(function* ({ clientId }) {
    const mailbox = yield* Mailbox;
    yield* mailbox.accounts.setClient({ microsoft: { clientId } });
    yield* Console.log("Saved Microsoft OAuth client.");
  }),
).pipe(
  Command.withDescription("Set the Microsoft (Azure) public client (docs/setup-microsoft.md)"),
);

const config = Command.make("config").pipe(
  Command.withDescription(
    "Store your own OAuth client registrations, which win over the built-in ones",
  ),
  Command.withSubcommands([configGoogle, configMicrosoft]),
);

const accountsList = Command.make(
  "list",
  { json: jsonFlag },
  Effect.fn(function* ({ json }) {
    const mailbox = yield* Mailbox;
    yield* print(yield* mailbox.accounts.accounts, json, accountTable);
  }),
).pipe(Command.withDescription("List connected accounts"));

const presetNames = [...Object.keys(IMAP_PRESETS), "custom"];

const validPort = (port: number) => Number.isInteger(port) && port >= 1 && port <= 65535;
const validEmail = (email: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

/** The first imap flag that can be checked without the network, as a message; undefined if all pass. */
const badImapFlag = (o: {
  readonly email: Option.Option<string>;
  readonly imapPort: Option.Option<number>;
  readonly smtpPort: Option.Option<number>;
  readonly imapHost: Option.Option<string>;
  readonly smtpHost: Option.Option<string>;
}): { readonly message: string; readonly hint?: string } | undefined => {
  if (Option.isSome(o.email) && !validEmail(o.email.value))
    return { message: `--email ${o.email.value} is not an email address.` };
  for (const [flag, port] of [
    ["--imap-port", o.imapPort],
    ["--smtp-port", o.smtpPort],
  ] as const)
    if (Option.isSome(port) && !validPort(port.value))
      return { message: `${flag} ${port.value} is not a port between 1 and 65535.` };
  for (const [flag, portFlag, host] of [
    ["--imap-host", "--imap-port", o.imapHost],
    ["--smtp-host", "--smtp-port", o.smtpHost],
  ] as const)
    if (Option.isSome(host)) {
      if (host.value.trim() === "") return { message: `${flag} is empty.` };
      if (!isImapHostname(host.value))
        return {
          message: `${flag} ${host.value} is not a hostname.`,
          ...(host.value.includes(":") ? { hint: `Pass the port with ${portFlag}.` } : {}),
        };
    }
  return undefined;
};

/** The flags only imap reads, with the names the person typed. */
const imapOnlyFlags = (o: {
  readonly preset: Option.Option<string>;
  readonly email: Option.Option<string>;
  readonly username: Option.Option<string>;
  readonly password: Option.Option<unknown>;
  readonly imapHost: Option.Option<string>;
  readonly imapPort: Option.Option<number>;
  readonly smtpHost: Option.Option<string>;
  readonly smtpPort: Option.Option<number>;
  readonly smtpSecure: Option.Option<boolean>;
}) =>
  (
    [
      ["--preset", o.preset],
      ["--email", o.email],
      ["--username", o.username],
      ["--password", o.password],
      ["--imap-host", o.imapHost],
      ["--imap-port", o.imapPort],
      ["--smtp-host", o.smtpHost],
      ["--smtp-port", o.smtpPort],
      ["--smtp-secure", o.smtpSecure],
    ] as const
  )
    .filter(([, value]) => Option.isSome(value))
    .map(([flag]) => flag);

const accountsAdd = Command.make(
  "add",
  {
    provider: Argument.Literals("provider", ["gmail", "outlook", "imap"]).pipe(
      Argument.withDescription("gmail, outlook or imap"),
    ),
    preset: optionalString("preset", `imap: ${presetNames.join(", ")}`),
    email: optionalString("email", "imap: the address to sign in with"),
    username: optionalString("username", "imap: login name, if not the address"),
    password: Flag.Redacted("password").pipe(
      Flag.withDescription(
        "imap: app password. Prefer OPENMAIL_IMAP_PASSWORD or the prompt; flags end up in shell history",
      ),
      Flag.optional,
    ),
    imapHost: optionalString("imap-host", "imap: IMAP server (required for custom)"),
    imapPort: optionalInt("imap-port", "imap: IMAP port"),
    smtpHost: optionalString("smtp-host", "imap: SMTP server (required for custom)"),
    smtpPort: optionalInt("smtp-port", "imap: SMTP port"),
    smtpSecure: Flag.Boolean("smtp-secure").pipe(
      Flag.withDescription("imap: implicit TLS for SMTP (465); --no-smtp-secure for STARTTLS"),
      Flag.optional,
    ),
  },
  Effect.fn(function* (o) {
    if (oauthProvider(o.provider)) {
      const stray = imapOnlyFlags(o);
      if (stray.length > 0)
        return yield* fail(`${stray.join(", ")} only apply to imap, not ${o.provider}.`, {
          code: "invalid_input",
          hint: `Drop ${stray.length === 1 ? "that flag" : "those flags"}; ${o.provider} signs in in the browser.`,
        });
    }
    const mailbox = yield* Mailbox;
    let account;
    if (!oauthProvider(o.provider)) {
      const preset = Option.getOrUndefined(o.preset);
      if (!preset)
        return yield* fail(`--preset is required for imap: ${presetNames.join(", ")}`, {
          code: "invalid_input",
          hint: `Use one of ${presetNames.join(", ")}.`,
        });
      if (!presetNames.includes(preset)) {
        return yield* fail(`Unknown preset ${preset}.`, {
          code: "invalid_input",
          hint: `Use one of ${presetNames.join(", ")}.`,
        });
      }
      if (preset === "custom") {
        const missing = [
          Option.isNone(o.imapHost) && "--imap-host",
          Option.isNone(o.smtpHost) && "--smtp-host",
        ].filter((flag) => flag !== false);
        if (missing.length > 0) {
          return yield* fail(`--preset custom needs ${missing.join(" and ")}.`, {
            code: "invalid_input",
            hint: "Pass the IMAP and SMTP server hostnames, or choose a named preset.",
          });
        }
      }
      const badFlag = badImapFlag(o);
      if (badFlag)
        return yield* fail(badFlag.message, {
          code: "invalid_input",
          hint: badFlag.hint ?? "Fix the flag and run the command again.",
        });
      if (Option.isNone(o.email) && !process.stdin.isTTY) {
        return yield* fail("No --email and stdin is not a terminal, so there is nothing to ask.", {
          code: "invalid_input",
          hint: "Pass --email or run in a terminal.",
        });
      }
      const email = Option.isSome(o.email)
        ? o.email.value
        : yield* Prompt.run(Prompt.String({ message: "Email address" }));
      const hint = IMAP_PRESETS[preset];
      if (hint?.note) yield* Console.error(hint.note);
      if (hint?.appPasswordUrl) yield* Console.error(hint.appPasswordUrl);
      const fromEnv = yield* Config.option(Config.Redacted("OPENMAIL_IMAP_PASSWORD"));
      if (Option.isNone(o.password) && Option.isNone(fromEnv) && !process.stdin.isTTY) {
        return yield* fail("No app password to use and stdin is not a terminal.", {
          code: "invalid_input",
          hint: "Set OPENMAIL_IMAP_PASSWORD, pass --password or run in a terminal.",
        });
      }
      const password = Option.isSome(o.password)
        ? o.password.value
        : Option.isSome(fromEnv)
          ? fromEnv.value
          : yield* Prompt.run(Prompt.Password({ message: "App password" }));
      account = yield* mailbox.accounts.connect({
        provider: "imap",
        input: {
          preset,
          email,
          password: Redacted.value(password),
          ...(Option.isSome(o.username) ? { username: o.username.value } : {}),
          ...(Option.isSome(o.imapHost) ? { imapHost: o.imapHost.value } : {}),
          ...(Option.isSome(o.imapPort) ? { imapPort: o.imapPort.value } : {}),
          ...(Option.isSome(o.smtpHost) ? { smtpHost: o.smtpHost.value } : {}),
          ...(Option.isSome(o.smtpPort) ? { smtpPort: o.smtpPort.value } : {}),
          ...(Option.isSome(o.smtpSecure) ? { smtpSecure: o.smtpSecure.value } : {}),
        },
      });
    } else {
      account = yield* mailbox.accounts.connect({ provider: o.provider });
    }
    yield* Console.log(`Added ${account.id}. Syncing…`);
    const [result] = yield* withProgress(mailbox.sync.sync(account.id), true);
    if (result?.error) return yield* fail(result.error);
    return yield* Console.log(`Synced ${result?.changed ?? 0} messages.`);
  }),
).pipe(
  Command.withDescription(
    "Sign in and run the first sync. gmail and outlook open the browser; imap asks for an app password",
  ),
  Command.withExamples([
    { command: "openmail accounts add gmail", description: "Sign in with Google" },
    {
      command: "openmail accounts add imap --preset icloud --email me@icloud.com",
      description: "Add iCloud Mail; prompts for the app password",
    },
  ]),
);

const accountIdArgument = Argument.String("account-id").pipe(
  Argument.withDescription("An id from `openmail accounts list`"),
);

/** Why `accounts remove` stops when it cannot ask; the person reads it on stderr. */
export const REMOVE_NEEDS_YES =
  "Nothing was removed. `openmail accounts remove` deletes local mail, local drafts and the stored sign-in, so it asks first. stdin is not a terminal; pass --yes to remove without asking.";

/**
 * Whether `accounts remove` may go ahead: --yes, or a yes to the question on a terminal. Without
 * a terminal it cannot ask, so it fails instead of deleting.
 * @internal
 */
export const confirmRemoval = <E, R>(
  yes: boolean,
  interactive: boolean,
  ask: Effect.Effect<boolean, E, R>,
): Effect.Effect<void, E | Failed, R> =>
  yes
    ? Effect.void
    : interactive
      ? Effect.flatMap(ask, (confirmed) =>
          confirmed ? Effect.void : fail("Canceled. Nothing was removed."),
        )
      : fail(REMOVE_NEEDS_YES);

const accountsRemove = Command.make(
  "remove",
  {
    id: accountIdArgument,
    yes: Flag.Boolean("yes").pipe(
      Flag.withAlias("y"),
      Flag.withDescription("Remove without asking. Needed when stdin is not a terminal"),
      Flag.withDefault(false),
    ),
  },
  Effect.fn(function* ({ id, yes }) {
    const mailbox = yield* Mailbox;
    const account = (yield* mailbox.accounts.accounts).find((a) => a.id === id);
    if (!account) return yield* noAccount(id);
    yield* confirmRemoval(
      yes,
      process.stdin.isTTY,
      Prompt.run(
        Prompt.Confirm({
          message: `Remove ${account.email}? Its local mail, local drafts and stored sign-in are deleted.`,
          initial: false,
        }),
      ),
    );
    const outcome = yield* mailbox.organize.perform({ kind: "removeAccount", accountId: id }, CLI);
    return yield* Console.log(
      outcome.status === "applied" && outcome.warning === "keychain-item-left"
        ? `Removed ${id} and its local mail. The keychain refused to delete its stored sign-in: open Keychain Access and delete the "openmail" item for ${id}.`
        : outcomeText(outcome, `Removed ${id}, its local mail and its stored credentials.`),
    );
  }),
).pipe(
  Command.withDescription(
    "Delete the account, its local mail and its stored credentials. Asks first; --yes skips the question",
  ),
);

const accountsReauth = Command.make(
  "reauth",
  { id: accountIdArgument },
  Effect.fn(function* ({ id }) {
    const mailbox = yield* Mailbox;
    const known = (yield* mailbox.accounts.accounts).find((a) => a.id === id);
    if (!known) return yield* noAccount(id);
    if (signsInByAdding(id)) {
      return yield* fail("IMAP accounts sign in again by adding the address with a new password.", {
        code: "invalid_input",
        hint: `Run \`${signInCommand(id, known.imap)}\`.`,
      });
    }
    const account = yield* mailbox.accounts.reauth(id);
    return yield* Console.log(`Signed in ${account.id} again.`);
  }),
).pipe(Command.withDescription("Sign an account in again after its credentials stopped working"));

const accounts = Command.make("accounts").pipe(
  Command.withDescription("Manage mail accounts"),
  Command.withSubcommands([accountsList, accountsAdd, accountsRemove, accountsReauth]),
);

const profilesList = Command.make(
  "list",
  { json: jsonFlag },
  Effect.fn(function* ({ json }) {
    const mailbox = yield* Mailbox;
    const all = yield* mailbox.accounts.accounts;
    const rows = (yield* mailbox.accounts.profiles).map((p) => ({
      ...p,
      accounts: all.filter((a) => a.profileId === p.id).map((a) => a.id),
    }));
    yield* print(rows, json, (rs) =>
      rs.length
        ? rs
            .map(
              (p) =>
                `${printable(p.icon)} ${printable(p.name)}  ${p.id}\n      ${p.accounts.join(", ") || "(empty)"}`,
            )
            .join("\n")
        : "(no spaces; run `openmail spaces add <name>`)",
    );
  }),
).pipe(Command.withDescription("List spaces and their accounts"));

/**
 * The words the app's space editor shows for each color, then the stored keys, which older
 * scripts pass. Help lists only the app's words.
 */
type ProfileColor = (typeof PROFILE_COLORS)[number];
const COLOR_ALIASES: Readonly<Record<string, ProfileColor>> = {
  blue: "blue",
  purple: "violet",
  red: "rose",
  orange: "orange",
  brown: "amber",
  green: "emerald",
  teal: "teal",
  gray: "slate",
  grey: "slate",
  ...Object.fromEntries(PROFILE_COLORS.map((key) => [key, key])),
};
export const COLOR_WORDS = ["blue", "purple", "red", "orange", "brown", "green", "teal", "gray"];
export const profileColor = (word: string): ProfileColor | undefined => {
  const key = word.toLowerCase();
  return Object.hasOwn(COLOR_ALIASES, key) ? COLOR_ALIASES[key] : undefined;
};

const profilesAdd = Command.make(
  "add",
  {
    name: Argument.String("name").pipe(Argument.withDescription("The space name, such as Work")),
    icon: Flag.String("icon").pipe(
      Flag.withDescription("Icon on the switcher"),
      Flag.withDefault("📁"),
    ),
    color: Flag.String("color").pipe(
      Flag.withDescription(`Color on the switcher: ${COLOR_WORDS.join(", ")}`),
      Flag.withDefault("blue"),
      Flag.filterMap(
        (word) => Option.fromNullishOr(profileColor(word)),
        () => `must be one of ${COLOR_WORDS.join(", ")}`,
      ),
    ),
  },
  Effect.fn(function* ({ name, icon, color }) {
    // Core refuses blank names, `none` and a name another space has in any letter case.
    const p = yield* (yield* Mailbox).accounts.createProfile({ name, icon, color });
    yield* Console.log(`Added space ${printable(p.name)} (${p.id}).`);
  }),
).pipe(Command.withDescription("Create a space"));

const spaceArgument = (description: string) =>
  Argument.String("space").pipe(Argument.withDescription(description));

const profilesRemove = Command.make(
  "remove",
  { space: spaceArgument("Space id or name") },
  Effect.fn(function* ({ space }) {
    const mailbox = yield* Mailbox;
    const found = yield* findSpace(space);
    yield* mailbox.accounts.deleteProfile(found.id);
    yield* Console.log(`Removed space ${printable(found.name)} (${found.id}).`);
  }),
).pipe(Command.withDescription("Delete the space; its accounts become ungrouped"));

const profilesAssign = Command.make(
  "assign",
  {
    accountId: accountIdArgument,
    space: spaceArgument('Space id or name, or "none" to ungroup'),
  },
  Effect.fn(function* ({ accountId, space }) {
    const mailbox = yield* Mailbox;
    if (!(yield* mailbox.accounts.accounts).some((a) => a.id === accountId))
      return yield* noAccount(accountId);
    const found = space === "none" ? null : yield* findSpace(space);
    yield* mailbox.accounts.assignProfile(accountId, found?.id ?? null);
    return yield* Console.log(
      found
        ? `Moved ${accountId} to ${printable(found.name)}.`
        : `Removed ${accountId} from its space.`,
    );
  }),
).pipe(Command.withDescription("Put an account in a space"));

const spaceCommands = [profilesList, profilesAdd, profilesRemove, profilesAssign];
const spaces = Command.make("spaces").pipe(
  Command.withDescription("Group accounts into spaces such as Work and Personal"),
  Command.withSubcommands(spaceCommands),
);
/** The old name, still accepted so existing scripts keep working; help shows only spaces. */
const profiles = Command.make("profiles").pipe(
  Command.withDescription("Same as spaces"),
  Command.withSubcommands(spaceCommands),
  Command.unlisted,
);

/** @internal */
export const accountCommands = [config, accounts, spaces, profiles] as const;
