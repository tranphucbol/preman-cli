/**
 * The one text editor in the app: request bodies, scripts, raw YAML, and the response
 * viewer (decision 16). One keymap, one theme, one find widget, so a shortcut learned in a
 * body works in a script.
 *
 * The theme reads the same CSS variables as the rest of the app rather than restating
 * hex values, so retuning a token retunes the editor with it. That is the whole reason
 * this is a `EditorView.theme` over variables and not a stock CodeMirror theme package.
 *
 * Uncontrolled, like every other input here: the caller passes `value` for the *document
 * it wants loaded* and gets `onCommit` on blur. Pushing a new document into a live editor
 * only happens when the incoming text actually differs from what is on screen, because
 * doing it on every render would fight the cursor.
 */

import { useEffect, useRef } from "react";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { xml } from "@codemirror/lang-xml";
import { yaml } from "@codemirror/lang-yaml";
import { bracketMatching, foldGutter, foldKeymap, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState, type Extension, type StateField } from "@codemirror/state";
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  placeholder as placeholderExtension,
} from "@codemirror/view";
import { clearFlush, registerFlush } from "@preman/desktop/renderer/pending.js";
import type { Variant } from "@preman/desktop/renderer/appearance/theme.js";
import { useAppearanceStore } from "@preman/desktop/renderer/stores/appearance.js";
import { cn } from "@preman/desktop/renderer/ui/cn.js";
import { HIGHLIGHT_STYLE } from "@preman/desktop/renderer/ui/highlight.js";
import {
  NOTHING_ASKED,
  jsonTemplate,
  setUnresolved,
  tokenClicks,
  unresolvedField,
  type TokenReporter,
  type UnresolvedNames,
} from "@preman/desktop/renderer/ui/template.js";

/**
 * `json-template` is JSON that may contain `{{token}}`, which plain JSON is not. It is the language
 * for a body someone authored; a body that came back off the wire is already interpolated and takes
 * plain `json`. See `ui/template.ts` for what the difference costs.
 */
export type CodeLanguage = "json" | "json-template" | "yaml" | "javascript" | "xml" | "text";

/**
 * The field is threaded through rather than owned here so that only the language that has tokens
 * can be given one. Every other entry ignores it, which is the point: `json` is a body that came
 * back off the wire and has nothing left to resolve.
 */
const LANGUAGE_EXTENSION: Record<CodeLanguage, (unresolved?: StateField<UnresolvedNames>) => Extension> = {
  json: () => json(),
  "json-template": (unresolved) => jsonTemplate(unresolved),
  yaml: () => yaml(),
  javascript: () => javascript(),
  xml: () => xml(),
  text: () => [],
};

/**
 * The document's size is a reading preference the settings pane writes; the find panel's is not.
 * A find panel that grew to 20px because someone wanted a bigger document would be a control
 * sized by the wrong question, so it stays on the density scale like every other control.
 */
const FONT_SIZE = "var(--editor-font-size)";
const PANEL_FONT_SIZE = "var(--text-xs)";
const PANEL_LABEL_SIZE = "var(--text-2xs)";
const LINE_HEIGHT = "1.55";
const GUTTER_MIN_WIDTH = "2.25rem";

/**
 * Kept as one object so the whole editor's chrome is legible in one place. Colours are
 * `var(--color-*)` because the palette was contrast-audited once and must not be forked.
 */
