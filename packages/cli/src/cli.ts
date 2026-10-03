#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
/**
 * The openmail command line. Every action goes through core's Mailbox as
 * user:cli, so policy and audit hold here too. There is no send command:
 * sending needs the review window in the app.
 */
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import {
  type Actor,
  IMAP_PRESETS,
  MAILBOXES,
  Mailbox,
  AgentIdentity,
  MailToolkit,
  MailToolkitLayer,
  ReadMailToolkit,
  ProposalMailToolkit,
  NodeMailbox,
  PROFILE_COLORS,
  redactSyncHealth,
} from "@openmail/core";
import {
  Config,
  Console,
  Data,
  Effect,
  Layer,
  Logger,
  Option,
  Redacted,
  Runtime,
  Schema,
  Stream,
} from "effect";
import { Tool } from "effect/ai";
import { Argument, CliError, Command, Flag, Prompt } from "effect/cli";

import {
  accountTable,
  auditTable,
  commandSummary,
  messageText,
  outcomeText,
  proposalTable,
  syncTable,
} from "./format.js";
import { runMcp } from "./mcp-server.js";
import { withProgress } from "./sync-progress.js";
import { CliBrowser } from "./open-url.js";

const CLI: Actor = { kind: "user", surface: "cli" };

/** A failure already explained to the person on stderr; exits with code 1. */
class Failed extends Data.TaggedError("Failed")<{ readonly message: string }> {
  readonly [Runtime.errorReported] = false;
}

const fail = (message: string) => Effect.fail(new Failed({ message }));

const jsonFlag = Flag.Boolean("json").pipe(
  Flag.withDescription("Print machine-readable JSON"),
  Flag.withDefault(false),
);

const print = <A>(data: A, asJson: boolean, human: (data: A) => string) =>
  Console.log(asJson ? JSON.stringify(data, null, 2) : human(data));

// config

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
  Command.withDescription("Store OAuth client registrations"),
  Command.withSubcommands([configGoogle, configMicrosoft]),
);

// accounts

const accountsList = Command.make(
  "list",
  { json: jsonFlag },
  Effect.fn(function* ({ json }) {
    const mailbox = yield* Mailbox;
    yield* print(yield* mailbox.accounts, json, accountTable);
  }),
).pipe(Command.withDescription("List connected accounts"));

const optionalString = (name: string, description: string) =>
  Flag.String(name).pipe(Flag.withDescription(description), Flag.optional);
const optionalInt = (name: string, description: string) =>
  Flag.Int(name).pipe(Flag.withDescription(description), Flag.optional);

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
      outcomeText(outcome, `Removed ${id}, its local mail and its stored credentials.`),
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

// profiles

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
        : "(no profiles; run `openmail profiles add <name>`)",
    );
  }),
).pipe(Command.withDescription("List profiles and their accounts"));

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
    yield* Console.log(`Added profile ${p.name} (${p.id}).`);
  }),
).pipe(Command.withDescription("Create a profile"));

const profilesRemove = Command.make(
  "remove",
  { id: Argument.String("profile-id") },
  Effect.fn(function* ({ id }) {
    const mailbox = yield* Mailbox;
    yield* mailbox.deleteProfile(id);
    yield* Console.log(`Removed profile ${id}.`);
  }),
).pipe(Command.withDescription("Delete the profile; its accounts become ungrouped"));

const profilesAssign = Command.make(
  "assign",
  {
    accountId: Argument.String("account-id"),
    profileId: Argument.String("profile-id").pipe(
      Argument.withDescription('Profile id, or "none" to ungroup'),
    ),
  },
  Effect.fn(function* ({ accountId, profileId }) {
    const mailbox = yield* Mailbox;
    yield* mailbox.assignProfile(accountId, profileId === "none" ? null : profileId);
    yield* Console.log(`Moved ${accountId}.`);
  }),
).pipe(Command.withDescription("Put an account in a profile"));

const profiles = Command.make("profiles").pipe(
  Command.withDescription("Group accounts into profiles such as Work and Personal"),
  Command.withSubcommands([profilesList, profilesAdd, profilesRemove, profilesAssign]),
);

