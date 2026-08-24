/**
 * The headers / params / metadata grid.
 *
 * This component is where the keystroke budget is won or lost. Every cell is an
 * uncontrolled `<input defaultValue>` that commits on blur or after a debounce, so typing
 * into a header value does not re-render forty sibling rows on the way to the store. That
 * is the decision that rules out react-hook-form and shadcn `Form`: both want to own the
 * value on every keystroke.
 *
 * Rows are keyed by position rather than by name, because a header whose key is being
 * retyped one character at a time has no stable identity to key on.
 */

import { useState } from "react";
import { CellField, IconButton, type FieldTone } from "@preman/desktop/renderer/ui/Controls.js";
import { AddIcon, DeleteIcon, FilterIcon } from "@preman/desktop/renderer/ui/icons.js";
import { type Pair, type PairList, pairsToText, textToPairs } from "@preman/desktop/renderer/model/request.js";
import type { TokenReporter } from "@preman/desktop/renderer/ui/template.js";
import { TokenBox, useTokenBox } from "@preman/desktop/renderer/ui/TokenBox.js";

const COMMIT_DEBOUNCE_MS = 150;
const EMPTY = "";
const KEY_COLUMN = "minmax(8rem, 1fr)";
const VALUE_COLUMN = "minmax(10rem, 2fr)";
const TOGGLE_COLUMN = "1.75rem";
const ACTION_COLUMN = "1.75rem";
const GRID_TEMPLATE = `${TOGGLE_COLUMN} ${KEY_COLUMN} ${VALUE_COLUMN} ${ACTION_COLUMN}`;

const HEADER_CELL_CLASS = "px-2 text-2xs font-medium tracking-wide text-ink-faint uppercase";

/** A row the user has switched off is still on screen and still not going to be sent. */
const DISABLED_TONE: FieldTone = "struck";
const PLAIN_TONE: FieldTone = "normal";

export interface KeyValueGridProps {
  readonly list: PairList;
  /** Shown in the empty state and in the bulk-edit hint. Singular, lowercase. */
  readonly noun: string;
  /** Absent means the field cannot carry a disabled flag, so no toggle column is drawn. */
  readonly onToggle?: (pair: Pair, disabled: boolean) => void;
  readonly onKeyChange: (pair: Pair, key: string) => void;
  readonly onValueChange: (pair: Pair, value: string) => void;
  readonly onRemove: (pair: Pair) => void;
  readonly onAdd: (key: string, value: string) => void;
  readonly onBulk: (entries: readonly { key: string; value: string; disabled?: boolean }[]) => void;
}

export function KeyValueGrid(props: KeyValueGridProps) {
  const [bulk, setBulk] = useState(false);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-tab shrink-0 items-center gap-2 border-b border-line px-gutter">
        <span className="text-2xs text-ink-dim">
          {props.list.pairs.length} {props.noun}
          {props.list.pairs.length === 1 ? EMPTY : "s"}
        </span>
        <div className="ml-auto">
          <IconButton
            label={bulk ? "Back to the grid" : "Edit as text"}
            active={bulk}
            onClick={() => {
              setBulk(!bulk);
            }}
          >
            <FilterIcon />
          </IconButton>
        </div>
      </div>
      {bulk ? <BulkPane {...props} /> : <GridPane {...props} />}
    </div>
  );
}

function BulkPane({ list, noun, onBulk }: KeyValueGridProps) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <textarea
        defaultValue={pairsToText(list.pairs)}
        spellCheck={false}
        onBlur={(event) => {
          onBulk(textToPairs(event.currentTarget.value));
        }}
        className="min-h-0 flex-1 resize-none bg-transparent p-gutter font-mono text-xs text-ink placeholder:text-ink-faint focus:outline-none"
        placeholder={`One ${noun} per line, as key: value. Prefix a line with // to disable it.`}
      />
      <p className="shrink-0 border-t border-line px-gutter py-1.5 text-2xs text-ink-faint">
        Parsed when you click away.
      </p>
    </div>
  );
}