const THEME_SPEC = {
  "&": {
    backgroundColor: "transparent",
    color: "var(--color-ink)",
    fontSize: FONT_SIZE,
    height: "100%",
  },
  ".cm-scroller": {
    fontFamily: "var(--font-mono)",
    lineHeight: LINE_HEIGHT,
    overflow: "auto",
  },
  ".cm-content": { padding: "6px 0", caretColor: "var(--color-accent)" },
  ".cm-line": { padding: "0 10px" },
  "&.cm-focused": { outline: "none" },
  ".cm-gutters": {
    backgroundColor: "transparent",
    color: "var(--color-ink-faint)",
    border: "none",
    minWidth: GUTTER_MIN_WIDTH,
  },
  ".cm-gutterElement": { padding: "0 6px 0 8px" },
  ".cm-activeLine": { backgroundColor: "var(--color-hover)" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--color-ink-dim)" },
  ".cm-foldPlaceholder": {
    backgroundColor: "var(--color-control)",
    border: "1px solid var(--color-line-strong)",
    color: "var(--color-ink-dim)",
    padding: "0 4px",
    borderRadius: "var(--radius-xs)",
  },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection": {
    backgroundColor: "var(--color-selected)",
  },
  ".cm-cursor": { borderLeftColor: "var(--color-accent)" },
  ".cm-matchingBracket, &.cm-focused .cm-matchingBracket": {
    backgroundColor: "var(--color-control)",
    outline: "1px solid var(--color-line-strong)",
  },
  ".cm-selectionMatch": { backgroundColor: "var(--color-control)" },
  ".cm-placeholder": { color: "var(--color-ink-faint)" },
  // The find widget ships as a browser-styled form. Retuned here for the same reason
  // Radix is retuned: a stock panel in a dense tool reads as somebody else's software.
  ".cm-panels": { backgroundColor: "var(--color-panel)", color: "var(--color-ink)" },
  ".cm-panels.cm-panels-bottom": { borderTop: "1px solid var(--color-line)" },
  ".cm-search": { display: "flex", alignItems: "center", gap: "6px", padding: "5px 8px" },
  ".cm-search label": { display: "inline-flex", alignItems: "center", gap: "4px", fontSize: PANEL_LABEL_SIZE },
  ".cm-textfield": {
    backgroundColor: "var(--color-control)",
    border: "1px solid var(--color-line-strong)",
    borderRadius: "var(--radius-sm)",
    color: "var(--color-ink)",
    fontSize: PANEL_FONT_SIZE,
    padding: "2px 6px",
  },
  ".cm-button": {
    backgroundColor: "var(--color-control)",
    backgroundImage: "none",
    border: "1px solid var(--color-line-strong)",
    borderRadius: "var(--radius-sm)",
    color: "var(--color-ink)",
    fontSize: PANEL_LABEL_SIZE,
    padding: "2px 8px",
  },
};

/**
 * Two themes over one spec, differing only in the flag.
 *
 * Nothing in the rules above depends on the variant — they are all `var(--color-*)`, and those are
 * rewritten by `apply.ts` — but `dark` is not a colour. It decides which of CodeMirror's own
 * built-in styles apply and it puts `cm-dark` on the element, which is what a future extension
 * shipping its own light and dark rules will look at. It is the one thing about the editor a
 * custom property cannot express, and therefore the one thing that needs a compartment.
 */
const THEMES: Readonly<Record<Variant, Extension>> = {
  dark: EditorView.theme(THEME_SPEC, { dark: true }),
  light: EditorView.theme(THEME_SPEC, { dark: false }),
};

/**
 * How close to an end of the scroller counts as having reached it. Roughly a screen of a
 * small font: enough warning that the next window is on its way before the reader arrives.
 */
const EDGE_THRESHOLD_PX = 200;
const SCROLL_TOP = 0;

/**
 * How long the document can sit unchanged before it commits on its own.
 *
 * Below the point where a user starts wondering whether the Save button is broken, and far
 * above a keystroke: a ten-minute typing session still contributes exactly one entry to
 * `edits`, because `upsert` is keyed by field path (`stores/tabs.ts`).
 */
const IDLE_COMMIT_MS = 300;

/** Which end of the document the reader has reached. */
export type ScrollEdge = "top" | "bottom";