// mail
const health = Command.make(
  "health",
  {
    account: Flag.String("account").pipe(Flag.optional),
    json: jsonFlag,
  },
  Effect.fn(function* ({ account, json }) {
    yield* Console.error("Reading credentials from the keychain…");
    const mailbox = yield* Mailbox;
    const ids = Option.isSome(account)
      ? [account.value]
      : (yield* mailbox.accounts).map((item) => item.id);
    const reports = yield* Effect.forEach(ids, (id) =>
      mailbox.syncHealth(id).pipe(Effect.map(redactSyncHealth)),
    );
    yield* print(reports, json, (items) =>
      items
        .map((report) =>
          [
            `${report.provider} ${report.accountDomainHash}`,
            `Cursor age: ${report.cursorAgeMs === null ? "never synced" : `${report.cursorAgeMs} ms`}; pending operations: ${report.pendingOps}`,
            "Folder\tServer total/unread/threads\tLocal total/unread/threads\tBody cache days\tHeader window\tPending\tVerdict",
            ...report.folders.map(
              (folder) =>
                `${folder.scope}\t${folder.server.kind === "available" ? `${folder.server.total}/${folder.server.unread}/${folder.server.threads ?? "—"}` : "unavailable"}\t${folder.local.total}/${folder.local.unread}/${folder.local.threads}\t${folder.bodyCacheWindowDays ?? "all"}\t${folder.headerWindow ? `${folder.headerWindow.days} days, ${folder.headerWindow.messageLimit} messages` : "all"}\t${folder.pendingOps}\t${folder.verdict}`,
            ),
          ].join("\n"),
        )
        .join("\n\n"),
    );
  }),
).pipe(Command.withDescription("Compare cached messages with read-only server counts"));

const sync = Command.make(
  "sync",
  {
    account: Argument.String("account").pipe(
      Argument.withDescription("Only this account"),
      Argument.optional,
    ),
    json: jsonFlag,
    budget: Flag.Int("token-budget").pipe(
      Flag.withDescription("UTF-8 JSON budget, 2000 to 24000 bytes"),
      Flag.withDefault(12000),
    ),
  },
  Effect.fn(function* ({ account, json, budget }) {
    const encoded = yield* withProgress(
      invokeTool("sync", {
        ...(Option.isSome(account) ? { account_id: account.value } : {}),
        token_budget: budget,
      }),
      !json,
    );
    const result = yield* Schema.decodeUnknownEffect(MailToolkit.tools.sync.successSchema)(encoded);
    yield* print(
      result,
      json,
      (value) =>
        `${syncTable(value.results)}${value.omitted ? `\n${value.omitted} account results omitted; sync an account id to inspect.` : ""}`,
    );
    return yield* result.results.some((r) => r.error)
      ? fail("Some accounts did not sync.")
      : Effect.void;
  }),
).pipe(Command.withDescription("Push queued changes, then fetch changes into the local database"));

const limitFlag = Flag.Int("limit").pipe(
  Flag.withDescription("Max threads"),
  Flag.withDefault(20),
  Flag.filter(
    (n) => n > 0 && n <= 100,
    () => "must be between 1 and 100",
  ),
);

const list = Command.make(
  "list",
  {
    mailbox: Flag.Literals("mailbox", MAILBOXES).pipe(Flag.withDefault("inbox")),
    account: optionalString("account", "Only this account"),
    profile: optionalString("profile", "Only accounts in this profile"),
    label: optionalString("label", "Only threads with this label or folder id"),
    unread: Flag.Boolean("unread").pipe(
      Flag.withDescription("Unread only"),
      Flag.withDefault(false),
    ),
    limit: limitFlag,
    before: optionalInt("before", "Legacy page boundary; use --cursor to preserve same-date rows"),
    cursor: optionalString("cursor", "next_cursor from the preceding page"),
    budget: Flag.Int("token-budget").pipe(Flag.withDefault(12000)),
    json: jsonFlag,
  },
  Effect.fn(function* (o) {
    const result = yield* invokeTool("list_threads", {
      mailbox: o.mailbox,
      ...(Option.isSome(o.account) ? { account_id: o.account.value } : {}),
      ...(Option.isSome(o.profile) ? { profile_id: o.profile.value } : {}),
      ...(Option.isSome(o.label) ? { label: o.label.value } : {}),
      unread_only: o.unread,
      ...(Option.isSome(o.before) ? { before: o.before.value } : {}),
      ...(Option.isSome(o.cursor) ? { cursor: o.cursor.value } : {}),
      limit: o.limit,
      token_budget: o.budget,
    });
    return yield* print(result, o.json, (value) => JSON.stringify(value, null, 2));
  }),
).pipe(Command.withDescription("List conversations in a mailbox, newest first"));

