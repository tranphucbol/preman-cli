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
import {
  bracketMatching,
  defaultHighlightStyle,
  foldGutter,
  foldKeymap,
  indentOnInput,
  syntaxHighlighting,
} from "@codemirror/language";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  placeholder as placeholderExtension,
} from "@codemirror/view";
import { cn } from "@preman/desktop/renderer/ui/cn.js";

export type CodeLanguage = "json" | "yaml" | "javascript" | "xml" | "text";

const LANGUAGE_EXTENSION: Record<CodeLanguage, () => Extension> = {
  json: () => json(),
  yaml: () => yaml(),
  javascript: () => javascript(),
  xml: () => xml(),
  text: () => [],
};

const FONT_SIZE = "12px";
const LINE_HEIGHT = "1.55";
const GUTTER_MIN_WIDTH = "2.25rem";

/**
 * Kept as one object so the whole editor's chrome is legible in one place. Colours are
 * `var(--color-*)` because the palette was contrast-audited once and must not be forked.
 */
const THEME = EditorView.theme(
  {
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
    ".cm-search label": { display: "inline-flex", alignItems: "center", gap: "4px", fontSize: "11px" },
    ".cm-textfield": {
      backgroundColor: "var(--color-control)",
      border: "1px solid var(--color-line-strong)",
      borderRadius: "var(--radius-sm)",
      color: "var(--color-ink)",
      fontSize: "12px",
      padding: "2px 6px",
    },
    ".cm-button": {
      backgroundColor: "var(--color-control)",
      backgroundImage: "none",
      border: "1px solid var(--color-line-strong)",
      borderRadius: "var(--radius-sm)",
      color: "var(--color-ink)",
      fontSize: "11px",
      padding: "2px 8px",
    },
  },
  { dark: true },
);

/** Recreated per mount rather than shared, so two open editors cannot fight over one compartment. */
function baseExtensions(language: CodeLanguage, readOnly: boolean, gutter: boolean, hint: string): Extension[] {
  return [
    history(),
    drawSelection(),
    indentOnInput(),
    bracketMatching(),
    closeBrackets(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    search({ top: false }),
    keymap.of([
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...searchKeymap,
      ...historyKeymap,
      ...foldKeymap,
      indentWithTab,
    ]),
    EditorView.lineWrapping,
    THEME,
    LANGUAGE_EXTENSION[language](),
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
}

export function CodeEditor({
  value,
  language = "text",
  readOnly = false,
  gutter = true,
  placeholder = "",
  className,
  onCommit,
}: CodeEditorProps) {
  const host = useRef<HTMLDivElement | null>(null);
  const view = useRef<EditorView | null>(null);
  // The commit callback is read through a ref so a new closure on every render does not
  // tear down and rebuild the editor, which would drop the undo history mid-edit.
  const commit = useRef(onCommit);
  // Synced in an effect rather than assigned during render. Writing a ref during render is a
  // real hazard in concurrent React: a render that gets thrown away still leaves its write
  // behind. An effect runs only for the render that committed.
  useEffect(() => {
    commit.current = onCommit;
  }, [onCommit]);

  useEffect(() => {
    const parent = host.current;
    if (parent === null) return;
    const language$ = new Compartment();
    const created = new EditorView({
      parent,
      state: EditorState.create({
        doc: value,
        extensions: [
          language$.of([]),
          ...baseExtensions(language, readOnly, gutter, placeholder),
          EditorView.domEventHandlers({
            blur: (_event, instance) => {
              commit.current?.(instance.state.doc.toString());
              return false;
            },
          }),
        ],
      }),
    });
    view.current = created;
    return () => {
      // Commit before teardown: switching sub-tab unmounts the editor, and losing the
      // last thing typed because it was never blurred is the worst kind of data loss.
      commit.current?.(created.state.doc.toString());
      created.destroy();
      view.current = null;
    };
    // `value` is the initial document only. Later changes are handled by the effect below,
    // which is why it is deliberately absent from these dependencies.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [language, readOnly, gutter, placeholder]);

  useEffect(() => {
    const instance = view.current;
    if (instance === null) return;
    const current = instance.state.doc.toString();
    if (current === value) return;
    instance.dispatch({ changes: { from: 0, to: current.length, insert: value } });
  }, [value]);

  return <div ref={host} className={cn("min-h-0 flex-1 overflow-hidden", className)} />;
}
