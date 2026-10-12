import { useEffect, useLayoutEffect } from "react";

import { trafficLightClearance } from "../../../shared/window-chrome";
import { useRunMail, withMail } from "../state/mail";
import { connectTitlebar, useTitlebarArea } from "../ui/TrafficLights";

/**
 * Connects this window's traffic-light spacers to main and sets
 * `--titlebar-clearance`, the strip a full-window sheet keeps clear for the
 * lights. Mount once per desktop window.
 */
export function WindowChrome() {
  const run = useRunMail();
  const area = useTitlebarArea();
  useLayoutEffect(() => {
    document.documentElement.style.setProperty(
      "--titlebar-clearance",
      `${trafficLightClearance(area)}px`,
    );
  }, [area]);
  useEffect(
    () =>
      connectTitlebar((height) => run(withMail((call) => call("SetTitlebarHeight", { height })))),
    [run],
  );
  return null;
}
