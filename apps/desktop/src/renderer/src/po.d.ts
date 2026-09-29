// The Lingui vite plugin compiles an imported .po catalog into this shape.
declare module "*.po" {
  import type { Messages } from "@lingui/core";

  export const messages: Messages;
}
