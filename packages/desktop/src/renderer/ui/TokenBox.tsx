/**
 * What a `{{token}}` is, and where to change it, without leaving the thing you were editing.
 *
 * The box never takes focus. `modal={false}` and a prevented `onOpenAutoFocus` are the whole of
 * decision 6: the click that opened it still placed the caret, so a plain click in a URL or a body
 * keeps meaning what it means everywhere else and typing simply carries on. The cost is that
 * reaching the field is a second, deliberate click, which is the right way round - the common case
 * is wanting to know what the name resolves to, not wanting to change it.
 *
 * It also never decides which layer wins. `readVariables` answers with a `VariableBinding` whose
 * `scope` and `shadowed` are already resolved, and `writeVariable` answers with the re-read view,
 * so every value on screen came from the engine (ADR 025).
 */
import * as PopoverPrimitive from "@radix-ui/react-popover";
import { useCallback, useEffect, useRef, useState } from "react";

import type { VariableView } from "@preman/desktop/engine/protocol.js";
import { readVariables, writeVariable, type Failure } from "@preman/desktop/renderer/actions.js";
import { tokenState, type TokenState } from "@preman/desktop/renderer/model/tokens.js";
import { useSessionStore } from "@preman/desktop/renderer/stores/session.js";

import { Button, Field } from "./Controls.js";
import type { TokenReporter } from "./template.js";

/** `Menu.tsx`'s surface. There is one kind of floating panel in this app, and this is it. */
const CONTENT_CLASS =
  "z-menu flex w-72 flex-col gap-2 rounded-md border border-line-strong bg-panel p-2.5 shadow-lg shadow-black/40";

const NOTE_CLASS = "text-2xs leading-snug text-ink-faint";
const LABEL_CLASS = "text-2xs text-ink-dim";

const ENTER = "Enter";
const EMPTY = "";

/** The gap between the token and the box, matching every other floating surface here. */
const SIDE_OFFSET = 6;

const LOADING = "Reading the environment…";

/**
 * The sentence about globals, said once for the whole app.
 *
 * `VariablesPane` says it too, and imports it from here rather than restating it: two wordings of
 * "this file is not ours to write" is how one of them ends up describing a limit that moved.
 */
export const GLOBALS_READ_ONLY_HINT = "preman has no writer for globals: edit the file and this pane follows.";

const DYNAMIC_NOTE = "A dynamic variable. preman generates one at send time, so there is no value to store.";
const NO_ENVIRONMENT_NOTE =
  "No environment is chosen, so there is nowhere to define this. Choose one in the toolbar and it can be set here.";

/**
 * What Radix's popper needs to place a surface: a rect and nothing else.
 *
 * Declared here rather than imported from `@radix-ui/rect`, which is a transitive package this app
 * does not depend on. Structural typing makes the two the same type.
 */
interface Measurable {
  getBoundingClientRect: () => DOMRect;
}

export interface TokenBoxProps {
  /** The name inside the braces, already trimmed. */
  readonly name: string;
  /** Where to anchor. A DOM rect, because both callers have one and neither has an element. */
  readonly at: DOMRect;
  readonly onDismiss: () => void;
  /**
   * For a caller that is drawing the token itself and has to redraw it. Only the body editor is:
   * it holds a set of unresolved names that a write has just made smaller. Everywhere else the
   * session's write counter is enough, and this is absent.
   */
  readonly onWrite?: () => void;
}

/** The token a pane's box is open on. One at a time, per pane: two open boxes is two carets. */
export interface ClickedToken {
  readonly name: string;
  readonly at: DOMRect;
}

export interface TokenBoxHost {
  /** Hand this to every `onToken` in the pane. */
  readonly report: TokenReporter;
  /** `null` while no box is open. Render one `TokenBox` when it is not. */
  readonly clicked: ClickedToken | null;
  readonly dismiss: () => void;
}

/**
 * The state one pane needs to own a box, on `useMethodPicker`'s shape: handlers and state out, the
 * element rendered by the caller.
 *
 * One per pane rather than one per app. A pane knows where its own boxes may appear and, more to
 * the point, knows what to do after a write - the body editor drops a lint diagnostic, the
 * variables table re-reads its view - and an app-level singleton would have to be told.
 */
export function useTokenBox(): TokenBoxHost {
  const [clicked, setClicked] = useState<ClickedToken | null>(null);

  // Stable, because both go to a `CodeEditor` whose mount effect and handler refs are keyed on
  // identity, and to grid cells that would otherwise re-render for a new closure per row.
  const report = useCallback<TokenReporter>((name, at) => {
    setClicked({ name, at });
  }, []);
  const dismiss = useCallback(() => {
    setClicked(null);
  }, []);

  return { report, clicked, dismiss };
}

