import { WindowKeys } from "./app/WindowKeys";
import { WindowUi } from "./app/WindowUi";
import { createAppHashHistory } from "./routes/hash-history";
import { renderApp } from "./routes/render-app";
import "./styles.css";
import { TitlebarClearance } from "./ui/TrafficLights";

renderApp(
  createAppHashHistory(),
  <>
    <WindowKeys />
    <WindowUi />
    <TitlebarClearance />
  </>,
);
