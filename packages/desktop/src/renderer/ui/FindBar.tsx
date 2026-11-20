/**
 * Find, and in an editable editor replace, for every CodeMirror document in the app.
 *
 * One bar whether the editor holds the whole text or a window of a body the engine holds:
 * CodeMirror's search state is the query either way, and only counting and stepping change
 * hands. That is ADR 014's "one find widget", which the stock panel and the body viewer's own
 * search row had quietly split in two (plan 023).
 */
import {
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  replaceAll,
  replaceNext,
  SearchQuery,
  setSearchQuery,
} from "@codemirror/search";
import type { EditorState, Text } from "@codemirror/state";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import {
  countFailed,
  counterSpoken,
  counterText,
  countOf,
  FIND_COUNT_DEBOUNCE_MS,
  FIND_COUNT_EAGER_CHARS,
  findMatches,
  type FindCount,
  type FoundMatches,
  type RemoteFind,
} from "@preman/desktop/renderer/model/find.js";
import { cn } from "@preman/desktop/renderer/ui/cn.js";
import { Button, Field, IconButton } from "@preman/desktop/renderer/ui/Controls.js";
import {
  findPanelField,
  setFindText,
  showReplace,
  withQuery,
  type FindHost,
  type Stepper,
} from "@preman/desktop/renderer/ui/findPanel.js";
import {
  CaretRightIcon,
  CloseIcon,
  GLYPH_CLASS,
  NextMatchIcon,
  PreviousMatchIcon,
  SearchIcon,
} from "@preman/desktop/renderer/ui/icons.js";

const ENTER = "Enter";
const FIND_LABEL = "Find";
const REPLACE_LABEL = "Replace";
const REPLACE_ALL_LABEL = "Replace all";
const PREVIOUS_HINT = "Previous match (⇧Enter)";
const NEXT_HINT = "Next match (Enter)";
const CLOSE_HINT = "Close (Esc)";
const SHOW_REPLACE_HINT = "Replace (⌘⌥F)";
const HIDE_REPLACE_HINT = "Hide replace";
const REMOTE_HINT = "Bodies preman does not hold are searched exactly as typed";

type FindOption = "caseSensitive" | "wholeWord" | "regexp";

/** The three toggles, in the order they sit after the field. Text glyphs, as every editor draws them. */
const OPTIONS: readonly { readonly option: FindOption; readonly glyph: string; readonly label: string }[] = [
  { option: "caseSensitive", glyph: "Aa", label: "Match case" },
  { option: "wholeWord", glyph: "W", label: "Whole word" },
  { option: "regexp", glyph: ".*", label: "Regex" },
];

/** What the engine's search is, said as a query: exact bytes, nothing else. */
function remoteQuery(search: string, replace: string): SearchQuery {
  return new SearchQuery({ search, replace, caseSensitive: true, literal: true, regexp: false, wholeWord: false });
}

function isRemoteShaped(query: SearchQuery): boolean {
  return query.caseSensitive && !query.regexp && !query.wholeWord;
}

interface Settled {
  readonly doc: Text;
  readonly query: SearchQuery;
  readonly found: FoundMatches | "invalid" | null;
}

/**
 * The document's count. Taken on every keystroke while the document is small enough that
 * counting is free, and once typing pauses above that, so a 2MB body never stalls a keystroke.
 */
