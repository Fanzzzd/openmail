import type { QuitInstall } from "../app/quit";

/** Before-quit approval arms the plan; a cancelled quit never reaches the native handoff. */
let approved = false;
let prepare: (() => Promise<QuitInstall | null>) | undefined;
export function approveUpdateQuit(value = true) {
  approved = value;
}
export function setUpdateQuitPlan(plan: () => Promise<QuitInstall | null>) {
  prepare = plan;
  return () => {
    if (prepare === plan) prepare = undefined;
  };
}
export function prepareUpdateQuit(): Promise<QuitInstall | null> {
  return approved && prepare ? prepare() : Promise.resolve(null);
}