function GridPane({ list, noun, onToggle, onKeyChange, onValueChange, onRemove, onAdd }: KeyValueGridProps) {
  // One box for the whole grid, not one per row: only one cell can be clicked at a time, and a box
  // per row is forty popovers waiting to be mounted.
  const box = useTokenBox();

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <div
        className="grid h-row items-center border-b border-line"
        style={{ gridTemplateColumns: GRID_TEMPLATE }}
        role="row"
      >
        <span />
        <span className={HEADER_CELL_CLASS}>Key</span>
        <span className={HEADER_CELL_CLASS}>Value</span>
        <span />
      </div>
      {list.pairs.map((pair, index) => (
        <div
          key={index}
          className="group grid items-center border-b border-line hover:bg-hover"
          style={{ gridTemplateColumns: GRID_TEMPLATE }}
          role="row"
        >
          <div className="flex h-row items-center justify-center">
            {onToggle === undefined ? null : (
              <input
                type="checkbox"
                checked={!pair.disabled}
                aria-label={`Include ${pair.key === EMPTY ? `this ${noun}` : pair.key}`}
                onChange={(event) => {
                  onToggle(pair, !event.currentTarget.checked);
                }}
                className="size-3 accent-accent"
              />
            )}
          </div>
          <DebouncedCell
            value={pair.key}
            disabled={pair.disabled}
            placeholder="key"
            onCommit={(next) => {
              onKeyChange(pair, next);
            }}
          />
          <DebouncedCell
            value={pair.value}
            disabled={pair.disabled}
            placeholder="value"
            onToken={box.report}
            onCommit={(next) => {
              onValueChange(pair, next);
            }}
          />
          <div className="flex h-row items-center justify-center opacity-0 group-hover:opacity-100 focus-within:opacity-100">
            <IconButton
              label={`Remove ${pair.key === EMPTY ? noun : pair.key}`}
              onClick={() => {
                onRemove(pair);
              }}
            >
              <DeleteIcon />
            </IconButton>
          </div>
        </div>
      ))}
      <AddRow noun={noun} onAdd={onAdd} />
      {box.clicked !== null && (
        <TokenBox key={box.clicked.name} name={box.clicked.name} at={box.clicked.at} onDismiss={box.dismiss} />
      )}
    </div>
  );
}

/**
 * A cell that fires on blur *and* on a debounce, so a value pasted and then sent with
 * Cmd+Enter without leaving the field is still in the store when the send happens.
 *
 * `key={value}` remounts the input when the stored value changes from outside, which is
 * how an external edit or a take-theirs conflict resolution reaches a cell the user is
 * not currently typing in. Cheap here because a grid is tens of rows, not thousands.
 */
function DebouncedCell({
  value,
  disabled,
  placeholder,
  onToken,
  onCommit,
}: {
  readonly value: string;
  readonly disabled: boolean;
  readonly placeholder: string;
  /** Absent on the key column: core interpolates a header's value and never its name. */
  readonly onToken?: TokenReporter;
  readonly onCommit: (value: string) => void;
}) {
  const [timer, setTimer] = useState<number | null>(null);

  return (
    <CellField
      key={value}
      defaultValue={value}
      placeholder={placeholder}
      tone={disabled ? DISABLED_TONE : PLAIN_TONE}
      onToken={onToken}
      onChange={(event) => {
        const next = event.currentTarget.value;
        if (timer !== null) window.clearTimeout(timer);
        setTimer(
          window.setTimeout(() => {
            onCommit(next);
          }, COMMIT_DEBOUNCE_MS),
        );
      }}
      onBlur={(event) => {
        if (timer !== null) window.clearTimeout(timer);
        setTimer(null);
        const next = event.currentTarget.value;
        if (next !== value) onCommit(next);
      }}
    />
  );
}

/**
 * A dedicated add row rather than Postman's always-present blank last row: a blank row
 * that is sometimes real and sometimes not is the thing people accidentally send.
 */
function AddRow({ noun, onAdd }: { readonly noun: string; readonly onAdd: (key: string, value: string) => void }) {
  const [key, setKey] = useState(EMPTY);

  const submit = () => {
    const trimmed = key.trim();
    if (trimmed === EMPTY) return;
    onAdd(trimmed, EMPTY);
    setKey(EMPTY);
  };

  return (
    <div className="grid items-center" style={{ gridTemplateColumns: GRID_TEMPLATE }}>
      <div className="flex h-row items-center justify-center text-glyph">
        <AddIcon />
      </div>
      <CellField
        value={key}
        placeholder={`New ${noun}`}
        aria-label={`New ${noun}`}
        onChange={(event) => {
          setKey(event.currentTarget.value);
        }}
        onBlur={submit}
        onKeyDown={(event) => {
          if (event.key === "Enter") submit();
        }}
      />
      <span />
      <span />
    </div>
  );
}
