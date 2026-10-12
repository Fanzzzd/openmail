import type { ComponentType } from "react";
import { lazyDialog } from "../../ui/lazy-dialog";

export const Proposals: ComponentType<Parameters<typeof import("./Proposals").Proposals>[0]> =
  lazyDialog<Parameters<typeof import("./Proposals").Proposals>[0]>(() =>
    import("./Proposals").then((m) => ({ default: m.Proposals })),
  );
