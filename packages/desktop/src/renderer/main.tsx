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
import { applyStoredPreferences } from "@preman/desktop/renderer/stores/appearance.js";
import "./app.css";

const ROOT_ID = "app";

const container = document.getElementById(ROOT_ID);
if (container === null) {
  throw new Error(`index.html is missing #${ROOT_ID}`);
}

// Before `render`, and not in an effect. React's first commit is the first thing the user sees; a
// theme applied after it is a frame of the wrong colours, which on a light theme is a white app
// flashing dark. The preferences are already here — the preload read them synchronously so that
// this line has nothing to wait for. See `docs/decisions/022`.
applyStoredPreferences();

createRoot(container).render(<App />);
