import type { ComponentType } from "react";
import { lazyDialog } from "../../ui/lazy-dialog";

export const RawMessageDialog: ComponentType<
  Parameters<typeof import("./RawMessage").RawMessageDialog>[0]
> = lazyDialog<Parameters<typeof import("./RawMessage").RawMessageDialog>[0]>(() =>
  import("./RawMessage").then((m) => ({ default: m.RawMessageDialog })),
);
