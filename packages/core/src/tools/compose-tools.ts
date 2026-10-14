/** Tools for templates, signatures and contact suggestions. */

import {
  AccountId,
  MailToolError,
  Recipients,
  collection,
  mailTool,
  page,
  readOnly,
  textPage,
  toolAttempt,
  toolError,
} from "./tool-common.js";
import { Effect, Schema } from "effect";
import { NamedSignature } from "../compose/signatures.js";
import { PageParameters, PageResult, ToolBudget, ToolInt, shortText } from "./tool-pages.js";
import type { HandlersFor, ToolContext } from "./tool-context.js";

export const ListTemplates = collection(
  "list_templates",
  "List saved templates by id, name and subject. Pass an id to read_template for the body. Page with next_cursor.",
  Schema.Struct({ id: Schema.String, name: Schema.String, subject: Schema.String }),
);
export const ListSignatures = collection(
  "list_signatures",
  "List saved signatures by id, name, address and source. Pass an id to read_signature for the text. Page with next_cursor.",
  Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    address: Schema.String,
    source: NamedSignature.fields.source,
  }),
);
export const detailParameters = (id: string) => ({
  id: Schema.String.annotate({ description: id }),
  offset: ToolInt.check(Schema.isBetween({ minimum: 0, maximum: 1_000_000 }))
    .annotate({ description: "next_offset from the last page. Default 0." })
    .pipe(Schema.withDecodingDefaultKey(Effect.succeed(0))),
  token_budget: ToolBudget,
});
export const ReadTemplate = readOnly(
  mailTool("read_template", {
    description:
      "Read a template's subject, recipients and plain-text body. Use an id from list_templates. Long bodies page with next_offset.",
    parameters: Schema.Struct(detailParameters("A template id from list_templates.")),
    success: Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      subject: Schema.String,
      to: Recipients,
      cc: Recipients,
      bcc: Recipients,
      text: Schema.String,
      next_offset: Schema.optionalKey(ToolInt),
    }),
    failure: MailToolError,
    failureMode: "return",
  }),
);
export const ReadSignature = readOnly(
  mailTool("read_signature", {
    description:
      "Read a signature as plain text. Use an id from list_signatures. Long text pages with next_offset.",
    parameters: Schema.Struct(detailParameters("A signature id from list_signatures.")),
    success: Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      address: Schema.String,
      text: Schema.String,
      next_offset: Schema.optionalKey(ToolInt),
    }),
    failure: MailToolError,
    failureMode: "return",
  }),
);
export const SuggestContacts = readOnly(
  mailTool("suggest_contacts", {
    description:
      "Suggest recipient addresses from local history and cached contacts, for the to, cc or bcc of draft_message. Up to 100 suggestions; page with next_cursor.",
    parameters: Schema.Struct({
      query: Schema.String.check(Schema.isMaxLength(320)).annotate({
        description: "Part of a name or address. Empty lists frequent contacts.",
      }),
      account_id: Schema.optionalKey(AccountId),
      exclude: Schema.optionalKey(
        Schema.String.annotate({ description: "Leave out addresses in this list." }),
      ),
      ...PageParameters,
    }),
    success: Schema.Struct({
      ...PageResult,
      contacts: Schema.Array(Schema.Struct({ name: Schema.String, address: Schema.String })),
    }),
    failure: MailToolError,
    failureMode: "return",
  }),
);

export const composeHandlers = ({ mailbox, forAccounts }: ToolContext) => {
  return {
    list_templates: (p) =>
      page(
        "list_templates",
        p,
        Effect.map(mailbox.compose.templates, (rows) =>
          rows.map(({ id, name, subject }) => ({
            id,
            name: shortText(name),
            subject: shortText(subject),
          })),
        ),
      ),
    read_template: Effect.fnUntraced(function* (p) {
      const row = (yield* mailbox.compose.templates).find((r) => r.id === p.id);
      if (!row)
        return yield* toolError(
          "not_found",
          `No template with id ${p.id}.`,
          "Get template ids from list_templates.",
        );
      return yield* toolAttempt(() =>
        textPage(
          {
            id: row.id,
            name: shortText(row.name),
            subject: shortText(row.subject),
            to: row.to.map((a) => a.address).slice(0, 50),
            cc: row.cc.map((a) => a.address).slice(0, 50),
            bcc: (row.bcc ?? []).map((a) => a.address).slice(0, 50),
          },
          row.body,
          p,
        ),
      );
    }),
    list_signatures: (p) =>
      page(
        "list_signatures",
        p,
        Effect.map(mailbox.compose.namedSignatures, (rows) =>
          rows.map(({ id, name, address, source }) => ({
            id,
            name: shortText(name),
            address,
            source,
          })),
        ),
      ),
    read_signature: Effect.fnUntraced(function* (p) {
      const row = (yield* mailbox.compose.namedSignatures).find((r) => r.id === p.id);
      if (!row)
        return yield* toolError(
          "not_found",
          `No signature with id ${p.id}.`,
          "Get signature ids from list_signatures.",
        );
      return yield* toolAttempt(() =>
        textPage({ id: row.id, name: shortText(row.name), address: row.address }, row.text, p),
      );
    }),
    suggest_contacts: (p) =>
      page(
        "suggest_contacts",
        p,
        Effect.map(
          forAccounts(p.account_id, (ids) =>
            mailbox.compose.suggestContacts(p.query, {
              limit: 100,
              exclude: p.exclude,
              accountIds: ids,
            }),
          ),
          (rows) => rows.map((r) => ({ ...r, name: shortText(r.name) })),
        ),
      ).pipe(Effect.map(({ items, ...rest }) => ({ ...rest, contacts: items }))),
  } satisfies HandlersFor<
    | typeof ListTemplates
    | typeof ReadTemplate
    | typeof ListSignatures
    | typeof ReadSignature
    | typeof SuggestContacts
  >;
};
