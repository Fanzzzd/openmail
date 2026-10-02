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

export const Settings: ComponentType<Parameters<typeof import("./Settings").Settings>[0]> = dialog<
  Parameters<typeof import("./Settings").Settings>[0]
>(() => import("./Settings").then((m) => ({ default: m.Settings })));
export const Composer: ComponentType<Parameters<typeof import("./Composer").Composer>[0]> = dialog<
  Parameters<typeof import("./Composer").Composer>[0]
>(() => import("./Composer").then((m) => ({ default: m.Composer })));
export const AddAccountDialog: ComponentType<
  Parameters<typeof import("./AddAccountDialog").AddAccountDialog>[0]
> = dialog<Parameters<typeof import("./AddAccountDialog").AddAccountDialog>[0]>(() =>
  import("./AddAccountDialog").then((m) => ({ default: m.AddAccountDialog })),
);
export const ShortcutHelp: ComponentType<
  Parameters<typeof import("./SystemSettings").ShortcutHelp>[0]
> = dialog<Parameters<typeof import("./SystemSettings").ShortcutHelp>[0]>(() =>
  import("./SystemSettings").then((m) => ({ default: m.ShortcutHelp })),
);
export const ProfileEditor: ComponentType<
  Parameters<typeof import("./ProfileEditor").ProfileEditor>[0]
> = dialog<Parameters<typeof import("./ProfileEditor").ProfileEditor>[0]>(() =>
  import("./ProfileEditor").then((m) => ({ default: m.ProfileEditor })),
);
export const Feedback: ComponentType<Parameters<typeof import("./Feedback").Feedback>[0]> = dialog<
  Parameters<typeof import("./Feedback").Feedback>[0]
>(() => import("./Feedback").then((m) => ({ default: m.Feedback })));
export const Proposals: ComponentType<Parameters<typeof import("./Proposals").Proposals>[0]> =
  dialog<Parameters<typeof import("./Proposals").Proposals>[0]>(() =>
    import("./Proposals").then((m) => ({ default: m.Proposals })),
  );
export const CreateLabelDialog: ComponentType<
  Parameters<typeof import("./CreateLabelDialog").CreateLabelDialog>[0]
> = dialog<Parameters<typeof import("./CreateLabelDialog").CreateLabelDialog>[0]>(() =>
  import("./CreateLabelDialog").then((m) => ({ default: m.CreateLabelDialog })),
);
export const FilterEditor: ComponentType<
  Parameters<typeof import("./ServerSettings").FilterEditor>[0]
> = dialog<Parameters<typeof import("./ServerSettings").FilterEditor>[0]>(() =>
  import("./ServerSettings").then((m) => ({ default: m.FilterEditor })),
);
export const RawMessageDialog: ComponentType<
  Parameters<typeof import("./RawMessage").RawMessageDialog>[0]
> = dialog<Parameters<typeof import("./RawMessage").RawMessageDialog>[0]>(() =>
  import("./RawMessage").then((m) => ({ default: m.RawMessageDialog })),
);
export const InviteBanner: ComponentType<
  Parameters<typeof import("./InviteBanner").InviteBanner>[0]
> = dialog<Parameters<typeof import("./InviteBanner").InviteBanner>[0]>(() =>
  import("./InviteBanner").then((m) => ({ default: m.InviteBanner })),
);
