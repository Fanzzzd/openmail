import type { ComponentType } from "react";
import { lazyDialog } from "../../ui/lazy-dialog";

export const ProfileEditor: ComponentType<
  Parameters<typeof import("./ProfileEditor").ProfileEditor>[0]
> = lazyDialog<Parameters<typeof import("./ProfileEditor").ProfileEditor>[0]>(() =>
  import("./ProfileEditor").then((m) => ({ default: m.ProfileEditor })),
);
