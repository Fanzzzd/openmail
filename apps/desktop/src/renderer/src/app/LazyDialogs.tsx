import { lazy, Suspense, type ComponentType } from "react";

/** Each dialog owns its loading boundary so mail stays visible during import. */
function dialog<P extends object>(load: () => Promise<{ default: ComponentType<P> }>) {
  const Component = lazy(load);
  return function LazyDialog(props: P) {
    return (
      <Suspense fallback={null}>
        <Component {...props} />
      </Suspense>
    );
  };
}

export const Settings: ComponentType<
  Parameters<typeof import("../features/settings/Settings").Settings>[0]
> = dialog<Parameters<typeof import("../features/settings/Settings").Settings>[0]>(() =>
  import("../features/settings/Settings").then((m) => ({ default: m.Settings })),
);
export const Composer: ComponentType<
  Parameters<typeof import("../features/compose/components/Composer").Composer>[0]
> = dialog<Parameters<typeof import("../features/compose/components/Composer").Composer>[0]>(() =>
  import("../features/compose/components/Composer").then((m) => ({ default: m.Composer })),
);
export const AddAccountDialog: ComponentType<
  Parameters<typeof import("../features/accounts/AddAccountDialog").AddAccountDialog>[0]
> = dialog<Parameters<typeof import("../features/accounts/AddAccountDialog").AddAccountDialog>[0]>(
  () =>
    import("../features/accounts/AddAccountDialog").then((m) => ({ default: m.AddAccountDialog })),
);
export const ShortcutHelp: ComponentType<
  Parameters<typeof import("../features/settings/sections/SystemSettings").ShortcutHelp>[0]
> = dialog<
  Parameters<typeof import("../features/settings/sections/SystemSettings").ShortcutHelp>[0]
>(() =>
  import("../features/settings/sections/SystemSettings").then((m) => ({ default: m.ShortcutHelp })),
);
export const ProfileEditor: ComponentType<
  Parameters<typeof import("../features/accounts/ProfileEditor").ProfileEditor>[0]
> = dialog<Parameters<typeof import("../features/accounts/ProfileEditor").ProfileEditor>[0]>(() =>
  import("../features/accounts/ProfileEditor").then((m) => ({ default: m.ProfileEditor })),
);
export const Feedback: ComponentType<
  Parameters<typeof import("../features/feedback/Feedback").Feedback>[0]
> = dialog<Parameters<typeof import("../features/feedback/Feedback").Feedback>[0]>(() =>
  import("../features/feedback/Feedback").then((m) => ({ default: m.Feedback })),
);
export const Proposals: ComponentType<
  Parameters<typeof import("../features/ai/Proposals").Proposals>[0]
> = dialog<Parameters<typeof import("../features/ai/Proposals").Proposals>[0]>(() =>
  import("../features/ai/Proposals").then((m) => ({ default: m.Proposals })),
);
export const CreateLabelDialog: ComponentType<
  Parameters<typeof import("../features/organize/CreateLabelDialog").CreateLabelDialog>[0]
> = dialog<
  Parameters<typeof import("../features/organize/CreateLabelDialog").CreateLabelDialog>[0]
>(() =>
  import("../features/organize/CreateLabelDialog").then((m) => ({ default: m.CreateLabelDialog })),
);
export const FilterEditor: ComponentType<
  Parameters<typeof import("../features/settings/sections/ServerSettings").FilterEditor>[0]
> = dialog<
  Parameters<typeof import("../features/settings/sections/ServerSettings").FilterEditor>[0]
>(() =>
  import("../features/settings/sections/ServerSettings").then((m) => ({ default: m.FilterEditor })),
);
export const RawMessageDialog: ComponentType<
  Parameters<typeof import("../features/reader/RawMessage").RawMessageDialog>[0]
> = dialog<Parameters<typeof import("../features/reader/RawMessage").RawMessageDialog>[0]>(() =>
  import("../features/reader/RawMessage").then((m) => ({ default: m.RawMessageDialog })),
);
export const InviteBanner: ComponentType<
  Parameters<typeof import("../features/calendar/InviteBanner").InviteBanner>[0]
> = dialog<Parameters<typeof import("../features/calendar/InviteBanner").InviteBanner>[0]>(() =>
  import("../features/calendar/InviteBanner").then((m) => ({ default: m.InviteBanner })),
);
