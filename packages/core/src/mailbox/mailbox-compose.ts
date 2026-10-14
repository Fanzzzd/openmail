import type { Effect } from "effect";
import type { Store } from "../store/service.js";
import type { MailboxCompose } from "./mailbox.js";

/** Signatures and templates; all local, no provider requests. */
export function makeComposeSettingsMailbox(
  store: Store["Service"],
  mutate: <A, E>(effect: Effect.Effect<A, E>) => Effect.Effect<A, E>,
) {
  return {
    namedSignatures: store.namedSignatures,

    signatureDefaults: store.signatureDefaults,

    saveNamedSignature: (input, id) => mutate(store.saveNamedSignature(input, id)),

    deleteNamedSignature: (id) => mutate(store.deleteNamedSignature(id)),

    setSignatureDefault: (setting) => mutate(store.setSignatureDefault(setting)),

    signatures: store.signatures,

    setSignature: (signature) => mutate(store.setSignature(signature)),

    templates: store.templates,

    saveTemplate: (input, id) => mutate(store.saveTemplate(id ?? null, input)),

    deleteTemplate: (id) => mutate(store.deleteTemplate(id)),
  } satisfies Pick<
    MailboxCompose,
    | "namedSignatures"
    | "signatureDefaults"
    | "saveNamedSignature"
    | "deleteNamedSignature"
    | "setSignatureDefault"
    | "signatures"
    | "setSignature"
    | "templates"
    | "saveTemplate"
    | "deleteTemplate"
  >;
}
