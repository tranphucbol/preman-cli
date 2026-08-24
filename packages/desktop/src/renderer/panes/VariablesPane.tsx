/**
 * The variable manager: every layer, side by side, with the winner marked.
 *
 * A `{{token}}` that resolves to the wrong thing is the single most common confusion in a request
 * client, and the reason is always the same - two layers hold the key and you were looking at the
 * loser. So this pane does not show "the environment". It shows one column per layer, one row per
 * key, and it strikes through every value that loses. The precedence itself is core's: the engine
 * answers with the chain `VariableStore` walks, so nothing here can disagree with what a run does.
 *
 * Only the layers a workspace can persist appear, which today is globals and the chosen
 * environment. `data` and `local` exist only while a run is in flight, and the `collection` scope
 * is declared by core but no workspace file populates it, so a column for it would be a promise
 * preman does not keep.
 *
 * One writable layer, one write path: `write-variable` patches the environment file through the
 * same comment-preserving writer the CLI's `--save` uses, and answers with the re-read view.
 */
import { useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useEffect, useRef, useState } from "react";

import type { Scope, VariableBinding, VariableLayer, VariableView } from "@preman/desktop/engine/protocol.js";

import { readVariables, writeVariable, type Failure } from "@preman/desktop/renderer/actions.js";
import { useDensityTokens, useRemeasure } from "@preman/desktop/renderer/stores/appearance.js";
import { useCatalogStore } from "@preman/desktop/renderer/stores/catalog.js";
import { useSessionStore } from "@preman/desktop/renderer/stores/session.js";
import { cn } from "@preman/desktop/renderer/ui/cn.js";
import { Banner } from "@preman/desktop/renderer/ui/Banner.js";
import { AnimatePresence } from "@preman/desktop/renderer/ui/motion.js";
import { CellField, IconButton, toneClass, type FieldTone } from "@preman/desktop/renderer/ui/Controls.js";
import { AddIcon, CloseIcon, RefreshIcon } from "@preman/desktop/renderer/ui/icons.js";
import { GLOBALS_READ_ONLY_HINT, TokenBox, useTokenBox } from "@preman/desktop/renderer/ui/TokenBox.js";
import type { TokenReporter } from "@preman/desktop/renderer/ui/template.js";

const OVERSCAN = 12;

const KEY_COLUMN = "minmax(10rem, 1fr)";
const LAYER_COLUMN = "minmax(12rem, 2fr)";

/**
 * The add row's key input, and only that. Every value cell is a `CellField`; this one is not,
 * because it shares its cell with the plus icon and so supplies no left padding of its own - and
 * because a key is not interpolated, so it is the one input here with no token backdrop to align.
 */
const ADD_KEY_CLASS =
  "h-row w-full min-w-0 truncate bg-transparent font-mono text-xs text-ink placeholder:text-ink-faint focus:bg-control focus:outline-none";
const HEADER_CELL_CLASS = "px-2 text-2xs font-medium tracking-wide text-ink-faint uppercase";
/** An absent value, rather than an empty one. A blank cell cannot say which of the two it is. */
const ABSENT = "—";
const EMPTY = "";

const FIRST_READ = 0;
const NEXT_READ = 1;

const NO_ENVIRONMENT_LABEL = "No environment";
const LOADING_HINT = "Reading variables…";
const NO_VARIABLES_HINT = "This workspace defines no variables yet.";

