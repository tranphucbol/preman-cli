/**
 * The response body, however large it is.
 *
 * The whole design of this pane is one refusal: it will not hold the body. It holds a
 * handle and at most `VIEWER_RETAINED_BYTES` of text, appends the next window when the
 * reader nears the bottom, and hands `Cmd+F` to the engine because searching one window is
 * not searching. A 50MB response therefore costs the renderer what a 500KB one costs, and
 * the only visible difference is a range strip along the bottom.
 *
 * `model/body.ts` owns every decision about which bytes to ask for and what to keep. This
 * file is the wiring: state, one guarded fetch, and the chrome around the editor.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import type { BodyMatch } from "@preman/desktop/engine/protocol.js";
import { bodyFormat, bodySearch, bodyWindow, type Failure } from "@preman/desktop/renderer/actions.js";
import {
  extendView,
  formatAvailability,
  formatBytes,
  isEmpty,
  isHighlightable,
  isWhole,
  offsetForMatch,
  requestOffset,
  seedView,
  viewEnd,
  viewStart,
  viewText,
  viewerLanguage,
  type BodyMove,
  type BodyView,
} from "@preman/desktop/renderer/model/body.js";
import type { ResponseBody } from "@preman/desktop/renderer/model/response.js";
import { CodeEditor, type ScrollEdge } from "@preman/desktop/renderer/ui/CodeEditor.js";
import { Button, Field, IconButton } from "@preman/desktop/renderer/ui/Controls.js";
import { CloseIcon, FormatIcon, SearchIcon } from "@preman/desktop/renderer/ui/icons.js";

const START_OF_BODY = 0;
const NO_BODY_HINT = "This request returned no body.";
const SEARCH_HINT = "Find in the whole body";
const ENTER = "Enter";
const ESCAPE = "Escape";
/** Every move the range strip offers, in the order they are shown. */
const MOVES: readonly { readonly move: BodyMove; readonly label: string }[] = [
  { move: "start", label: "Start" },
  { move: "previous", label: "Back" },
  { move: "next", label: "Next" },
  { move: "end", label: "End" },
];

