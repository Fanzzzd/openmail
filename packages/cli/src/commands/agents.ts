/** proposals, agents, audit and mcp: what models asked for, may do and did. */

import { Argument, Command, Flag } from "effect/cli";
import { fail, jsonFlag, print } from "./common.js";
import { Console, Effect } from "effect";
import { APPROVE_IN_APP, Mailbox } from "@openmail/core";
import { auditTable, proposalTable } from "../format.js";
import { runMcp } from "../mcp-server.js";

const proposalsList = Command.make(
  "list",
  { json: jsonFlag },
  Effect.fn(function* ({ json }) {
    const mailbox = yield* Mailbox;
    yield* print(yield* mailbox.proposals, json, proposalTable);
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
    yield* mailbox.decideProposal(id, false, "cli");
    yield* Console.log(`Rejected proposal ${id}.`);
  }),
).pipe(Command.withDescription("Reject a proposed change. Approving happens only in the app."));

const proposals = Command.make("proposals").pipe(
  Command.withDescription("List and reject what agents asked to change; approve in the app"),
  Command.withSubcommands([proposalsList, proposalsApprove, proposalsReject]),
);

const writeMode = Command.make(
  "write-mode",
  {},
  Effect.fn(function* () {
    const mailbox = yield* Mailbox;
    yield* Console.log(`Agent write mode: ${yield* mailbox.agentWriteMode}.`);
    yield* Console.log(
      "The mode can only be changed in the app under Settings > AI Access. MCP always proposes for app approval. Sending requires confirmation in the app.",
    );
  }),
).pipe(
  Command.withDescription(
    "Show agent write permissions; change them in the app (Settings > AI Access)",
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

/** @internal */
export const agentCommands = [proposals, agents, audit, mcp] as const;