export function VariablesPane({ onDismiss }: { readonly onDismiss: () => void }): React.JSX.Element {
  const environment = useSessionStore((state) => state.environment);
  // The catalog's revision changes on every reconcile, including the writeback a script's
  // `pm.environment.set` produces, so this is how the table follows a run that moved a value.
  const revision = useCatalogStore((state) => state.revision);

  const [view, setView] = useState<VariableView | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  /** Bumped by Reload. The effect is the only reader, so a manual reload is another run of it. */
  const [nonce, setNonce] = useState(FIRST_READ);

  useEffect(() => {
    let live = true;
    void readVariables(environment).then((result) => {
      if (!live) return;
      if (result.ok) {
        setView(result.value);
        setFailure(null);
        return;
      }
      setFailure(result.failure);
    });
    return () => {
      // The environment can change while a read is in flight, and the older answer must not be
      // the one that lands: it would describe a chain that is no longer the one a run would use.
      live = false;
    };
  }, [environment, revision, nonce]);

  const commit = useCallback(async (layer: VariableLayer, key: string, value: string): Promise<void> => {
    const result = await writeVariable({ environment: layer.label, key, value });
    if (result.ok) {
      setView(result.value);
      setFailure(null);
      return;
    }
    setFailure(result.failure);
  }, []);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-tab shrink-0 items-center gap-2 border-b border-line px-gutter">
        <span className="text-xs font-medium text-ink">Variables</span>
        <span className="truncate text-2xs text-ink-faint">{view?.environment ?? NO_ENVIRONMENT_LABEL}</span>
        <div className="flex-1" />
        <IconButton
          label="Reload"
          onClick={() => {
            setNonce((current) => current + NEXT_READ);
          }}
        >
          <RefreshIcon />
        </IconButton>
        <IconButton label="Close variables" onClick={onDismiss}>
          <CloseIcon />
        </IconButton>
      </div>

      <AnimatePresence>
        {failure !== null && <Banner tone="danger" message={failure.message} details={failure.details} />}
      </AnimatePresence>

      {view === null ? <Hint>{LOADING_HINT}</Hint> : <Table view={view} onCommit={commit} />}
    </div>
  );
}

function Hint({ children }: { readonly children: React.ReactNode }) {
  return <p className="p-gutter text-xs text-ink-faint">{children}</p>;
}

type Commit = (layer: VariableLayer, key: string, value: string) => Promise<void>;

function Table({ view, onCommit }: { readonly view: VariableView; readonly onCommit: Commit }): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null);
  // An environment value can itself be a token - `interpolate.ts` expands one recursively - so the
  // pane that edits values is also a pane that shows them, and a box opened here is a box opened on
  // the row above.
  const box = useTokenBox();
  const { layers, bindings } = view;
  const template = `${KEY_COLUMN} ${layers.map(() => LAYER_COLUMN).join(" ")}`;

  const rowHeight = useDensityTokens().row;
  const virtualizer = useVirtualizer({
    count: bindings.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: OVERSCAN,
    getItemKey: (index) => bindings[index]?.key ?? index,
  });
  useRemeasure(virtualizer, rowHeight);

  const writable = layers.find((layer) => layer.writable);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="grid h-row shrink-0 items-center border-b border-line" style={{ gridTemplateColumns: template }}>
        <span className={HEADER_CELL_CLASS}>Key</span>
        {layers.map((layer) => (
          <span key={layer.scope} className={HEADER_CELL_CLASS} title={layer.file}>
            {layer.label}
            {!layer.writable && <span className="ml-1 text-ink-faint normal-case">read-only</span>}
          </span>
        ))}
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto">
        {bindings.length === 0 ? (
          <Hint>{NO_VARIABLES_HINT}</Hint>
        ) : (
          <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((item) => {
              const binding = bindings[item.index];
              if (binding === undefined) return null;
              return (
                <Row
                  key={item.key}
                  binding={binding}
                  layers={layers}
                  template={template}
                  top={item.start}
                  onToken={box.report}
                  onCommit={onCommit}
                />
              );
            })}
          </div>
        )}
      </div>

      {writable === undefined ? (
        <p className="shrink-0 border-t border-line px-gutter py-1.5 text-2xs text-ink-faint">
          {GLOBALS_READ_ONLY_HINT}
        </p>
      ) : (
        <AddRow layer={writable} template={template} columns={layers.length} onCommit={onCommit} />
      )}

      {box.clicked !== null && (
        <TokenBox key={box.clicked.name} name={box.clicked.name} at={box.clicked.at} onDismiss={box.dismiss} />
      )}
    </div>
  );
}

/**
 * One key across every layer.
 *
 * The winner is plain ink; a value that is there but loses is struck through, which is the whole
 * point of the pane. Absent is an em-dash rather than a blank, because "no value here" and "the
 * empty string here" are different answers and a run treats them differently.
 */
