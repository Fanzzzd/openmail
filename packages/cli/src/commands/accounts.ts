/** config, accounts and spaces: OAuth clients, signing in and account groups (Profile in core). */

import { Argument, Command, Flag, Prompt } from "effect/cli";
import { Config, Console, Effect, Option, Redacted } from "effect";
import { IMAP_PRESETS, Mailbox, PROFILE_COLORS } from "@openmail/core";
import { CLI, fail, jsonFlag, optionalString, optionalInt, print } from "./common.js";
import { accountTable, outcomeText } from "../format.js";
import { withProgress } from "../sync-progress.js";

const configGoogle = Command.make(
  "google",
  {
    clientId: Flag.String("client-id"),
    clientSecret: Flag.String("client-secret"),
  },
  Effect.fn(function* ({ clientId, clientSecret }) {
    const mailbox = yield* Mailbox;
    yield* mailbox.setClient({ google: { clientId, clientSecret } });
    yield* Console.log("Saved Google OAuth client.");
  }),
).pipe(Command.withDescription("Set the Google OAuth desktop client (docs/setup-google.md)"));

const configMicrosoft = Command.make(
  "microsoft",
  { clientId: Flag.String("client-id") },
  Effect.fn(function* ({ clientId }) {
    const mailbox = yield* Mailbox;
    yield* mailbox.setClient({ microsoft: { clientId } });
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
    yield* print(yield* mailbox.accounts, json, accountTable);
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
    if (o.provider === "imap") {
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
      account = yield* mailbox.connect({
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
      account = yield* mailbox.connect({ provider: o.provider });
    }
    yield* Console.log(`Added ${account.id}. Syncing…`);
    const [result] = yield* withProgress(mailbox.sync(account.id), true);
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

const accountsRemove = Command.make(
  "remove",
  { id: Argument.String("account-id") },
  Effect.fn(function* ({ id }) {
    const mailbox = yield* Mailbox;
    const outcome = yield* mailbox.perform({ kind: "removeAccount", accountId: id }, CLI);
    yield* Console.log(
      outcome.status === "applied" && outcome.warning === "keychain-item-left"
        ? `Removed ${id} and its local mail. The keychain refused to delete its stored sign-in: open Keychain Access and delete the "openmail" item for ${id}.`
        : outcomeText(outcome, `Removed ${id}, its local mail and its stored credentials.`),
    );
  }),
).pipe(Command.withDescription("Delete the account, its local mail and its stored credentials"));

const accountsReauth = Command.make(
  "reauth",
  { id: Argument.String("account-id") },
  Effect.fn(function* ({ id }) {
    const mailbox = yield* Mailbox;
    const account = yield* mailbox.reauth(id);
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
    const all = yield* mailbox.accounts;
    const rows = (yield* mailbox.profiles).map((p) => ({
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
    name: Argument.String("name"),
    icon: Flag.String("icon").pipe(
      Flag.withDescription("Icon on the switcher"),
      Flag.withDefault("📁"),
    ),
    color: Flag.Literals("color", PROFILE_COLORS).pipe(Flag.withDefault("blue")),
  },
  Effect.fn(function* ({ name, icon, color }) {
    const mailbox = yield* Mailbox;
    const p = yield* mailbox.createProfile({ name, icon, color });
    yield* Console.log(`Added space ${p.name} (${p.id}).`);
  }),
).pipe(Command.withDescription("Create a space"));

const profilesRemove = Command.make(
  "remove",
  { id: Argument.String("space-id") },
  Effect.fn(function* ({ id }) {
    const mailbox = yield* Mailbox;
    yield* mailbox.deleteProfile(id);
    yield* Console.log(`Removed space ${id}.`);
  }),
).pipe(Command.withDescription("Delete the space; its accounts become ungrouped"));

const profilesAssign = Command.make(
  "assign",
  {
    accountId: Argument.String("account-id"),
    profileId: Argument.String("space-id").pipe(
      Argument.withDescription('Space id, or "none" to ungroup'),
    ),
  },
  Effect.fn(function* ({ accountId, profileId }) {
    const mailbox = yield* Mailbox;
    yield* mailbox.assignProfile(accountId, profileId === "none" ? null : profileId);
    yield* Console.log(`Moved ${accountId}.`);
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
