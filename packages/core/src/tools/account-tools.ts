/** Tools for accounts, AI access status, profiles and labels. */

import { Account, Label, Profile } from "../domain/account.js";
import { AgentWriteMode } from "../domain/command.js";
import { Effect, Schema } from "effect";
import {
  AccountId,
  CONSENT_SWITCH,
  MailToolError,
  appTool,
  mailTool,
  page,
  readOnly,
  toToolError,
} from "./tool-common.js";
import { PageParameters, PageResult, ToolInt, shortText } from "./tool-pages.js";
import { Tool } from "effect/ai";
import { CATEGORIES } from "../domain/message.js";
import type { HandlersFor, ToolContext } from "./tool-context.js";
import { cleanMcpClientName } from "./agent-identity.js";

export const toModelAccount = ({ id, provider, email, needsReauth }: Account) => ({
  id,
  provider,
  email,
  needsReauth,
});

const ModelAccount = Schema.Struct({
  id: Account.fields.id,
  provider: Account.fields.provider,
  email: Account.fields.email,
  needsReauth: Account.fields.needsReauth,
});

export const ListAccounts = readOnly(
  mailTool("list_accounts", {
    description:
      "List the mail accounts this client can read. Pass an id as account_id to the other tools. Page with next_cursor.",
    parameters: Schema.Struct(PageParameters),
    success: Schema.Struct({ ...PageResult, accounts: Schema.Array(ModelAccount) }),
    failure: MailToolError,
    failureMode: "return",
  }),
);

export const AccessStatus = readOnly(
  appTool("access_status", {
    description:
      "Report which accounts this client can read, how many are hidden and why, and whether it can propose changes. Call it first, and again when a result is unexpectedly empty. Relay next_steps to the person.",
    parameters: Tool.EmptyParams,
    success: Schema.Struct({
      client: Schema.String,
      readable_accounts: Schema.Array(ModelAccount),
      hidden_accounts: Schema.Struct({
        /** "Allow AI to read this account" is off for these accounts. */
        without_ai_consent: ToolInt,
        turned_off: ToolInt,
      }),
      write_mode: AgentWriteMode,
      proposal_tools: Schema.Boolean,
      read_only_session: Schema.Boolean.annotate({
        description:
          "True when this session cannot change mail: no proposal tools, write_mode off, or remote writes disabled.",
      }),
      remote_writes_disabled: Schema.Boolean.annotate({
        description: "OPENMAIL_READ_ONLY is set: sync fetches mail but pushes no changes.",
      }),
      next_steps: Schema.Array(Schema.String),
    }),
    failure: MailToolError,
    failureMode: "return",
  }),
);

export const ListProfiles = readOnly(
  mailTool("list_profiles", {
    description:
      "List profiles, the groups of accounts OpenMail calls spaces, such as Work and Personal. Pass an id as profile_id to list_threads. Page with next_cursor.",
    parameters: Schema.Struct(PageParameters),
    success: Schema.Struct({ ...PageResult, profiles: Schema.Array(Profile) }),
    failure: MailToolError,
    failureMode: "return",
  }),
);

export const ListLabels = readOnly(
  mailTool("list_labels", {
    description:
      "List labels (Gmail) and folders (Outlook, IMAP) per account, plus Gmail categories. Use an id as label in list_threads or label_id in modify_threads. Page with next_cursor.",
    parameters: Schema.Struct({
      account_id: Schema.optionalKey(AccountId),
      ...PageParameters,
    }),
    success: Schema.Struct({
      ...PageResult,
      labels: Schema.Array(Label),
      categories: Schema.Array(Schema.Literals(CATEGORIES)),
    }),
    failure: MailToolError,
    failureMode: "return",
  }),
);

export const accountHandlers = ({
  mailbox,
  identity,
  accessibleAccounts,
  forAccounts,
}: ToolContext) => {
  const accessStatus = Effect.gen(function* () {
    const current = yield* identity.current;
    const accounts = yield* mailbox.accounts.pipe(Effect.mapError(toToolError));
    const readable = yield* accessibleAccounts;
    const enabled = accounts.filter((a) => a.enabled !== false);
    const withoutConsent = enabled.length - readable.length;
    const turnedOff = accounts.length - enabled.length;
    const name = current.surface === "mcp" ? cleanMcpClientName(current.name) : current.name;
    const writeMode = yield* mailbox.agentWriteModeFor(name);
    const proposalTools = current.proposalTools ?? false;
    const remoteWritesDisabled = mailbox.readOnlySession;
    const steps: string[] = [];
    if (!accounts.length)
      steps.push("No mail account is connected. The person adds one in the OpenMail app.");
    else if (!readable.length && withoutConsent > 0)
      steps.push(
        `You can read no mail yet. Ask the person to turn on ${CONSENT_SWITCH} for an account in OpenMail under Settings → AI Access.`,
      );
    else if (withoutConsent > 0)
      steps.push(
        `${withoutConsent} more account(s) are hidden because ${CONSENT_SWITCH} is off for them. Only the person can turn it on, in Settings → AI Access.`,
      );
    if (turnedOff > 0)
      steps.push(
        `${turnedOff} account(s) are turned off in OpenMail and stay hidden until the person turns them on.`,
      );
    if (readable.some((a) => a.needsReauth))
      steps.push(
        "An account needs to be signed in again in OpenMail. Its local mail stays readable; sync fails until then.",
      );
    if (!proposalTools)
      steps.push(
        "This connection is read-only: it offers no tools that change mail. The person can turn on proposals for this app in OpenMail under Settings → AI Access.",
      );
    else if (writeMode === "off")
      steps.push(
        "Proposal tools are listed, but Changes by AI apps is Read only, so they will refuse. The person can choose Ask me first under Changes by AI apps in Settings → AI Access.",
      );
    else
      steps.push(
        "Changes you propose wait for the person to approve them in OpenMail. Nothing is sent without their confirmation in the app.",
      );
    if (remoteWritesDisabled)
      steps.push("Remote writes are turned off: sync fetches mail but pushes no changes.");
    return {
      client: name,
      readable_accounts: readable.map(toModelAccount),
      hidden_accounts: { without_ai_consent: withoutConsent, turned_off: turnedOff },
      write_mode: writeMode,
      proposal_tools: proposalTools,
      read_only_session: !proposalTools || writeMode === "off" || remoteWritesDisabled,
      remote_writes_disabled: remoteWritesDisabled,
      next_steps: steps,
    };
  });
  return {
    access_status: () => accessStatus,
    list_accounts: (p) =>
      page(
        "list_accounts",
        p,
        Effect.map(accessibleAccounts, (rows) => rows.map(toModelAccount)),
      ).pipe(Effect.map(({ items, ...rest }) => ({ ...rest, accounts: items }))),
    list_profiles: (p) =>
      page(
        "list_profiles",
        p,
        Effect.map(mailbox.profiles, (rows) =>
          rows.map((row) => ({ ...row, name: shortText(row.name) })),
        ),
      ).pipe(Effect.map(({ items, ...rest }) => ({ ...rest, profiles: items }))),
    list_labels: (p) =>
      page(
        "list_labels",
        p,
        forAccounts(p.account_id, (ids) =>
          Effect.map(mailbox.labels(ids), (rows) =>
            rows.map((row) => ({ ...row, name: shortText(row.name) })),
          ),
        ),
      ).pipe(
        Effect.map(({ items, ...rest }) => ({
          ...rest,
          labels: items,
          categories: [...CATEGORIES],
        })),
      ),
  } satisfies HandlersFor<
    typeof AccessStatus | typeof ListAccounts | typeof ListProfiles | typeof ListLabels
  >;
};
