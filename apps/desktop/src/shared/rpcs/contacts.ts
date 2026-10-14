import {
  AppleContactsStatus,
  AppleContactsState,
  ContactSync,
  ContactGroup,
  SuggestedSender,
  Address,
} from "@openmail/core/schema";
import { Schema } from "effect";
import { Rpc } from "effect/rpc";
import { AccountIds, error } from "./fields";

/** Apple Contacts, contact groups, photos and suggestions. */
export const ContactRpcs = [
  Rpc.make("AppleContactsStatus", { success: AppleContactsState }),
  Rpc.make("RefreshAppleContacts", { success: AppleContactsState }),
  Rpc.make("SetAppleContacts", {
    payload: { enabled: Schema.Boolean },
    success: AppleContactsStatus,
    error,
  }),
  Rpc.make("AppleContactIdentifier", {
    payload: { address: Schema.String },
    success: Schema.NullOr(Schema.String),
  }),
  Rpc.make("OpenAppleContact", { payload: { address: Schema.String }, error }),
  Rpc.make("AddAppleContact", { payload: { contact: Address }, error }),
  Rpc.make("OpenAppleContactsSettings", { error }),
  Rpc.make("ContactGroups", {
    payload: { query: Schema.String, accountIds: AccountIds },
    success: Schema.Array(ContactGroup),
  }),
  Rpc.make("ContactPhoto", {
    payload: { accountId: Schema.String, address: Schema.String },
    success: Schema.NullOr(Schema.String),
  }),
  Rpc.make("SuggestSender", {
    payload: {
      current: Schema.Struct({ accountId: Schema.String, address: Schema.String }),
      recipients: Schema.Array(Schema.String),
      accountIds: Schema.Array(Schema.String),
    },
    success: Schema.NullOr(SuggestedSender),
  }),
  Rpc.make("ContactSync", { success: Schema.Array(ContactSync) }),
  Rpc.make("RefreshContacts", { payload: { accountId: Schema.String }, error }),
  Rpc.make("SuggestContacts", {
    payload: {
      query: Schema.String,
      exclude: Schema.optionalKey(Schema.String),
      accountIds: Schema.optionalKey(Schema.Array(Schema.String)),
    },
    success: Schema.Array(Address),
  }),
  Rpc.make("ContactAlternatives", {
    payload: { address: Schema.String },
    success: Schema.Array(Address),
  }),
  Rpc.make("HiddenContacts", { success: Schema.Array(Schema.String) }),
  Rpc.make("SetContactHidden", { payload: { address: Schema.String, hidden: Schema.Boolean } }),
] as const;