/** Recreated per mount rather than shared, so two open editors cannot fight over one compartment. */
function baseExtensions(
  language: CodeLanguage,
  readOnly: boolean,
  gutter: boolean,
  hint: string,
  engineFind: boolean,
  unresolved: StateField<UnresolvedNames> | undefined,
  theme: Extension,
): Extension[] {
  return [
    history(),
    drawSelection(),
    indentOnInput(),
    bracketMatching(),
    closeBrackets(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    syntaxHighlighting(HIGHLIGHT_STYLE, { fallback: true }),
    // An editor showing one window of a much larger document must not offer to search it:
    // the panel would report "no matches" for text that is certainly there. Dropping the
    // extension and the keymap together is what makes that impossible rather than unlikely.
    ...(engineFind ? [] : [search({ top: false })]),
    keymap.of([
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...(engineFind ? [] : searchKeymap),
      ...historyKeymap,
      ...foldKeymap,
      indentWithTab,
    ]),
    EditorView.lineWrapping,
    theme,
    LANGUAGE_EXTENSION[language](unresolved),
    ...(gutter ? [lineNumbers(), highlightActiveLineGutter(), foldGutter()] : []),
    ...(hint === "" ? [] : [placeholderExtension(hint)]),
    EditorState.readOnly.of(readOnly),
    EditorView.editable.of(!readOnly),
  ];
}

export interface CodeEditorProps {
  readonly value: string;
  readonly language?: CodeLanguage;
  readonly readOnly?: boolean;
  readonly gutter?: boolean;
  readonly placeholder?: string;
  readonly className?: string;
  readonly onCommit?: (value: string) => void;
  /**
   * Take over `Cmd+F`. Supplying this also removes CodeMirror's own search, so the editor
   * cannot answer a search question about a document it only partly holds.
   */
  readonly onFind?: () => void;
  /**
   * Called while the reader is within `EDGE_THRESHOLD_PX` of either end. Fires on every
   * scroll event, so a caller that loads on it must guard against re-entry itself.
   */
  readonly onEdge?: (edge: ScrollEdge) => void;
  /**
   * Which names do not resolve, for the `json-template` linter. Supplying it at all - even as
   * `NOTHING_ASKED` - is what installs the linter, so an editor that never previews carries
   * neither the field nor the debounced pass over its document.
   */
  readonly unresolved?: UnresolvedNames;
  /**
   * Called when a `{{token}}` is clicked, with the name and the rect it was drawn in. The click
   * still places the caret: this is an addition to the gesture, not a replacement for it.
   */
  readonly onToken?: TokenReporter;
}

export function CodeEditor({
  value,
  language = "text",
  readOnly = false,
  gutter = true,
  placeholder = "",
  className,
  onCommit,
  onFind,
  onEdge,
  unresolved,
  onToken,
}: CodeEditorProps) {
  const host = useRef<HTMLDivElement | null>(null);
  const view = useRef<EditorView | null>(null);
  /** Set by the mount effect, read by the two effects that reach into a live view. */
  const variant$ = useRef<Compartment | null>(null);
  /** The linter's field, when this editor has one. Read by the effect that pushes an answer in. */
  const unresolved$ = useRef<StateField<UnresolvedNames> | null>(null);

  const variant = useAppearanceStore((state) => state.theme.variant);
  const editorFontSize = useAppearanceStore((state) => state.preferences.editorFontSize);

  // The callbacks are read through refs so a new closure on every render does not tear down
  // and rebuild the editor, which would drop the undo history mid-edit.
  const commit = useRef(onCommit);
  const find = useRef(onFind);
  const edge = useRef(onEdge);
  const token = useRef(onToken);
  // Synced in an effect rather than assigned during render. Writing a ref during render is a
  // real hazard in concurrent React: a render that gets thrown away still leaves its write
  // behind. An effect runs only for the render that committed.
  useEffect(() => {
    commit.current = onCommit;
    find.current = onFind;
    edge.current = onEdge;
    token.current = onToken;
  }, [onCommit, onFind, onEdge, onToken]);

  // Whether the editor was built without its own search. A boolean rather than the callback
  // itself, so passing a fresh arrow every render does not rebuild the editor.
  const engineFind = onFind !== undefined;

  // Same reason, for the token gesture: a pane that renders a fresh handler every keystroke must
  // not be able to rebuild the view and drop the undo history.
  const clicksTokens = onToken !== undefined;

  // Whether this editor lints. A boolean for the same reason `engineFind` is one: the answer
  // itself changes on every preview, and rebuilding the view on it would drop the undo history
  // mid-edit. The answer is pushed in as an effect instead, by the effect below.
  //
  // `NOTHING_ASKED` counts as no linter and not as an empty one. Measured: installing `linter()`
  // over a document nobody has asked about costs the worst keystroke in a typing burst about 30ms
  // - it is a debounced full pass over the document either way - and it can report nothing, so an
  // editor whose Preview was never opened carries none of it. That is the same sentence the plan
  // writes as "lints nothing", now enforced rather than merely true.
  const lints = unresolved !== undefined && unresolved !== NOTHING_ASKED;

  useEffect(() => {
    const parent = host.current;
    if (parent === null) return;
    const language$ = new Compartment();
    const theme$ = new Compartment();
    variant$.current = theme$;
    const unresolvedNames = lints ? unresolvedField() : undefined;
    unresolved$.current = unresolvedNames ?? null;

    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    // The flush this editor currently has registered, so `blur` and teardown clear the exact
    // registration `focus` made rather than whatever the registry happens to hold - a torn-down
    // editor must not clear a newer editor's flush.
    let flush: (() => void) | null = null;

    function clearIdleTimer(): void {
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      idleTimer = undefined;
    }

    // The one path every commit goes through: blur, teardown, a debounced idle tick, and an
    // explicit flush from `Cmd+S` all land here, and all of them cancel a timer that would
    // otherwise fire again over a document that was just committed.
    function commitNow(instance: EditorView): void {
      clearIdleTimer();
      commit.current?.(instance.state.doc.toString());
    }

    // Read rather than closed over: the variant is not a dependency of this effect, because
    // changing the theme must reconfigure the editor rather than rebuild it and lose the history.
    const created = new EditorView({
      parent,
      state: EditorState.create({
        doc: value,
        extensions: [
          language$.of([]),
          ...baseExtensions(
            language,
            readOnly,
            gutter,
            placeholder,
            engineFind,
            unresolvedNames,
            theme$.of(THEMES[useAppearanceStore.getState().theme.variant]),
          ),
          ...(engineFind
            ? [
                keymap.of([
                  {
                    key: "Mod-f",
                    run: () => {
                      find.current?.();
                      return true;
                    },
                  },
                ]),
              ]
            : []),
          // Honest-while-typing (decision 7 in 016): a document sitting idle for
          // `IDLE_COMMIT_MS` commits itself, so the Save button's `disabled` state and the
          // sidebar's unsaved mark do not lag an unblurred editor by however long the caret
          // stays in it.
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) return;
            clearIdleTimer();
            idleTimer = setTimeout(() => {
              idleTimer = undefined;
              commit.current?.(update.view.state.doc.toString());
            }, IDLE_COMMIT_MS);
          }),
          EditorView.domEventHandlers({
            focus: (_event, instance) => {
              flush = () => commitNow(instance);
              registerFlush(flush);
              return false;
            },
            blur: (_event, instance) => {
              if (flush !== null) clearFlush(flush);
              flush = null;
              commitNow(instance);
              return false;
            },
            scroll: (_event, instance) => {
              const reached = edge.current;
              if (reached === undefined) return false;
              const { scrollTop, scrollHeight, clientHeight } = instance.scrollDOM;
              if (scrollTop <= EDGE_THRESHOLD_PX) reached("top");
              else if (scrollHeight - (scrollTop + clientHeight) <= EDGE_THRESHOLD_PX) reached("bottom");
              return false;
            },
          }),
          ...(clicksTokens ? [tokenClicks((clicked, at) => token.current?.(clicked, at))] : []),
        ],
      }),
    });
    view.current = created;
    return () => {
      // Commit before teardown: switching sub-tab unmounts the editor, and losing the
      // last thing typed because it was never blurred is the worst kind of data loss.
      if (flush !== null) clearFlush(flush);
      commitNow(created);
      created.destroy();
      view.current = null;
      variant$.current = null;
      unresolved$.current = null;
    };
    // `value` is the initial document only. Later changes are handled by the effect below,
    // which is why it is deliberately absent from these dependencies.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [language, readOnly, gutter, placeholder, engineFind, lints, clicksTokens]);

  /** The answer, pushed into a live editor. A reconfigure would rebuild the lint state for nothing. */
  useEffect(() => {
    const instance = view.current;
    if (instance === null || unresolved$.current === null) return;
    instance.dispatch({ effects: setUnresolved.of(unresolved ?? NOTHING_ASKED) });
  }, [unresolved]);

  /**
   * The only transaction the appearance feature dispatches. Every colour in the editor is a custom
   * property and repaints on its own; `dark` is a flag inside the state, so it needs one.
   */
  useEffect(() => {
    const instance = view.current;
    const compartment = variant$.current;
    if (instance === null || compartment === null) return;
    instance.dispatch({ effects: compartment.reconfigure(THEMES[variant]) });
  }, [variant]);

  /**
   * CodeMirror measures one character once and lays the document out from that number, so a font
   * size that changed under it produces a cursor in the wrong column and a scroller the wrong
   * height. The CSS is already right by the time this runs; this is only the editor being told.
   */
  useEffect(() => {
    view.current?.requestMeasure();
  }, [editorFontSize]);

  useEffect(() => {
    const instance = view.current;
    if (instance === null) return;
    const current = instance.state.doc.toString();
    if (current === value) return;
    // Growth at the end is dispatched as an append rather than a whole-document replacement.
    // The windowed body viewer grows its document every time the reader nears the bottom, and
    // replacing the document there would drop their scroll position on every window.
    if (value.startsWith(current)) {
      instance.dispatch({ changes: { from: current.length, insert: value.slice(current.length) } });
      return;
    }
    instance.dispatch({ changes: { from: 0, to: current.length, insert: value } });
    // A document that is not a continuation of the last one is a different piece of text, so
    // the reader's old offset into it means nothing. Keeping the scroll would leave them
    // somewhere arbitrary in the new content.
    instance.scrollDOM.scrollTop = SCROLL_TOP;
  }, [value]);

  return <div ref={host} className={cn("min-h-0 flex-1 overflow-hidden", className)} />;
}