const search = Command.make(
  "search",
  {
    query: Argument.String("query").pipe(Argument.variadic({ min: 1 })),
    account: optionalString("account", "Only this account"),
    limit: limitFlag,
    cursor: optionalString("cursor", "next_cursor from the preceding page"),
    budget: Flag.Int("token-budget").pipe(Flag.withDefault(12000)),
    server: Flag.Boolean("server").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Fetch provider search hits; report unsupported operators and failures"),
    ),
    json: jsonFlag,
  },
  Effect.fn(function* (o) {
    const result = yield* invokeTool("search", {
      query: o.query.join(" "),
      ...(Option.isSome(o.account) ? { account_id: o.account.value } : {}),
      limit: o.limit,
      ...(Option.isSome(o.cursor) ? { cursor: o.cursor.value } : {}),
      token_budget: o.budget,
      server: o.server,
    });
    yield* print(result, o.json, (value) => JSON.stringify(value, null, 2));
  }),
).pipe(Command.withDescription(MailToolkit.tools.search.description ?? "Search mail"));

const show = Command.make(
  "show",
  {
    id: Argument.String("message-id"),
    thread: Flag.Boolean("thread").pipe(
      Flag.withDescription("Print every message in the thread"),
      Flag.withDefault(false),
    ),
    html: Flag.Boolean("html").pipe(
      Flag.withDescription("Include the HTML body in JSON output"),
      Flag.withDefault(false),
    ),
    json: jsonFlag,
  },
  Effect.fn(function* (o) {
    const mailbox = yield* Mailbox;
    const all = yield* mailbox.thread(o.id);
    const picked = o.thread ? all : all.filter((m) => m.id === o.id);
    const messages = picked.map((m) => (o.html ? m : { ...m, bodyHtml: undefined }));
    yield* print(o.thread ? messages : messages[0], o.json, () =>
      picked.map(messageText).join(`\n\n${"─".repeat(60)}\n\n`),
    );
  }),
).pipe(Command.withDescription("Print a message as plain text, or its whole thread"));

// proposals, agents, audit

const proposalsList = Command.make(
  "list",
  { json: jsonFlag },
  Effect.fn(function* ({ json }) {
    const mailbox = yield* Mailbox;
    yield* print(yield* mailbox.proposals, json, proposalTable);
  }),
).pipe(Command.withDescription("List changes agents asked for that wait for a person"));

const proposalId = Argument.Int("proposal-id");

const proposalsApprove = Command.make(
  "approve",
  { id: proposalId },
  Effect.fn(function* ({ id }) {
    const mailbox = yield* Mailbox;
    const proposal = (yield* mailbox.proposals).find((p) => p.id === id);
    if (proposal && (proposal.command.kind === "send" || proposal.command.kind === "draft")) {
      return yield* fail(
        `Proposal ${id} is a message (${commandSummary(proposal.command)}). Open openmail to review and send it; the CLI does not send mail.`,
      );
    }
    const outcome = yield* mailbox.decideProposal(id, true, "cli");
    return yield* Console.log(outcomeText(outcome, `Approved proposal ${id}.`));
  }),
).pipe(Command.withDescription("Approve a proposed change; it runs as you (user:cli)"));

const proposalsReject = Command.make(
  "reject",
  { id: proposalId },
  Effect.fn(function* ({ id }) {
    const mailbox = yield* Mailbox;
    yield* mailbox.decideProposal(id, false, "cli");
    yield* Console.log(`Rejected proposal ${id}.`);
  }),
).pipe(Command.withDescription("Reject a proposed change"));