function useLocalCount(state: EditorState, query: SearchQuery, enabled: boolean): FindCount | null {
  const doc = state.doc;
  const eager = doc.length <= FIND_COUNT_EAGER_CHARS;
  const immediate = useMemo(() => (enabled && eager ? findMatches(doc, query) : null), [enabled, eager, doc, query]);
  const [settled, setSettled] = useState<Settled | null>(null);
  useEffect(() => {
    if (!enabled || eager) return;
    const timer = setTimeout(() => {
      setSettled({ doc, query, found: findMatches(doc, query) });
    }, FIND_COUNT_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [enabled, eager, doc, query]);
  if (!enabled) return null;
  const found = eager
    ? immediate
    : settled !== null && settled.doc === doc && settled.query === query
      ? settled.found
      : null;
  return found === null ? null : countOf(found, state.selection.main);
}

interface RemoteResult {
  readonly remote: RemoteFind;
  readonly search: string;
  readonly total: number;
  readonly capped: boolean;
}

interface RemotePosition {
  readonly search: string;
  readonly index: number;
}

/** The engine's count for the current query, and which of its hits the reader last stepped to. */
function useRemoteCount(remote: RemoteFind | null, search: string) {
  const [result, setResult] = useState<RemoteResult | null>(null);
  const [position, setPosition] = useState<RemotePosition | null>(null);
  useEffect(() => {
    if (remote === null || search === "") return;
    // A slower answer to an older query must not overwrite a newer one.
    let live = true;
    const timer = setTimeout(() => {
      void remote.search(search).then((found) => {
        if (live && found !== null) setResult({ remote, search, ...found });
      });
    }, FIND_COUNT_DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [remote, search]);

  // Keyed by the source too: a new response's body is a different set of hits for the same text.
  const current =
    result !== null && result.remote === remote && result.search === search && search !== "" ? result : null;
  const index = position !== null && position.search === search ? position.index : null;
  const count: FindCount | null =
    current === null
      ? null
      : { total: current.total, current: index === null ? null : index + 1, capped: current.capped, invalid: false };

  const step: Stepper = (forward) => {
    if (remote === null || current === null || current.total === 0) return false;
    const { total } = current;
    const next = index === null ? (forward ? 0 : total - 1) : (index + (forward ? 1 : -1) + total) % total;
    setPosition({ search, index: next });
    remote.step(next);
    return true;
  };
  return { count, step };
}

export interface FindBarProps {
  readonly host: FindHost;
  readonly readOnly: boolean;
  /** Set when the editor holds a window of a body and the engine holds the rest. */
  readonly remote: RemoteFind | null;
}

export function FindBar({ host, readOnly, remote }: FindBarProps) {
  const { view } = host;
  const state = useSyncExternalStore(host.subscribe, () => view.state);
  const query = getSearchQuery(state);
  const { replaceOpen, openings } = state.field(findPanelField);
  const local = remote === null;
  const field = useRef<HTMLInputElement | null>(null);

  const localCount = useLocalCount(state, query, local);
  const remoteCount = useRemoteCount(remote, query.search);
  const count = local ? localCount : remoteCount.count;

  // The engine cannot honour an option, so a query carried over from a local search is reset
  // to what the engine will actually run rather than shown with toggles that lie.
  useEffect(() => {
    if (local || isRemoteShaped(query)) return;
    view.dispatch({ effects: setSearchQuery.of(remoteQuery(query.search, query.replace)) });
  }, [local, query, view]);

  // Every `openFind`, including the one that mounted the bar, hands the field focus with its
  // text selected, so typing replaces the query and `Cmd+F` twice re-selects it.
  useEffect(() => {
    field.current?.focus();
    field.current?.select();
  }, [openings]);

  const step: Stepper = local ? (forward) => (forward ? findNext(view) : findPrevious(view)) : remoteCount.step;
  const stepper = useRef(step);
  useEffect(() => {
    stepper.current = step;
  });
  useEffect(() => {
    host.setStepper((forward) => stepper.current(forward));
    return () => {
      host.setStepper(null);
    };
  }, [host]);

  const canReplace = !readOnly && local;
  const failed = countFailed(count);

  function type(search: string): void {
    setFindText(view, local ? withQuery(query, { search }) : remoteQuery(search, query.replace), local);
  }

  return (
    <div role="search" aria-label={FIND_LABEL} className="border-b border-line bg-panel px-1.5 py-1">
      <div className="flex items-center gap-0.5">
        {canReplace && (
          <IconButton
            label={replaceOpen ? HIDE_REPLACE_HINT : SHOW_REPLACE_HINT}
            active={replaceOpen}
            onClick={() => {
              showReplace(view, !replaceOpen);
            }}
          >
            <CaretRightIcon className={cn("transition-transform", replaceOpen && "rotate-90")} />
          </IconButton>
        )}
        <div className="min-w-0 flex-1">
          <Field
            ref={field}
            mono
            {...{ "main-field": "true" }}
            value={query.search}
            placeholder={FIND_LABEL}
            aria-label={FIND_LABEL}
            autoComplete="off"
            lead={<SearchIcon className={GLYPH_CLASS} />}
            onChange={(event) => {
              type(event.currentTarget.value);
            }}
            onKeyDown={(event) => {
              if (event.key !== ENTER) return;
              event.preventDefault();
              stepper.current(!event.shiftKey);
            }}
          />
        </div>
        {OPTIONS.map(({ option, glyph, label }) => (
          <IconButton
            key={option}
            label={local ? label : REMOTE_HINT}
            active={query[option]}
            aria-disabled={!local}
            onClick={() => {
              if (!local) return;
              setFindText(view, withQuery(query, { [option]: !query[option] }), true);
            }}
          >
            <span className="font-mono text-2xs">{glyph}</span>
          </IconButton>
        ))}
        <span
          aria-hidden
          className={cn("min-w-14 px-1 text-right text-2xs tabular-nums", failed ? "text-danger" : "text-ink-faint")}
        >
          {counterText(count)}
        </span>
        <span role="status" className="sr-only">
          {counterSpoken(count)}
        </span>
        <IconButton label={PREVIOUS_HINT} onClick={() => stepper.current(false)}>
          <PreviousMatchIcon />
        </IconButton>
        <IconButton label={NEXT_HINT} onClick={() => stepper.current(true)}>
          <NextMatchIcon />
        </IconButton>
        <IconButton label={CLOSE_HINT} onClick={() => closeSearchPanel(view)}>
          <CloseIcon />
        </IconButton>
      </div>
      {canReplace && replaceOpen && (
        <div className="mt-1 flex items-center gap-0.5 pl-[calc(var(--spacing-control)+2px)]">
          <div className="min-w-0 flex-1">
            <Field
              mono
              value={query.replace}
              placeholder={REPLACE_LABEL}
              aria-label={REPLACE_LABEL}
              autoComplete="off"
              onChange={(event) => {
                view.dispatch({ effects: setSearchQuery.of(withQuery(query, { replace: event.currentTarget.value })) });
              }}
              onKeyDown={(event) => {
                if (event.key !== ENTER) return;
                event.preventDefault();
                if (event.metaKey || event.ctrlKey) replaceAll(view);
                else replaceNext(view);
              }}
            />
          </div>
          <Button variant="quiet" tier="chrome" onClick={() => replaceNext(view)}>
            {REPLACE_LABEL}
          </Button>
          <Button variant="quiet" tier="chrome" onClick={() => replaceAll(view)}>
            {REPLACE_ALL_LABEL}
          </Button>
        </div>
      )}
    </div>
  );
}
