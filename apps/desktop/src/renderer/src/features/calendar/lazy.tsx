import type { ComponentType } from "react";
import { lazyDialog } from "../../ui/lazy-dialog";

export const InviteBanner: ComponentType<
  Parameters<typeof import("./InviteBanner").InviteBanner>[0]
> = lazyDialog<Parameters<typeof import("./InviteBanner").InviteBanner>[0]>(() =>
  import("./InviteBanner").then((m) => ({ default: m.InviteBanner })),
);
