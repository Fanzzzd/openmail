import { Clock, Effect, Option, Schema } from "effect";
import { type SqlClient } from "effect/sql";
import {
  type Actor,
  actorLabel,
  type AgentWriteMode,
  Command,
  type Proposal,
} from "../domain/domain.js";
import { NotFound } from "../domain/errors.js";
import { sha256Hex } from "../platform/crypto.js";
import type { Store } from "./service.js";
import { all, first, run } from "./sql-rows.js";
import { type makeComposeStore } from "./store-compose.js";
import {
  AgentActivityRow,
  AuditRow,
  Id,
  Mode,
  ProposalRow,
  REDACT_DECIDED,
  toProposal,
} from "./store-rows.js";

/** Rows agent_activity keeps. Settings shows the last few calls per client. */
const AGENT_ACTIVITY_ROWS = 500;
/** The audit log keeps this many of its newest entries. */
export const AUDIT_LOG_ROWS = 5000;

function auditMetadata(entry: { accountId?: string | null; action: string; detail: unknown }) {
  const metadata = Schema.decodeUnknownOption(
    Schema.Struct({
      command: Schema.optionalKey(Command),
      to: Schema.optionalKey(Schema.Array(Schema.String)),
      cc: Schema.optionalKey(Schema.Array(Schema.String)),
      bcc: Schema.optionalKey(Schema.Array(Schema.String)),
    }),
  )(entry.detail);
  const detail = Option.getOrUndefined(metadata);
  const command = detail?.command;
  const message =
    command?.kind === "draft" || command?.kind === "send" ? command.message : undefined;
  return {
    kind: command?.kind ?? entry.action,
    accountId: entry.accountId ?? (command && "accountId" in command ? command.accountId : null),
    recipientCount: message
      ? message.to.length + message.cc.length + message.bcc.length
      : (detail?.to?.length ?? 0) + (detail?.cc?.length ?? 0) + (detail?.bcc?.length ?? 0),
    hash: sha256Hex(JSON.stringify(entry.detail ?? null)),
  };
}
export const makePolicyStore = ({
  sql,
  compose,
}: {
  sql: SqlClient.SqlClient;
  compose: ReturnType<typeof makeComposeStore>;
}) => {
  const purgeAccountProposals = Effect.fn("Store.purgeAccountProposals")(function* (
    ownerId: string,
    removeDraft: (draft: import("./service.js").StoredDraft) => Effect.Effect<void> = (draft) =>
      compose.deleteDraft(draft.id),
  ) {
    const now = yield* Clock.currentTimeMillis;
    const rows = yield* all(Id)(sql`SELECT p.id FROM proposals p WHERE p.status='pending' AND (
        json_extract(p.command_json,'$.accountId')=${ownerId}
        OR EXISTS(SELECT 1 FROM json_each(p.command_json,'$.threads') t
          WHERE t.value IN (SELECT id FROM messages WHERE account_id=${ownerId})
          OR substr(t.value,1,${ownerId.length + 1})=${`${ownerId}/`}))`);
    for (const row of rows) {
      const draft = yield* compose.draftByProposal(row.id);
      if (Option.isSome(draft)) yield* removeDraft(draft.value);
      yield* run(
        sql`UPDATE proposals SET status='rejected',decided_at=${now},${sql.literal(REDACT_DECIDED)} WHERE id=${row.id}`,
      );
    }
  });

  // Audit, agent policy, proposals

  const appendAudit = Effect.fn("Store.appendAudit")(function* (entry: {
    actor: Actor;
    accountId?: string;
    action: string;
    detail: unknown;
  }) {
    const now = yield* Clock.currentTimeMillis;
    const safe = auditMetadata(entry);
    yield* run(sql`INSERT INTO audit_log (at, actor, account_id, action, detail_json)
        VALUES (${now}, ${actorLabel(entry.actor)}, ${entry.accountId ?? null}, ${entry.action},
          ${JSON.stringify(safe)})`);
    yield* run(sql`DELETE FROM audit_log
        WHERE id <= (SELECT max(id) FROM audit_log) - ${AUDIT_LOG_ROWS}`);
  });

  const listAudit = Effect.fn("Store.listAudit")(function* (limit: number) {
    const rows = yield* all(AuditRow)(sql`SELECT at, actor, account_id, action, detail_json
        FROM audit_log ORDER BY id DESC LIMIT ${limit}`);
    return rows.map((r) => ({
      at: r.at,
      actor: r.actor,
      accountId: r.account_id,
      action: r.action,
      detail: r.detail_json,
    }));
  });

  const appendAgentActivity = Effect.fn("Store.appendAgentActivity")(function* (entry: {
    client: string;
    tool: string;
    ok: boolean;
  }) {
    const now = yield* Clock.currentTimeMillis;
    yield* run(sql`INSERT INTO agent_activity (at, client, tool, ok)
        VALUES (${now}, ${entry.client}, ${entry.tool}, ${entry.ok ? 1 : 0})`);
    yield* run(sql`DELETE FROM agent_activity
        WHERE id <= (SELECT max(id) FROM agent_activity) - ${AGENT_ACTIVITY_ROWS}`);
  });

  const listAgentActivity = Effect.fn("Store.listAgentActivity")(function* (limit: number) {
    const rows = yield* all(AgentActivityRow)(sql`SELECT at, client, tool, ok
        FROM agent_activity ORDER BY id DESC LIMIT ${limit}`);
    return rows.map((r) => ({ at: r.at, client: r.client, tool: r.tool, ok: r.ok !== 0 }));
  });

  /** The agent's own row, else the '*' default, else off. */
  const agentWriteMode = Effect.fn("Store.agentWriteMode")(function* (name: string) {
    const row = yield* first(Mode)(sql`SELECT modify FROM agent_policies
        WHERE name IN (${name}, '*') ORDER BY name = '*' LIMIT 1`);
    return Option.match(row, { onNone: (): AgentWriteMode => "off", onSome: (r) => r.modify });
  });

  const setAgentWriteMode = Effect.fn("Store.setAgentWriteMode")(
    (name: string, mode: AgentWriteMode) =>
      run(sql`INSERT INTO agent_policies (name, modify) VALUES (${name}, ${mode})
          ON CONFLICT(name) DO UPDATE SET modify = excluded.modify`),
  );

  const insertProposal = Effect.fn("Store.insertProposal")(function* (
    actor: Actor,
    command: Command,
  ) {
    const now = yield* Clock.currentTimeMillis;
    const row = yield* first(Id)(sql`INSERT INTO proposals (created_at, actor_json, command_json)
        VALUES (${now}, ${JSON.stringify(actor)}, ${JSON.stringify(command)}) RETURNING id`);
    if (Option.isNone(row)) return yield* Effect.die("INSERT ... RETURNING returned no row");
    return row.value.id;
  });

  // Decided commands have no retained payload. The API only needs their status.
  const PROPOSAL_COLUMNS = sql.literal(`id, created_at, actor_json,
      CASE WHEN status='pending' THEN command_json ELSE '{"kind":"modify","threads":[],"op":{"kind":"archive"}}' END AS command_json, status`);

  const listProposals = Effect.fn("Store.listProposals")(function* (status: Proposal["status"]) {
    const rows = yield* all(ProposalRow)(sql`SELECT ${PROPOSAL_COLUMNS} FROM proposals
        WHERE status = ${status} ORDER BY created_at, id`);
    return rows.map(toProposal);
  });

  const getProposal = Effect.fn("Store.getProposal")(function* (
    id: number,
  ): Effect.fn.Return<Proposal, NotFound> {
    const row = yield* first(ProposalRow)(
      sql`SELECT ${PROPOSAL_COLUMNS} FROM proposals WHERE id = ${id}`,
    );
    if (Option.isNone(row)) return yield* new NotFound({ what: "proposal", id: String(id) });
    return toProposal(row.value);
  });

  /** Decides a pending proposal. A decided one keeps its first decision. */
  const setProposalStatus = Effect.fn("Store.setProposalStatus")(function* (
    id: number,
    status: "approved" | "rejected",
  ) {
    const now = yield* Clock.currentTimeMillis;
    yield* run(sql`UPDATE proposals SET status = ${status}, decided_at = ${now}, ${sql.literal(REDACT_DECIDED)}
        WHERE id = ${id} AND status = 'pending'`);
  });

  const initialize = Effect.gen(function* () {
    const retentionMarker = "security:ai-retention-v1";

    const retained = yield* first(Schema.Struct({ key: Schema.String }))(
      sql`SELECT key FROM prefs WHERE key=${retentionMarker}`,
    );

    if (Option.isNone(retained))
      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            // Apply the retention policy to records written before this version, without a schema migration.
            yield* run(sql`UPDATE proposals SET ${sql.literal(REDACT_DECIDED)}
      WHERE status!='pending' AND (command_json!='{}' OR json_type(actor_json,'$.rationale') IS NOT NULL)`);
            const LegacyAudit = Schema.Struct({ id: Schema.Number, ...AuditRow.fields });
            for (;;) {
              const rows = yield* all(
                LegacyAudit,
              )(sql`SELECT id,at,actor,account_id,action,detail_json FROM audit_log
        WHERE COALESCE(json_type(detail_json,'$.hash'),'')!='text'
          OR EXISTS(SELECT 1 FROM json_each(detail_json) WHERE key NOT IN ('kind','accountId','recipientCount','hash'))
        ORDER BY id LIMIT 100`);
              if (!rows.length) break;
              for (const row of rows)
                yield* run(
                  sql`UPDATE audit_log SET detail_json=${JSON.stringify(auditMetadata({ accountId: row.account_id, action: row.action, detail: row.detail_json }))} WHERE id=${row.id}`,
                );
            }

            yield* run(
              sql`INSERT INTO prefs(key,value_json) VALUES(${retentionMarker},'true') ON CONFLICT(key) DO NOTHING`,
            );
          }),
        )
        .pipe(Effect.orDie);
  });
  return {
    initialize,
    service: {
      purgeAccountProposals,
      appendAudit,
      listAudit,
      appendAgentActivity,
      listAgentActivity,
      agentWriteMode,
      setAgentWriteMode,
      insertProposal,
      listProposals,
      getProposal,
      setProposalStatus,
    } satisfies Pick<
      Store["Service"],
      | "purgeAccountProposals"
      | "appendAudit"
      | "listAudit"
      | "appendAgentActivity"
      | "listAgentActivity"
      | "agentWriteMode"
      | "setAgentWriteMode"
      | "insertProposal"
      | "listProposals"
      | "getProposal"
      | "setProposalStatus"
    >,
  };
};
