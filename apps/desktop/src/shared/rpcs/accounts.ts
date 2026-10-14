import {
  OptionalService,
  AuthorizationFeature,
  ServiceGrant,
  Account,
  AccountSettings,
  AccountPlacement,
  ImapConnectInput,
  ImapPreset,
  Outcome,
  Profile,
  ProfileInput,
  SyncHealth,
} from "@openmail/core/schema";
import { Schema } from "effect";
import { Rpc } from "effect/rpc";
import { error } from "./fields";

export const ConnectInput = Schema.Union([
  Schema.Struct({ provider: Schema.Literal("gmail") }),
  Schema.Struct({ provider: Schema.Literal("outlook") }),
  Schema.Struct({ provider: Schema.Literal("imap"), input: ImapConnectInput }),
]);

/** Accounts, sign-in and spaces. */
export const AccountRpcs = [
  Rpc.make("ClientSetup", {
    // Where each provider's client comes from. Client values never cross IPC.
    success: Schema.Struct({
      googleClient: Schema.Literals(["own", "builtIn", "none"]),
      microsoftClient: Schema.Literals(["own", "builtIn", "none"]),
      googleBuiltIn: Schema.Boolean,
      microsoftBuiltIn: Schema.Boolean,
    }),
  }),
  Rpc.make("SetGoogleClient", {
    payload: { clientId: Schema.String, clientSecret: Schema.String },
  }),
  Rpc.make("SetMicrosoftClient", { payload: { clientId: Schema.String } }),
  Rpc.make("ClearClient", { payload: { provider: Schema.Literals(["gmail", "outlook"]) } }),
  Rpc.make("SetAccountSettings", {
    payload: { accountId: Schema.String, input: AccountSettings },
    error,
  }),
  Rpc.make("MoveAccount", {
    payload: { accountId: Schema.String, input: AccountPlacement },
    error,
  }),
  Rpc.make("OptionalServices", {
    payload: { accountId: Schema.String },
    success: Schema.Array(ServiceGrant),
    error,
  }),
  Rpc.make("SetServiceEnabled", {
    payload: { accountId: Schema.String, service: OptionalService, enabled: Schema.Boolean },
    error,
  }),
  Rpc.make("SyncHealth", { payload: { accountId: Schema.String }, success: SyncHealth, error }),
  Rpc.make("Accounts", { success: Schema.Array(Account) }),
  /** Opens the consent page (OAuth) or checks the password (IMAP), then starts a sync. */
  Rpc.make("Connect", { payload: { input: ConnectInput }, success: Account, error }),
  Rpc.make("Reauth", {
    payload: {
      accountId: Schema.String,
      feature: Schema.optionalKey(AuthorizationFeature),
    },
    success: Account,
    error,
  }),
  Rpc.make("ImapPresets", { success: Schema.Record(Schema.String, ImapPreset) }),
  Rpc.make("RemoveAccount", { payload: { accountId: Schema.String }, success: Outcome, error }),
  // Spaces
  Rpc.make("Profiles", { success: Schema.Array(Profile) }),
  Rpc.make("CreateProfile", { payload: { input: ProfileInput }, success: Profile, error }),
  Rpc.make("UpdateProfile", { payload: { id: Schema.String, input: ProfileInput }, error }),
  Rpc.make("DeleteProfile", { payload: { id: Schema.String } }),
  Rpc.make("AssignProfile", {
    payload: { accountId: Schema.String, profileId: Schema.NullOr(Schema.String) },
  }),
] as const;
