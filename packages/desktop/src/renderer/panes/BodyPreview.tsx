/**
 * What the authored text becomes: every `{{token}}` the workspace can resolve, substituted.
 *
 * The substitution is the engine's, never this pane's (ADR 025). Expansion is recursive,
 * cycle-guarded, depth-bounded and evaluates a dynamic variable per occurrence, so a second
 * implementation in the renderer would eventually show a value a run would not send.
 *
 * The pane is honest about the two ways it can disagree with a run, and says so in its footer
 * rather than in a changelog. It resolves from the layers on disk - globals and the chosen
 * environment, the two `readVariables` reports - so a token whose value comes from an iteration
 * data file or a `pm.variables.set` previews as unresolved and sends fine. And a dynamic variable
 * shows one sample of what a send would generate, not the value the next send will use.
 */
import { useEffect, useState } from "react";

import type { TextPreview } from "@preman/desktop/engine/protocol.js";

import { previewText, type Failure } from "@preman/desktop/renderer/actions.js";
import { useCatalogStore } from "@preman/desktop/renderer/stores/catalog.js";
import { useSessionStore } from "@preman/desktop/renderer/stores/session.js";
import { Banner } from "@preman/desktop/renderer/ui/Banner.js";
import { AnimatePresence } from "@preman/desktop/renderer/ui/motion.js";
import { CodeEditor } from "@preman/desktop/renderer/ui/CodeEditor.js";
import type { UnresolvedNames } from "@preman/desktop/renderer/ui/template.js";

const EMPTY = "";
const NO_DETAILS: readonly string[] = [];

const UNRESOLVED_MESSAGE = "Some tokens did not resolve. They are left exactly as they are written.";
const NO_ENVIRONMENT_LABEL = "no environment";
const RESOLVING_HINT = "Resolving…";

const DYNAMIC_NOTE = "Dynamic values are one sample: every send generates new ones.";
const RUNTIME_NOTE = "data, local and collection values exist only during a run, so they preview as unresolved.";

/**
 * The token as `interpolate` names it in its own error details, so a name read here and a name read
 * from a failed run are the same string.
 */
function asToken(name: string): string {
  return `{{${name}}}`;
}

function joined(names: readonly string[]): string {
  return names.map(asToken).join(", ");
}

/** One line per kind of failure to resolve, because the two have different answers. */
function unresolvedDetails(preview: TextPreview, environment: string): string[] {
  const lines: string[] = [];
  if (preview.missing.length > 0) lines.push(`Not defined in ${environment}: ${joined(preview.missing)}`);
  if (preview.unsupported.length > 0) lines.push(`Not implemented by preman: ${joined(preview.unsupported)}`);
  return lines;
}

export function BodyPreview({
  text,
  onResolved,
}: {
  readonly text: string;
  /**
   * The unresolved half of the same answer, for the editor's linter (Phase 3 of plan 017).
   *
   * Reported upward rather than resolved twice. It is also why an editor whose Preview was never
   * opened lints nothing: a warning that costs a round trip must not be triggered by a keystroke.
   */
  readonly onResolved?: (unresolved: UnresolvedNames) => void;
}): React.JSX.Element {
  const environment = useSessionStore((state) => state.environment);
  // The same two triggers `VariablesPane` follows: a reconcile is how a script's writeback
  // reaches this pane, and the write counter is how the token box's own write reaches it before
  // the watcher has caught up.
  const revision = useCatalogStore((state) => state.revision);
  const writes = useSessionStore((state) => state.variableWrites);

  const [preview, setPreview] = useState<TextPreview | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);

  useEffect(() => {
    let live = true;
    void previewText(text).then((result) => {
      if (!live) return;
      if (result.ok) {
        setPreview(result.value);
        setFailure(null);
        onResolved?.({ names: new Set(result.value.missing), environment: environment ?? NO_ENVIRONMENT_LABEL });
        return;
      }
      setFailure(result.failure);
    });
    return () => {
      // An older answer must not be the one that lands: it would describe a text, or a chain of
      // layers, that is no longer the one a run would use.
      live = false;
    };
    // `onResolved` must be stable - a `useState` setter or a `useCallback` - or this re-resolves
    // on every render of the pane above.
  }, [text, environment, revision, writes, onResolved]);

  const details = preview === null ? NO_DETAILS : unresolvedDetails(preview, environment ?? NO_ENVIRONMENT_LABEL);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* One presence per banner rather than one around both: AnimatePresence needs a key per
          child to tell two siblings apart, and two wrappers say the same thing without inventing
          one. */}
      <AnimatePresence>
        {failure !== null && <Banner tone="danger" message={failure.message} details={failure.details} />}
      </AnimatePresence>
      <AnimatePresence>
        {details.length > 0 && <Banner tone="warn" message={UNRESOLVED_MESSAGE} details={details} />}
      </AnimatePresence>
      <CodeEditor value={preview?.text ?? EMPTY} language="json" readOnly placeholder={RESOLVING_HINT} />
      <div className="shrink-0 border-t border-line px-gutter py-1.5">
        <p className="text-2xs text-ink-faint">{DYNAMIC_NOTE}</p>
        <p className="text-2xs text-ink-faint">{RUNTIME_NOTE}</p>
      </div>
    </div>
  );
}