export function BodyViewer({ body }: { readonly body: ResponseBody }) {
  const handle = body.handle;
  const [view, setView] = useState<BodyView>(() => seedView(body));
  const [formatted, setFormatted] = useState<string | null>(null);
  const [matches, setMatches] = useState<BodyMatch[] | null>(null);
  const [finding, setFinding] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);

  // One fetch at a time. The scroll handler fires on every scroll event while the reader is
  // near the bottom, so without this a single flick would queue a hundred windows. A ref
  // rather than state because nothing renders differently while a window is in the air.
  const busy = useRef(false);
  // The scroll handler and the paging buttons need the current view to compute the next
  // offset, and neither of them can be re-created on every window without rebuilding the
  // editor. Synced in an effect rather than during render.
  const latest = useRef(view);
  useEffect(() => {
    latest.current = view;
  }, [view]);

  /**
   * Ask for one window.
   *
   * Synchronous on the way in and settled in a callback on the way out, deliberately: the
   * engine is an external system, and state that arrives from one belongs in its callback
   * rather than in an effect body.
   */
  const load = useCallback(
    (offset: number) => {
      if (busy.current) return;
      busy.current = true;
      void bodyWindow(handle, offset).then((result) => {
        busy.current = false;
        if (!result.ok) {
          setFailure(result.failure);
          return;
        }
        // A window that arrives after the pane moved on to another response belongs to nothing.
        setView((current) => (current.handle === handle ? extendView(current, result.value) : current));
      });
    },
    [handle],
  );

  // A truncated preview is discarded by `seedView`, because its byte length is unknowable
  // here, so the first window has to be fetched. Guarded on emptiness rather than on a flag
  // so a failed fetch does not retry forever.
  useEffect(() => {
    if (!isEmpty(view) || view.byteLength === START_OF_BODY) return;
    load(START_OF_BODY);
  }, [view, load]);

  const search = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (finding) search.current?.focus();
  }, [finding]);

  const onEdge = useCallback(
    (edge: ScrollEdge) => {
      // Only the bottom loads on its own. Going backwards cannot be done by appending (the
      // engine aligns window starts forwards, so the end would overshoot), and a jump that
      // fired off a scroll event would fight the reader for the scroll position.
      if (edge !== "bottom") return;
      const offset = requestOffset(latest.current, "next");
      if (offset !== null) void load(offset);
    },
    [load],
  );

  const onFind = useCallback(() => {
    setFinding(true);
  }, []);

  const text = formatted ?? viewText(view);
  const whole = isWhole(view);
  const pretty = formatted !== null;
  const availability = formatAvailability(view, text);

  async function togglePretty(): Promise<void> {
    if (pretty) {
      setFormatted(null);
      return;
    }
    const result = await bodyFormat(handle);
    if (result.ok) setFormatted(result.value);
    else setFailure(result.failure);
  }

  async function runSearch(query: string): Promise<void> {
    if (query === "") {
      setMatches(null);
      return;
    }
    const result = await bodySearch(handle, query);
    if (result.ok) setMatches(result.value);
    else setFailure(result.failure);
  }

  function move(to: BodyMove): void {
    const offset = requestOffset(latest.current, to);
    if (offset !== null) void load(offset);
  }

  if (body.byteLength === START_OF_BODY) {
    return <p className="p-gutter text-xs text-ink-faint">{NO_BODY_HINT}</p>;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-tab shrink-0 items-center gap-2 border-b border-line px-2">
        <span className="truncate font-mono text-2xs text-ink-dim">{body.contentType ?? "no content type"}</span>
        <span className="text-2xs text-ink-faint">{formatBytes(body.byteLength)}</span>
        <div className="flex-1" />
        <IconButton
          label={availability.allowed ? "Pretty-print" : availability.reason}
          active={pretty}
          disabled={!availability.allowed}
          onClick={() => void togglePretty()}
        >
          <FormatIcon />
        </IconButton>
        <IconButton label={SEARCH_HINT} active={finding} onClick={onFind}>
          <SearchIcon />
        </IconButton>
      </div>

      {finding && (
        <div className="flex shrink-0 items-center gap-2 border-b border-line px-2 py-1.5">
          <Field
            ref={search}
            mono
            placeholder={SEARCH_HINT}
            onKeyDown={(stroke) => {
              if (stroke.key === ENTER) void runSearch(stroke.currentTarget.value);
              if (stroke.key === ESCAPE) setFinding(false);
            }}
          />
          {matches !== null && (
            <span className="shrink-0 text-2xs text-ink-faint">
              {matches.length === 0 ? "no matches" : `${String(matches.length)} matches`}
            </span>
          )}
          <IconButton
            label="Close find"
            onClick={() => {
              setFinding(false);
              setMatches(null);
            }}
          >
            <CloseIcon />
          </IconButton>
        </div>
      )}

      {matches !== null && matches.length > 0 && (
        <ul className="max-h-40 shrink-0 overflow-y-auto border-b border-line">
          {matches.map((match) => (
            <li key={match.offset}>
              <button
                type="button"
                className="flex h-row w-full items-center gap-2 px-2 text-left hover:bg-hover"
                onClick={() => void load(offsetForMatch(match))}
              >
                <span className="w-10 shrink-0 text-right font-mono text-2xs text-ink-faint">{match.line}</span>
                {/* The offset, not the line, is what tells two hits apart: a single-line body
                    puts every match on line 1, and the offset is also where the jump lands. */}
                <span className="w-16 shrink-0 text-right font-mono text-2xs text-ink-faint">
                  {formatBytes(match.offset)}
                </span>
                <span className="truncate font-mono text-2xs text-ink-dim">{match.preview}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {failure !== null && (
        <p className="shrink-0 border-b border-line px-2 py-1.5 text-2xs text-danger">{failure.message}</p>
      )}

      <CodeEditor
        value={text}
        language={pretty ? "json" : viewerLanguage(view, text)}
        readOnly
        // Line numbers are only shown when they are true. Numbering a window that starts three
        // megabytes in from 1 would be a lie, and the engine's search results carry the real ones.
        gutter={whole || pretty}
        onEdge={pretty ? undefined : onEdge}
        onFind={whole && isHighlightable(view) && !pretty ? undefined : onFind}
      />

      {!whole && !pretty && (
        <div className="flex h-tab shrink-0 items-center gap-2 border-t border-line px-2">
          <span className="font-mono text-2xs text-ink-dim">
            {formatBytes(viewStart(view))} – {formatBytes(viewEnd(view))} of {formatBytes(view.byteLength)}
          </span>
          <div className="flex-1" />
          {MOVES.map((step) => (
            <Button
              key={step.move}
              variant="quiet"
              disabled={requestOffset(view, step.move) === null}
              onClick={() => {
                move(step.move);
              }}
            >
              {step.label}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}
