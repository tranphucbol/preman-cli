/**
 * The response body, however large it is.
 *
 * The whole design of this pane is one refusal: it will not hold the body. It holds a
 * handle and at most `VIEWER_RETAINED_BYTES` of text, appends the next window when the
 * reader nears the bottom, and has the find bar count the engine's hits rather than the
 * document's, because searching one window is not searching. A 50MB response therefore costs
 * the renderer what a 500KB one costs, and the only visible difference is a range strip along
 * the bottom.
 *
 * JSON is the one body it does hold, and it holds it without being asked: a response whose
 * content type says JSON arrives pretty-printed. The bound on that is the toggle's own -
 * `BODY_FORMAT_LIMIT_BYTES`, two megabytes - and it is deliberately the same number, so the
 * rule is "if preman can pretty-print it, it already has" rather than a second threshold
 * nobody can predict. Above it the body arrives as it was sent and the toggle explains why.
 *
 * `model/body.ts` owns every decision about which bytes to ask for and what to keep. This
 * file is the wiring: state, one guarded fetch, and the chrome around the editor.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { BodyMatch } from "@preman/desktop/engine/protocol.js";
import { bodyFormat, bodySearch, bodyWindow, type Failure } from "@preman/desktop/renderer/actions.js";
import {
  charRange,
  copySource,
  extendView,
  findSource,
  formatAvailability,
  formatBytes,
  isEmpty,
  isWhole,
  offsetForMatch,
  REMOTE_FIND_CAP,
  requestOffset,
  seedView,
  utf8Length,
  viewEnd,
  viewStart,
  viewText,
  viewerLanguage,
  type BodyMove,
  type BodyView,
} from "@preman/desktop/renderer/model/body.js";
import type { RemoteFind } from "@preman/desktop/renderer/model/find.js";
import type { ResponseBody } from "@preman/desktop/renderer/model/response.js";
import { CodeEditor, type EditorReveal, type ScrollEdge } from "@preman/desktop/renderer/ui/CodeEditor.js";
import { Button, IconButton } from "@preman/desktop/renderer/ui/Controls.js";
import { CopyButton } from "@preman/desktop/renderer/ui/CopyButton.js";
import { FormatIcon, SearchIcon } from "@preman/desktop/renderer/ui/icons.js";

const START_OF_BODY = 0;
const NO_BODY_HINT = "This request returned no body.";
const SEARCH_HINT = "Find (⌘F)";
const FORMAT_HINT = "Pretty-print";
/* The toggle is lit before the reader has touched it, so it has to say what pressing it does. */
const RAW_HINT = "Show the raw body";
const COPY_HINT = "Copy response body";
const FIRST_SERIAL = 1;

/** An engine hit the reader stepped to, in bytes; it becomes a document range once its window is in. */
interface FindTarget {
  readonly offset: number;
  readonly length: number;
  readonly serial: number;
}
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
  const [failure, setFailure] = useState<Failure | null>(null);
  const [target, setTarget] = useState<FindTarget | null>(null);
  const [findRequest, setFindRequest] = useState(START_OF_BODY);

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

  // The engine's side of the find bar. Its hits live in a ref because only `step` reads them, and
  // stepping to one sets a byte target that becomes a document range once its window is loaded.
  const hits = useRef<{ readonly query: string; readonly matches: readonly BodyMatch[] }>({ query: "", matches: [] });
  const remote = useMemo<RemoteFind>(
    () => ({
      async search(query) {
        // One more than the bar counts, so the answer says whether there were more.
        const result = await bodySearch(handle, query, REMOTE_FIND_CAP + 1);
        if (!result.ok) {
          setFailure(result.failure);
          return null;
        }
        hits.current = { query, matches: result.value.slice(0, REMOTE_FIND_CAP) };
        return { total: hits.current.matches.length, capped: result.value.length > REMOTE_FIND_CAP };
      },
      step(index) {
        const match = hits.current.matches.at(index);
        if (match === undefined) return;
        const length = utf8Length(hits.current.query);
        setTarget((previous) => ({
          offset: match.offset,
          length,
          serial: (previous?.serial ?? START_OF_BODY) + FIRST_SERIAL,
        }));
        const current = latest.current;
        if (match.offset < viewStart(current) || match.offset + length > viewEnd(current)) {
          load(offsetForMatch(match));
        }
      },
    }),
    [handle, load],
  );

  const text = formatted ?? viewText(view);
  const whole = isWhole(view);
  const pretty = formatted !== null;
  const availability = formatAvailability(view, text);
  const source = findSource(view, pretty);

  const reveal = useMemo<EditorReveal | null>(() => {
    if (target === null || source !== "remote") return null;
    const range = charRange(view, target.offset, target.length);
    return range === null ? null : { ...range, serial: target.serial };
  }, [target, source, view]);

  // Whether the automatic pretty-print has had its one chance at this body. A ref, and not
  // state, because it settles a decision rather than describing one: flipping it must not
  // paint, and the reader turning the toggle back off must not hand it a second chance.
  const decided = useRef(false);
  useEffect(() => {
    if (decided.current || !availability.allowed) return;
    decided.current = true;
    void bodyFormat(handle).then((result) => {
      // Deliberately silent where `togglePretty` reports. This body was never asked for, so a
      // red line under the toolbar would be the app complaining about something the reader did
      // not do - and the raw body behind it is still perfectly readable. The toggle is still
      // there to ask again, and that click does report.
      if (result.ok) setFormatted(result.value);
    });
  }, [availability.allowed, handle]);

  async function togglePretty(): Promise<void> {
    if (pretty) {
      setFormatted(null);
      return;
    }
    const result = await bodyFormat(handle);
    if (result.ok) setFormatted(result.value);
    else setFailure(result.failure);
  }

  // What the reader sees, whole: the pretty-printed text when it is lit, and every raw byte
  // otherwise - never just the window that happens to be on screen.
  const copy = useMemo(() => copySource(view, formatted), [view, formatted]);
  const readCopy = useCallback(async (): Promise<string | null> => {
    if (copy.kind === "held") return copy.text;
    if (copy.kind === "refused") return null;
    const result = await bodyWindow(handle, START_OF_BODY, copy.length);
    if (result.ok) return result.value.text;
    setFailure(result.failure);
    return null;
  }, [copy, handle]);
  const copyFailed = useCallback((message: string) => {
    setFailure({ message, details: [] });
  }, []);

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
          label={pretty ? RAW_HINT : availability.allowed ? FORMAT_HINT : availability.reason}
          active={pretty}
          disabled={!availability.allowed}
          onClick={() => void togglePretty()}
        >
          <FormatIcon />
        </IconButton>
        <IconButton
          label={SEARCH_HINT}
          onClick={() => {
            setFindRequest((count) => count + FIRST_SERIAL);
          }}
        >
          <SearchIcon />
        </IconButton>
        <CopyButton
          label={COPY_HINT}
          read={readCopy}
          refusal={copy.kind === "refused" ? copy.reason : undefined}
          onFail={copyFailed}
        />
      </div>

      {failure !== null && (
        <p className="shrink-0 border-b border-line px-2 py-1.5 text-2xs text-danger">{failure.message}</p>
      )}

      <CodeEditor
        value={text}
        language={pretty ? "json" : viewerLanguage(view, text)}
        readOnly
        // Line numbers are only shown when they are true. Numbering a window that starts three
        // megabytes in from 1 would be a lie; the range strip says where the window sits instead.
        gutter={whole || pretty}
        onEdge={pretty ? undefined : onEdge}
        remoteFind={source === "remote" ? remote : undefined}
        reveal={reveal}
        findRequest={findRequest}
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
