import { WindowKeys } from "./app/WindowKeys";
import { WindowUi } from "./app/WindowUi";
import { createAppHashHistory } from "./routes/hash-history";
import { renderApp } from "./routes/render-app";
import "./styles.css";

renderApp(
  createAppHashHistory(),
  <>
    <WindowKeys />
    <WindowUi />
  </>,
);