const proposals = Command.make("proposals").pipe(
  Command.withDescription("Review what agents asked to change"),
  Command.withSubcommands([proposalsList, proposalsApprove, proposalsReject]),
);

const writeMode = Command.make(
  "write-mode",
  {
    mode: Argument.Literals("mode", ["off", "propose", "allow"]).pipe(
      Argument.withDescription(
        "off: MCP cannot propose changes or drafts. propose: changes wait for approval. allow: rules can organize directly; MCP always proposes for approval in the app",
      ),
      Argument.optional,
    ),
  },
  Effect.fn(function* ({ mode }) {
    const mailbox = yield* Mailbox;
    if (Option.isSome(mode)) {
      yield* mailbox.setAgentWriteMode(mode.value);
      yield* Console.log(`Agent write mode: ${mode.value}.`);
    } else {
      yield* Console.log(`Agent write mode: ${yield* mailbox.agentWriteMode}.`);
    }
    yield* Console.log(
      "MCP always proposes changes for approval in the app. MCP drafts require a mode other than Read only. Sending requires confirmation in the app.",
    );
  }),
).pipe(Command.withDescription("Show or set whether agents may change mail (Settings > AI 权限)"));

const agents = Command.make("agents").pipe(
  Command.withDescription("Permissions for MCP clients and other agents"),
  Command.withSubcommands([writeMode]),
);

const audit = Command.make(
  "audit",
  {
    limit: Flag.Int("limit").pipe(Flag.withDescription("Max entries"), Flag.withDefault(50)),
    json: jsonFlag,
  },
  Effect.fn(function* ({ limit, json }) {
    const mailbox = yield* Mailbox;
    yield* print(yield* mailbox.audit(limit), json, auditTable);
  }),
).pipe(Command.withDescription("Show recent changes and who made them"));

const mcp = Command.make(
  "mcp",
  {
    allowWrites: Flag.Boolean("allow-writes").pipe(
      Flag.withDescription(
        "Expose proposal tools; app AI permission still required. All approvals happen in the app.",
      ),
      Flag.withDefault(false),
    ),
  },
  ({ allowWrites }) => runMcp(allowWrites),
).pipe(Command.withDescription("Run the MCP server on stdio (same as `openmail-mcp`)"));

type ToolName = keyof typeof MailToolkit.tools;
const toolNames = Object.keys(MailToolkit.tools).filter(
  (name): name is ToolName => name in MailToolkit.tools,
);
const isWriteTool = (name: ToolName) => name in ProposalMailToolkit.tools;
const toolHandlers = MailToolkitLayer.pipe(
  Layer.provide(AgentIdentity.fixed("mcp", "openmail-cli")),
);
function invokeTool(name: ToolName, input: unknown) {
  return Effect.gen(function* () {
    const parameters = yield* Schema.decodeUnknownEffect(
      Schema.toEncoded(MailToolkit.tools[name].parametersSchema),
    )(input);
    const toolkit = yield* MailToolkit;
    const stream = yield* toolkit.handle(name, parameters);
    const last = yield* Stream.runLast(stream);
    if (Option.isNone(last)) return yield* fail("The tool returned no result.");
    if (last.value.isFailure) return yield* fail(JSON.stringify(last.value.encodedResult));
    return last.value.encodedResult;
  }).pipe(Effect.provide(toolHandlers));
}
const toolInput = Flag.String("input-json").pipe(
  Flag.withDescription("Tool parameters as a JSON object. Use tools --json for schemas."),
  Flag.withDefault("{}"),
);
const allowWritesFlag = Flag.Boolean("allow-writes").pipe(
  Flag.withDescription(
    "Permit creating proposals only; app AI write permission required. No approval or send.",
  ),
  Flag.withDefault(false),
);
const tools = Command.make(
  "tools",
  { json: jsonFlag, allowWrites: allowWritesFlag },
  Effect.fn(function* ({ json, allowWrites }) {
    const rows = Object.values(allowWrites ? MailToolkit.tools : ReadMailToolkit.tools).map(
      (tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: Tool.getJsonSchema(tool),
      }),
    );
    yield* print(rows, json, (all) =>
      all.map((row) => `${row.name}: ${row.description}`).join("\n"),
    );
  }),
).pipe(
  Command.withDescription("List agent tools and their exact input schemas. Read-only by default."),
);
const tool = Command.make(
  "tool",
  {
    name: Argument.Literals("name", toolNames),
    input: toolInput,
    json: jsonFlag,
    allowWrites: allowWritesFlag,
  },
  Effect.fn(function* ({ name, input, json, allowWrites }) {
    if (isWriteTool(name) && !allowWrites)
      return yield* fail("Proposal tools require --allow-writes and app AI write permission.");
    const parsed = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(input);
    const result = yield* invokeTool(name, parsed);
    return yield* print(result, json, (value) => JSON.stringify(value, null, 2));
  }),
).pipe(
  Command.withDescription(
    "Call any agent tool through the shared core Toolkit. Parameters are validated against tools --json; results honor cursors and byte budgets.",
  ),
  Command.withExamples([
    { command: "openmail tool list_templates --json", description: "List template ids" },
    {
      command: `openmail tool read_thread --input-json '{"id":"gmail:me@example.com/m1"}' --json`,
      description: "Read bounded plain-text model context",
    },
  ]),
);

