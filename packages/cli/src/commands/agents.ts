/** proposals, agents, audit and mcp: what models asked for, may do and did. */

import { Argument, Command, Flag } from "effect/cli";
import { WRITE_MODE_SETTING, fail, jsonFlag, print } from "./common.js";
import { Console, Effect } from "effect";

import { APPROVE_IN_APP, Mailbox } from "@openmail/core";
import { auditTable, proposalTable } from "../format.js";
import { runMcp } from "../mcp-server.js";

const proposalsList = Command.make(
  "list",
  { json: jsonFlag },
  Effect.fn(function* ({ json }) {
    const mailbox = yield* Mailbox;
    yield* print(yield* mailbox.proposals.proposals, json, proposalTable);
  }),
).pipe(Command.withDescription("List changes agents asked for that wait for a person"));

const proposalId = Argument.Int("proposal-id");

/**
 * Approving happens only in the app: an agent with a shell could run this command, so a CLI
 * approval is not the person's confirmation. The old command stays, unlisted, so scripts that
 * call it learn where to go instead of failing with a usage error.
 */
const proposalsApprove = Command.make(
  "approve",
  {
    id: Argument.String("proposal-id").pipe(Argument.optional),
    yes: Flag.Boolean("yes").pipe(Flag.withHidden, Flag.withDefault(false)),
  },
  () => fail(APPROVE_IN_APP),
).pipe(Command.withDescription("Removed: approve proposals in the app"), Command.unlisted);

const proposalsReject = Command.make(
  "reject",
  { id: proposalId },
  Effect.fn(function* ({ id }) {
    const mailbox = yield* Mailbox;
    yield* mailbox.proposals.decideProposal(id, false, "cli");
    yield* Console.log(`Rejected proposal ${id}.`);
  }),
).pipe(Command.withDescription("Reject a proposed change. Approving happens only in the app."));

const proposals = Command.make("proposals").pipe(
  Command.withDescription("List and reject what agents asked to change; approve in the app"),
  Command.withSubcommands([proposalsList, proposalsApprove, proposalsReject]),
);

/** Changes by AI apps as the app shows it. Every mode but off proposes, so it reads as Ask me first. */
const writeModeView = (mode: string) =>
  mode === "off"
    ? {
        changes_by_ai_apps: "read_only" as const,
        label: "Read only",
        detail: "AI apps can read and search the accounts you allow. They cannot change mail.",
      }
    : {
        changes_by_ai_apps: "ask_me_first" as const,
        label: "Ask me first",
        detail:
          "Changes that AI apps suggest wait in AI suggestions until you approve them in the app. Sending always needs your confirmation in the app.",
      };

const writeMode = Command.make(
  "write-mode",
  { json: jsonFlag },
  Effect.fn(function* ({ json }) {
    const mailbox = yield* Mailbox;
    const view = writeModeView(yield* mailbox.proposals.agentWriteMode);
    yield* print({ changes_by_ai_apps: view.changes_by_ai_apps }, json, () =>
      [
        `Changes by AI apps: ${view.label}`,
        view.detail,
        `Change it in the app under ${WRITE_MODE_SETTING}.`,
      ].join("\n"),
    );
  }),
).pipe(
  Command.withDescription(
    `Show Changes by AI apps (Read only or Ask me first); change it in the app under ${WRITE_MODE_SETTING}`,
  ),
);

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
    yield* print(yield* mailbox.proposals.audit(limit), json, auditTable);
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

/** @internal */
export const agentCommands = [proposals, agents, audit, mcp] as const;
