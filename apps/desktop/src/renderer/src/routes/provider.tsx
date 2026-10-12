import { RegistryContext } from "@effect/atom-react";
import { RouterProvider } from "@tanstack/react-router";
import { useContext } from "react";
import { defaultHref, rememberedViewsAtom } from "../state/location";
import type { AppRouter } from "./router";

/** The router, with `/` landing on the view seen most recently in this window. */
export function AppRouterProvider({ router }: { router: AppRouter }) {
  const registry = useContext(RegistryContext);
  return (
    <RouterProvider
      router={router}
      context={{ defaultHref: () => defaultHref(registry.get(rememberedViewsAtom)) }}
    />
  );
}