function Row({
  binding,
  layers,
  template,
  top,
  onToken,
  onCommit,
}: {
  readonly binding: VariableBinding;
  readonly layers: readonly VariableLayer[];
  readonly template: string;
  readonly top: number;
  readonly onToken: TokenReporter;
  readonly onCommit: Commit;
}) {
  return (
    <div
      className="absolute inset-x-0 grid h-row items-center border-b border-line hover:bg-hover"
      style={{ top, gridTemplateColumns: template }}
      role="row"
    >
      <span className="truncate px-2 font-mono text-xs text-ink" title={binding.key}>
        {binding.key}
      </span>
      {layers.map((layer) => (
        <Cell
          key={layer.scope}
          layer={layer}
          binding={binding}
          value={layer.values[binding.key]}
          onToken={onToken}
          onCommit={onCommit}
        />
      ))}
    </div>
  );
}

function Cell({
  layer,
  binding,
  value,
  onToken,
  onCommit,
}: {
  readonly layer: VariableLayer;
  readonly binding: VariableBinding;
  readonly value: string | undefined;
  readonly onToken: TokenReporter;
  readonly onCommit: Commit;
}) {
  const tone = toneFor(layer.scope, binding, value !== undefined);

  if (!layer.writable) {
    return (
      <span className={cn("truncate px-2 font-mono text-xs", toneClass(tone))} title={value ?? EMPTY}>
        {value ?? ABSENT}
      </span>
    );
  }

  return (
    <ValueCell
      value={value}
      label={`${binding.key} in ${layer.label}`}
      tone={tone}
      onToken={onToken}
      onCommit={(next) => {
        void onCommit(layer, binding.key, next);
      }}
    />
  );
}

/** Winner, loser, or nothing at all. The one place a scope becomes a tone. */
function toneFor(scope: Scope, binding: VariableBinding, present: boolean): FieldTone {
  if (!present) return "muted";
  return binding.scope === scope ? "normal" : "struck";
}

/**
 * An editable value, committed on blur or Enter and never on a debounce.
 *
 * Every commit writes a YAML file on disk. A grid cell can afford to checkpoint mid-word; a file
 * write cannot, and a `git diff` that shows six intermediate spellings of one value is worse than
 * one that shows the value.
 */
function ValueCell({
  value,
  label,
  tone,
  onToken,
  onCommit,
}: {
  readonly value: string | undefined;
  readonly label: string;
  readonly tone: FieldTone;
  readonly onToken: TokenReporter;
  readonly onCommit: (value: string) => void;
}) {
  return (
    <CellField
      // Remounted when the stored value changes, so a write elsewhere - or a script's writeback
      // during a run - reaches a cell the user is not currently typing in.
      key={value}
      defaultValue={value ?? EMPTY}
      aria-label={label}
      placeholder={ABSENT}
      tone={tone}
      onToken={onToken}
      onBlur={(event) => {
        const next = event.currentTarget.value;
        if (next !== (value ?? EMPTY)) onCommit(next);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
      }}
    />
  );
}

/**
 * A dedicated add row, matching the request grid: a blank last row that is sometimes real is the
 * thing people accidentally save.
 */
function AddRow({
  layer,
  template,
  columns,
  onCommit,
}: {
  readonly layer: VariableLayer;
  readonly template: string;
  readonly columns: number;
  readonly onCommit: Commit;
}) {
  const [key, setKey] = useState(EMPTY);

  const submit = () => {
    const trimmed = key.trim();
    if (trimmed === EMPTY) return;
    setKey(EMPTY);
    void onCommit(layer, trimmed, EMPTY);
  };

  return (
    <div className="grid shrink-0 items-center border-t border-line" style={{ gridTemplateColumns: template }}>
      <div className="flex h-row items-center gap-1 px-2 text-glyph">
        <AddIcon />
        <input
          value={key}
          spellCheck={false}
          placeholder={`New key in ${layer.label}`}
          aria-label={`New key in ${layer.label}`}
          className={ADD_KEY_CLASS}
          onChange={(event) => {
            setKey(event.currentTarget.value);
          }}
          onBlur={submit}
          onKeyDown={(event) => {
            if (event.key === "Enter") submit();
          }}
        />
      </div>
      {/* One spacer per layer column, so the add row lines up with the table above it. */}
      {Array.from({ length: columns }, (_unused, index) => (
        <span key={index} />
      ))}
    </div>
  );
}
