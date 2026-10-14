/** config, accounts and spaces: OAuth clients, signing in and account groups (Profile in core). */

import { Argument, Command, Flag, Prompt } from "effect/cli";
import { Config, Console, Effect, Option, Redacted } from "effect";
import { IMAP_PRESETS, Mailbox, PROFILE_COLORS, oauthProvider } from "@openmail/core";
import { CLI, type Failed, fail, jsonFlag, optionalString, optionalInt, print } from "./common.js";
import { accountTable, outcomeText } from "../format.js";
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
    const mailbox = yield* Mailbox;
    let account;
    if (!oauthProvider(o.provider)) {
      const preset = Option.getOrUndefined(o.preset);
      if (!preset) return yield* fail(`--preset is required for imap: ${presetNames.join(", ")}`);
      if (!presetNames.includes(preset)) {
        return yield* fail(`Unknown preset ${preset}. Use one of ${presetNames.join(", ")}.`);
      }
      const email = Option.isSome(o.email)
        ? o.email.value
        : yield* Prompt.run(Prompt.String({ message: "Email address" }));
      const hint = IMAP_PRESETS[preset];
      if (hint?.note) yield* Console.error(hint.note);
      if (hint?.appPasswordUrl) yield* Console.error(hint.appPasswordUrl);
      const fromEnv = yield* Config.option(Config.Redacted("OPENMAIL_IMAP_PASSWORD"));
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
    if (!account)
      return yield* fail(`No account with id ${id}. Run \`openmail accounts list\` to see them.`);
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
    const account = yield* mailbox.accounts.reauth(id);
    yield* Console.log(`Signed in ${account.id} again.`);
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
            .map((p) => `${p.icon} ${p.name}  ${p.id}\n      ${p.accounts.join(", ") || "(empty)"}`)
            .join("\n")
        : "(no spaces; run `openmail spaces add <name>`)",
    );
  }),
).pipe(Command.withDescription("List spaces and their accounts"));

const profilesAdd = Command.make(
  "add",
  {
    name: Argument.String("name").pipe(Argument.withDescription("The space name, such as Work")),
    icon: Flag.String("icon").pipe(
      Flag.withDescription("Icon on the switcher"),
      Flag.withDefault("📁"),
    ),
    color: Flag.Literals("color", PROFILE_COLORS).pipe(
      Flag.withDescription("Color on the switcher"),
      Flag.withDefault("blue"),
    ),
  },
  Effect.fn(function* ({ name, icon, color }) {
    const mailbox = yield* Mailbox;
    // Spaces are found by name in any letter case, so two with one name could not be told apart.
    const taken = (yield* mailbox.accounts.profiles).find(
      (space) => space.name.trim().toLowerCase() === name.trim().toLowerCase(),
    );
    if (taken)
      yield* fail(`A space named ${taken.name} already exists (${taken.id}).`, {
        code: "invalid_input",
        hint: "Choose another name. `openmail spaces list` shows the spaces.",
      });
    const p = yield* mailbox.accounts.createProfile({ name, icon, color });
    yield* Console.log(`Added space ${p.name} (${p.id}).`);
  }),
).pipe(Command.withDescription("Create a space"));

/** A space by id, or by name when exactly one space has it (any letter case). */
const findSpace = (idOrName: string) =>
  Effect.gen(function* () {
    const spaces = yield* (yield* Mailbox).accounts.profiles;
    const byId = spaces.find((p) => p.id === idOrName);
    if (byId) return byId;
    const named = spaces.filter((p) => p.name.toLowerCase() === idOrName.toLowerCase());
    if (named.length === 1 && named[0]) return named[0];
    return yield* fail(
      named.length > 1
        ? `${named.length} spaces are named ${idOrName}. Pass the space id; \`openmail spaces list\` shows them.`
        : `No space with id or name ${idOrName}. Run \`openmail spaces list\` to see them.`,
    );
  });

const spaceArgument = (description: string) =>
  Argument.String("space").pipe(Argument.withDescription(description));

const profilesRemove = Command.make(
  "remove",
  { space: spaceArgument("Space id or name") },
  Effect.fn(function* ({ space }) {
    const mailbox = yield* Mailbox;
    const found = yield* findSpace(space);
    yield* mailbox.accounts.deleteProfile(found.id);
    yield* Console.log(`Removed space ${found.name} (${found.id}).`);
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
      return yield* fail(
        `No account with id ${accountId}. Run \`openmail accounts list\` to see them.`,
      );
    const found = space === "none" ? null : yield* findSpace(space);
    yield* mailbox.accounts.assignProfile(accountId, found?.id ?? null);
    return yield* Console.log(
      found ? `Moved ${accountId} to ${found.name}.` : `Removed ${accountId} from its space.`,
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
