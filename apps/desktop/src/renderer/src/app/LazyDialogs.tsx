import type { ComponentType } from "react";
import { type LazyDialog, lazyDialog } from "../ui/lazy-dialog";

// Dialogs that a feature also opens itself live in that feature's lazy.tsx.

export const Settings: LazyDialog<
  Parameters<typeof import("../features/settings/Settings").Settings>[0]
> = lazyDialog<Parameters<typeof import("../features/settings/Settings").Settings>[0]>(() =>
  import("../features/settings/Settings").then((m) => ({ default: m.Settings })),
);
export const Composer: ComponentType<
  Parameters<typeof import("../features/compose/components/Composer").Composer>[0]
> = lazyDialog<Parameters<typeof import("../features/compose/components/Composer").Composer>[0]>(
  () => import("../features/compose/components/Composer").then((m) => ({ default: m.Composer })),
);
export const AddAccountDialog: ComponentType<
  Parameters<typeof import("../features/accounts/AddAccountDialog").AddAccountDialog>[0]
> = lazyDialog<
  Parameters<typeof import("../features/accounts/AddAccountDialog").AddAccountDialog>[0]
>(() =>
  import("../features/accounts/AddAccountDialog").then((m) => ({ default: m.AddAccountDialog })),
);
export const ShortcutHelp: ComponentType<
  Parameters<typeof import("../features/settings/sections/SystemSettings").ShortcutHelp>[0]
> = lazyDialog<
  Parameters<typeof import("../features/settings/sections/SystemSettings").ShortcutHelp>[0]
>(() =>
  import("../features/settings/sections/SystemSettings").then((m) => ({ default: m.ShortcutHelp })),
);
export const Feedback: ComponentType<
  Parameters<typeof import("../features/feedback/Feedback").Feedback>[0]
> = lazyDialog<Parameters<typeof import("../features/feedback/Feedback").Feedback>[0]>(() =>
  import("../features/feedback/Feedback").then((m) => ({ default: m.Feedback })),
);
export const CreateLabelDialog: ComponentType<
  Parameters<typeof import("../features/organize/CreateLabelDialog").CreateLabelDialog>[0]
> = lazyDialog<
  Parameters<typeof import("../features/organize/CreateLabelDialog").CreateLabelDialog>[0]
>(() =>
  import("../features/organize/CreateLabelDialog").then((m) => ({ default: m.CreateLabelDialog })),
);
export const FilterEditor: ComponentType<
  Parameters<typeof import("../features/settings/sections/ServerSettings").FilterEditor>[0]
> = lazyDialog<
  Parameters<typeof import("../features/settings/sections/ServerSettings").FilterEditor>[0]
>(() =>
  import("../features/settings/sections/ServerSettings").then((m) => ({ default: m.FilterEditor })),
);
export const FirstRunDone: ComponentType<
  Parameters<typeof import("../features/accounts/FirstRunDone").FirstRunDone>[0]
> = lazyDialog<Parameters<typeof import("../features/accounts/FirstRunDone").FirstRunDone>[0]>(() =>
  import("../features/accounts/FirstRunDone").then((m) => ({ default: m.FirstRunDone })),
);