export function TokenBox({ name, at, onDismiss, onWrite }: TokenBoxProps) {
  const environment = useSessionStore((state) => state.environment);
  const countVariableWrite = useSessionStore((state) => state.countVariableWrite);

  const [view, setView] = useState<VariableView | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);

  // A virtual anchor rather than an element: an absolutely positioned marker would be laid out
  // inside whatever the box was rendered in, and the grid's rows are moved by `transform`, which
  // is exactly the thing that makes `position: fixed` stop meaning the viewport.
  const rect = useRef(at);
  useEffect(() => {
    rect.current = at;
  }, [at]);
  const anchor = useRef<Measurable | null>({ getBoundingClientRect: () => rect.current });

  useEffect(() => {
    let live = true;
    void readVariables(environment).then((result) => {
      if (!live) return;
      if (result.ok) {
        setView(result.value);
        setFailure(null);
      } else setFailure(result.failure);
    });
    return () => {
      live = false;
    };
  }, [environment]);

  const commit = useCallback(
    (into: string, value: string) => {
      void writeVariable({ environment: into, key: name, value }).then((result) => {
        if (!result.ok) {
          setFailure(result.failure);
          return;
        }
        setView(result.value);
        setFailure(null);
        // Two notifications, for two audiences. The counter is what every other pane watches, and
        // `onWrite` is how the editor this box opened over drops the diagnostic it is still
        // drawing under a name that now resolves.
        countVariableWrite();
        onWrite?.();
      });
    },
    [name, countVariableWrite, onWrite],
  );

  return (
    <PopoverPrimitive.Root
      open
      onOpenChange={(next) => {
        if (!next) onDismiss();
      }}
    >
      <PopoverPrimitive.Anchor virtualRef={anchor} />
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          side="bottom"
          align="start"
          sideOffset={SIDE_OFFSET}
          className={CONTENT_CLASS}
          // Decision 6. Without this the box steals the caret the click just placed.
          onOpenAutoFocus={(event) => {
            event.preventDefault();
          }}
        >
          <p className="font-mono text-xs text-ink">{`{{${name}}}`}</p>
          {failure !== null && <p className="text-2xs text-danger">{failure.message}</p>}
          {view === null ? (
            <p className={NOTE_CLASS}>{LOADING}</p>
          ) : (
            <Body name={name} state={tokenState(view, name)} onCommit={commit} />
          )}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

/**
 * One arm per state, and every arm says which one it is.
 *
 * Decision 9: a box that offers no field must say why it does not, or it reads as broken. The
 * `switch` is exhaustive over `TokenState` so a sixth situation cannot be added without a sentence
 * for it.
 */
function Body({
  name,
  state,
  onCommit,
}: {
  readonly name: string;
  readonly state: TokenState;
  readonly onCommit: (environment: string, value: string) => void;
}) {
  switch (state.kind) {
    case "dynamic":
      return <p className={NOTE_CLASS}>{DYNAMIC_NOTE}</p>;
    case "no-environment":
      return <p className={NOTE_CLASS}>{NO_ENVIRONMENT_NOTE}</p>;
    case "read-only":
      return (
        <>
          <p className="font-mono text-xs break-all text-ink-dim">{state.value}</p>
          <p className={NOTE_CLASS}>{GLOBALS_READ_ONLY_HINT}</p>
          <p className="font-mono text-2xs break-all text-ink-faint">{state.file}</p>
        </>
      );
    case "writable":
      return (
        <ValueField
          key={state.value}
          label={`Value in ${state.environment}`}
          value={state.value}
          note={state.shadows.length > 0 ? `Overrides ${state.shadows.join(", ")}.` : undefined}
          onCommit={(next) => {
            onCommit(state.environment, next);
          }}
        />
      );
    case "absent":
      return (
        <Define
          name={name}
          environment={state.environment}
          onCommit={(next) => {
            onCommit(state.environment, next);
          }}
        />
      );
  }
}

/**
 * The editable case. Uncontrolled and committed on blur, like every other field here, and keyed by
 * the value it was opened on so the answered view replaces what is on screen.
 */
function ValueField({
  label,
  value,
  note,
  onCommit,
}: {
  readonly label: string;
  readonly value: string;
  readonly note?: string;
  readonly onCommit: (value: string) => void;
}) {
  return (
    <>
      <span className={LABEL_CLASS}>{label}</span>
      <Field
        mono
        defaultValue={value}
        aria-label={label}
        onBlur={(event) => {
          if (event.currentTarget.value !== value) onCommit(event.currentTarget.value);
        }}
        onKeyDown={(event) => {
          if (event.key === ENTER) event.currentTarget.blur();
        }}
      />
      {note !== undefined && <p className={NOTE_CLASS}>{note}</p>}
    </>
  );
}

/**
 * The absent case, which needs a button and not a blur.
 *
 * An empty string is a legal value - the fixture workspace has two - so "the field lost focus while
 * empty" cannot mean "define this key as empty". Appending a key to a file someone else's request
 * also reads is an explicit act, so it gets an explicit control.
 */
function Define({
  name,
  environment,
  onCommit,
}: {
  readonly name: string;
  readonly environment: string;
  readonly onCommit: (value: string) => void;
}) {
  const draft = useRef<HTMLInputElement | null>(null);

  function define(): void {
    onCommit(draft.current?.value ?? EMPTY);
  }

  return (
    <>
      <p className={NOTE_CLASS}>{`Not defined in ${environment}.`}</p>
      <Field
        ref={draft}
        mono
        placeholder="Value"
        aria-label={`Value for ${name}`}
        onKeyDown={(event) => {
          if (event.key === ENTER) define();
        }}
      />
      <Button variant="primary" tier="chrome" onClick={define}>
        {`Define in ${environment}`}
      </Button>
    </>
  );
}
