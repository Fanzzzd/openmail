/** proposals, agents, audit and mcp: what models asked for, may do and did. */

import { Argument, Command, Flag, Prompt } from "effect/cli";
import { fail, jsonFlag, print } from "./common.js";
import { Console, Effect } from "effect";
import { Mailbox } from "@openmail/core";
import { auditTable, commandSummary, outcomeText, proposalTable } from "../format.js";
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

/** An approval from a script is not a person's decision; only an interactive terminal counts. */
const proposalsApprove = Command.make(
  "approve",
  {
    id: proposalId,
    yes: Flag.Boolean("yes").pipe(
      Flag.withDescription(
        "Approve without the confirmation prompt (needed when stdin is not a terminal). Never approves messages.",
      ),
      Flag.withDefault(false),
    ),
  },
  Effect.fn(function* ({ id, yes }) {
    const mailbox = yield* Mailbox;
    const proposal = (yield* mailbox.proposals).find((p) => p.id === id);
    if (!proposal) return yield* fail(`No proposal with id ${id}.`);
    if (proposal.command.kind === "send" || proposal.command.kind === "draft") {
      return yield* fail(
        `Proposal ${id} is a message (${commandSummary(proposal.command)}). Open openmail to review and send it; the CLI does not approve or send mail.`,
      );
    }
    if (!yes) {
      if (!process.stdin.isTTY)
        return yield* fail(
          "Approving needs a confirmation in an interactive terminal. Run it in a terminal, or pass --yes.",
        );
      const confirmed = yield* Prompt.run(
        Prompt.Confirm({
          message: `Approve proposal ${id}: ${commandSummary(proposal.command)}?`,
        }),
      );
      if (!confirmed) return yield* Console.log(`Proposal ${id} is still pending.`);
    }
    const outcome = yield* mailbox.decideProposal(id, true, "cli");
    return yield* Console.log(outcomeText(outcome, `Approved proposal ${id}.`));
  }),
).pipe(
  Command.withDescription("Approve a proposed change after confirming; it runs as you (user:cli)"),
);

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
