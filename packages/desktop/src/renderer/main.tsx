/**
 * The renderer entry.
 *
 * No StrictMode. It double-invokes effects, and the effect that matters here takes a
 * transferred `MessagePort` and subscribes to it: running it twice would attach two listeners
 * to one port and double every push. The bug StrictMode exists to surface is one this app
 * cannot afford to simulate.
 */
import { createRoot } from "react-dom/client";

import { App } from "@preman/desktop/renderer/App.js";
import "./app.css";

const ROOT_ID = "app";

const container = document.getElementById(ROOT_ID);
if (container === null) {
  throw new Error(`index.html is missing #${ROOT_ID}`);
}

createRoot(container).render(<App />);
