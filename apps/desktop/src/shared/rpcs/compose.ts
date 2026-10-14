import {
  GrammarIssue,
  GrammarText,
  NativePicker,
  NativePickerLabels,
  NativePickerResult,
} from "../native-compose";
import {
  Draft,
  DraftInput,
  OutgoingAttachment,
  Prefs,
  PrefsPatch,
  Signature,
  NamedSignature,
  NamedSignatureInput,
  SignatureDefault,
  Template,
  TemplateInput,
} from "@openmail/core/schema";
import { ComposeMessageFields } from "../desktop";
import { Schema } from "effect";
import { Rpc } from "effect/rpc";
import { error } from "./fields";

/** Drafts, native compose helpers, prefs, signatures and templates. */
export const ComposeRpcs = [
  Rpc.make("ImageFromUrl", { payload: { url: Schema.String }, success: OutgoingAttachment, error }),
  Rpc.make("ImageFromFile", {
    payload: { file: OutgoingAttachment },
    success: OutgoingAttachment,
    error,
  }),
  // Drafts
  /** A local draft id, a draft message id from the Drafts list, or "proposal:<id>". */
  Rpc.make("NativeComposeCapabilities", {
    success: Schema.Struct({
      photos: Schema.Boolean,
      continuity: Schema.Boolean,
      grammar: Schema.Boolean,
    }),
  }),
  Rpc.make("PickNativeImages", {
    payload: { kind: NativePicker, labels: NativePickerLabels },
    success: NativePickerResult,
    error,
  }),
  Rpc.make("CheckNativeGrammar", {
    payload: { text: GrammarText },
    success: Schema.Array(GrammarIssue),
    error,
  }),
  Rpc.make("ShareMessageLink", {
    payload: { id: Schema.String, kind: Schema.Literals(["message", "thread", "web"]) },
    error,
  }),
  Rpc.make("ClipboardAttachments", { success: Schema.Array(OutgoingAttachment), error }),
  Rpc.make("ComposeMessage", { payload: ComposeMessageFields }),
  Rpc.make("ComposeAttachments", {
    payload: { id: Schema.String },
    success: Schema.Array(OutgoingAttachment),
    error,
  }),
  Rpc.make("SendAgain", { payload: { id: Schema.String }, success: Draft, error }),
  Rpc.make("RecoverDraft", {
    payload: {
      id: Schema.String,
      action: Schema.Literals(["retry", "local"]),
      draft: Schema.optionalKey(DraftInput),
    },
    success: Draft,
    error,
  }),
  Rpc.make("OpenDraft", { payload: { id: Schema.String }, success: Draft, error }),
  Rpc.make("DraftStatus", { payload: { id: Schema.String }, success: Schema.NullOr(Draft) }),
  Rpc.make("SaveDraft", { payload: { draft: DraftInput }, success: Draft, error }),
  /** With `holdMs`, core holds the discard for the undo window; true when it is held. */
  Rpc.make("DiscardDraft", {
    payload: { id: Schema.String, holdMs: Schema.optionalKey(Schema.Number) },
    success: Schema.Boolean,
  }),
  Rpc.make("RestoreDraft", { payload: { id: Schema.String }, success: Draft, error }),

  // Compose settings
  Rpc.make("Prefs", { success: Prefs }),
  Rpc.make("SetPrefs", { payload: { patch: PrefsPatch }, error }),
  /** Opens a folder picker in the main process and stores the choice. Null when cancelled. */
  Rpc.make("ChooseAttachmentFolder", { success: Schema.NullOr(Schema.String), error }),
  Rpc.make("NamedSignatures", { success: Schema.Array(NamedSignature) }),
  Rpc.make("SignatureDefaults", { success: Schema.Array(SignatureDefault) }),
  Rpc.make("SaveNamedSignature", {
    payload: { input: NamedSignatureInput, id: Schema.optionalKey(Schema.String) },
    success: NamedSignature,
    error,
  }),
  Rpc.make("DeleteNamedSignature", { payload: { id: Schema.String } }),
  Rpc.make("SetSignatureDefault", { payload: { setting: SignatureDefault }, error }),
  Rpc.make("Signatures", { success: Schema.Array(Signature) }),
  Rpc.make("Templates", { success: Schema.Array(Template) }),
  Rpc.make("SaveTemplate", {
    payload: { input: TemplateInput, id: Schema.optionalKey(Schema.String) },
    success: Template,
    error,
  }),
  Rpc.make("DeleteTemplate", { payload: { id: Schema.String } }),
] as const;
