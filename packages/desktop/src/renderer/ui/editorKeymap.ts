/**
 * CodeMirror's default keymap, less the one key the window owns.
 *
 * `defaultKeymap` binds `Mod-Enter` to `insertBlankLine`, which would run before the window's
 * Send shortcut and leave a stray line in the body. Dropped so the key only sends. It lives here,
 * reaching nothing, so the claim can be asserted without a window.
 */
import { defaultKeymap } from "@codemirror/commands";

export const SEND_KEY = "Mod-Enter";

export const EDITOR_KEYMAP = defaultKeymap.filter((binding) => binding.key !== SEND_KEY);