// A named command for each tool keeps --help and the CLI aligned with core descriptions.
const agentCommands = toolNames
  .filter((name) => name !== "sync" && name !== "search")
  .map((name) =>
    Command.make(
      name.replaceAll("_", "-"),
      { input: toolInput, json: jsonFlag, allowWrites: allowWritesFlag },
      Effect.fn(function* ({ input, json, allowWrites }) {
        if (isWriteTool(name) && !allowWrites)
          return yield* fail("Proposal tools require --allow-writes and app AI write permission.");
        const parsed = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(
          input,
        );
        return yield* print(yield* invokeTool(name, parsed), json, (value) =>
          JSON.stringify(value, null, 2),
        );
      }),
    ).pipe(Command.withDescription(MailToolkit.tools[name].description ?? name)),
  );

const openmail = Command.make("openmail").pipe(
  Command.withDescription(
    "Local-first mail for people and models. Reads come from the local database; `openmail sync` refreshes it.",
  ),
  Command.withSubcommands([
    config,
    accounts,
    profiles,
    sync,
    health,
    list,
    search,
    show,
    proposals,
    agents,
    audit,
    mcp,
    tools,
    tool,
    ...agentCommands,
  ]),
);

/** Turns Mailbox errors into one line on stderr. CLI parse errors are already printed. */
function explain(error: unknown): string | undefined {
  if (CliError.isCliError(error) || !(error instanceof Error)) return undefined;
  if (!("_tag" in error)) return error.message;
  switch (error._tag) {
    case "NotFound":
      return "what" in error && "id" in error
        ? `No ${String(error.what)} with id ${String(error.id)}.`
        : error.message;
    case "ClientNotConfigured":
      return "No OAuth client is set up for this provider. Run `openmail config google` or `openmail config microsoft` (see docs/setup-*.md).";
    case "AuthError":
      return `Sign-in failed: ${error.message}`;
    case "ProviderError":
      return `The mail provider did not answer: ${error.message}`;
    case "QuitError":
      return "Cancelled.";
    default:
      return error.message;
  }
}

Command.run(openmail, { version: "0.1.0" }).pipe(
  Effect.catch((error) => {
    const message = explain(error);
    return message === undefined
      ? Effect.fail(error)
      : Console.error(`error: ${message}`).pipe(
          Effect.andThen(Effect.fail(new Failed({ message }))),
        );
  }),
  Effect.provide(
    Layer.mergeAll(
      // A CLI run ends right after the command, so queue pushes happen before it returns.
      NodeMailbox({
        browser: CliBrowser.pipe(Layer.provide(NodeServices.layer)),
        backgroundFlush: false,
        beforeCredentialRead: Console.error("Reading credentials from the keychain…"),
      }),
      NodeServices.layer,
    ),
  ),
  Effect.provideService(Logger.LogToStderr, true),
  NodeRuntime.runMain,
);
