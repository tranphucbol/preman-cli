/**
 * The seam between CodeMirror's search state and preman's own find bar.
 *
 * CodeMirror keeps the query, the match highlighting and the open/closed state; it lets a
 * caller replace only the panel. This module supplies an empty panel for React to portal the
 * bar into, the few commands every editor binds, and the hook the bar uses to take over
 * stepping when the hits it is stepping through are the engine's rather than the document's.
 */
import {
  findNext,
  findPrevious,
  getSearchQuery,
  openSearchPanel,
  SearchQuery,
  setSearchQuery,
} from "@codemirror/search";
import { EditorState, StateEffect, StateField, type Extension } from "@codemirror/state";
import { EditorView, runScopeHandlers, type KeyBinding, type Panel } from "@codemirror/view";

import { nearestMatch, openingQuery } from "@preman/desktop/renderer/model/find.js";

const PANEL_CLASS = "pm-find-panel";
/** The scope CodeMirror's panel keymap runs in; bindings in it fire from the bar's fields too. */
const PANEL_SCOPE = "editor search-panel";

const FOCUSABLE = { tabindex: "0" };

/**
 * Whether the document takes input, and whether it can still take focus when it does not.
 *
 * A read-only document is still something to select, copy and search. `editable: false` drops
 * `contenteditable` without leaving a `tabindex` behind, so the content could never take focus
 * and no key binding - `Cmd+F` among them - could ever reach it. Here rather than in
 * `CodeEditor` because find is what needs it, and so it can be asserted without a window.
 */
export function editability(readOnly: boolean): Extension[] {
  return [
    EditorState.readOnly.of(readOnly),
    EditorView.editable.of(!readOnly),
    ...(readOnly ? [EditorView.contentAttributes.of(FOCUSABLE)] : []),
  ];
}

/** What the bar needs from the editor it sits in. */
export interface FindHost {
  readonly dom: HTMLElement;
  readonly view: EditorView;
  /** Called on every editor update while the bar is open. */
  readonly subscribe: (listener: () => void) => () => void;
  /**
   * Install how the bar steps through hits. F3 and `Mod-g` route through it, from the
   * document and from the bar alike, so the engine's hits are stepped the same way.
   */
  readonly setStepper: (step: Stepper | null) => void;
}

export type Stepper = (forward: boolean) => boolean;

interface HostState {
  stepper: Stepper | null;
}

/** Keyed by view so a binding, which only receives the view, can reach the bar's stepper. */
const hosts = new WeakMap<EditorView, HostState>();

const setReplaceOpen = StateEffect.define<boolean>();
/** Bumped by every `openFind`, so the bar knows to take focus and select its query. */
const requestFocus = StateEffect.define<null>();

export interface FindPanelState {
  readonly replaceOpen: boolean;
  readonly openings: number;
}

export const findPanelField = StateField.define<FindPanelState>({
  create: () => ({ replaceOpen: false, openings: 0 }),
  update(value, transaction) {
    let next = value;
    for (const effect of transaction.effects) {
      if (effect.is(setReplaceOpen)) next = { ...next, replaceOpen: effect.value };
      if (effect.is(requestFocus)) next = { ...next, openings: next.openings + 1 };
    }
    return next;
  },
});

/**
 * The panel CodeMirror mounts: an empty element, announced to whoever renders into it.
 *
 * Keys pressed inside it run the panel-scoped keymap first, which is how `Escape` closes the
 * bar - and, because the handled event is cancelled, how it stays claimed rather than also
 * closing whatever dialog the editor sits in.
 */
export function findPanel(onHost: (host: FindHost | null) => void): (view: EditorView) => Panel {
  return (view) => {
    const dom = document.createElement("div");
    dom.className = PANEL_CLASS;
    const listeners = new Set<() => void>();
    const state: HostState = { stepper: null };
    hosts.set(view, state);
    dom.addEventListener("keydown", (event) => {
      if (runScopeHandlers(view, event, "search-panel")) event.preventDefault();
    });
    const host: FindHost = {
      dom,
      view,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      setStepper: (step) => {
        state.stepper = step;
      },
    };
    return {
      dom,
      top: true,
      mount: () => {
        onHost(host);
      },
      update: () => {
        for (const listener of listeners) listener();
      },
      destroy: () => {
        hosts.delete(view);
        onHost(null);
      },
    };
  };
}

interface QuerySpec {
  readonly search: string;
  readonly caseSensitive: boolean;
  readonly literal: boolean;
  readonly regexp: boolean;
  readonly wholeWord: boolean;
  readonly replace: string;
}

/** The query with some of its fields changed and the rest kept. */
export function withQuery(query: SearchQuery, patch: Partial<QuerySpec>): SearchQuery {
  return new SearchQuery({
    search: query.search,
    caseSensitive: query.caseSensitive,
    literal: query.literal,
    regexp: query.regexp,
    wholeWord: query.wholeWord,
    replace: query.replace,
    ...patch,
  });
}

/** Show or hide the replace row without touching the query. */
export function showReplace(view: EditorView, open: boolean): void {
  view.dispatch({ effects: setReplaceOpen.of(open) });
}

/**
 * Open the bar, or refocus it when it is already open, seeded from the selection when the
 * selection reads as a search term. `replace` also opens the second row.
 */
export function openFind(view: EditorView, replace = false): boolean {
  const previous = getSearchQuery(view.state);
  const search = openingQuery(view.state, previous.search);
  openSearchPanel(view);
  view.dispatch({
    effects: [setSearchQuery.of(withQuery(previous, { search })), setReplaceOpen.of(replace), requestFocus.of(null)],
  });
  return true;
}

/**
 * Replace the query with what the reader typed, and move the selection to the nearest hit at
 * or after the caret so the document follows the typing. `follow` is off when the hits are
 * the engine's: the window on screen is not where they are.
 */
export function setFindText(view: EditorView, query: SearchQuery, follow: boolean): void {
  const match = follow ? nearestMatch(view.state, query, view.state.selection.main.from) : null;
  view.dispatch({
    effects: [
      setSearchQuery.of(query),
      ...(match === null ? [] : [EditorView.scrollIntoView(match.from, { y: "center" })]),
    ],
    ...(match === null ? {} : { selection: { anchor: match.from, head: match.to } }),
  });
}

function step(forward: boolean): (view: EditorView) => boolean {
  return (view) => {
    const stepper = hosts.get(view)?.stepper ?? null;
    if (stepper !== null) return stepper(forward);
    return forward ? findNext(view) : findPrevious(view);
  };
}

/**
 * Bound ahead of CodeMirror's `searchKeymap`, so these win where both name a key. `Mod-Alt-f`
 * rather than the usual `Mod-r`, because `Mod-r` is reload in an Electron window.
 */
export function findKeymap(editable: boolean): readonly KeyBinding[] {
  return [
    { key: "Mod-f", run: (view) => openFind(view), scope: PANEL_SCOPE, preventDefault: true },
    ...(editable
      ? [
          {
            key: "Mod-Alt-f",
            run: (view: EditorView) => openFind(view, true),
            scope: PANEL_SCOPE,
            preventDefault: true,
          },
        ]
      : []),
    { key: "F3", run: step(true), shift: step(false), scope: PANEL_SCOPE, preventDefault: true },
    { key: "Mod-g", run: step(true), shift: step(false), scope: PANEL_SCOPE, preventDefault: true },
  ];
}
