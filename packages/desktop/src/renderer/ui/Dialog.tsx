/**
 * The questions this app asks: name something, confirm destroying something, or say what to create,
 * what to call it and where to put it.
 *
 * All of them are one mounted Radix `Dialog` driven by a discriminated union, not a dialog per
 * call site. A tree with five thousand rows must not carry five thousand dialogs, and a modal
 * that only exists while it is open cannot leak a stale target.
 *
 * `create` is a product-specific variant in an otherwise generic module, and it is here for
 * that single-root reason rather than because it belongs to `ui/`. It carries plain data —
 * `{ id, label }` destinations and a `CreateTarget` string — so nothing here learns what a catalog
 * node is. If a fourth product-specific variant ever wants in, that is the signal to invert this: a
 * `panes/` dialog with `ui/` providing the shell.
 */
import * as Primitive from "@radix-ui/react-dialog";
import { useCallback, useState, type FormEvent } from "react";

import type { RequestKind } from "@preman/desktop/engine/protocol.js";
import { Button, Field, LABEL_CLASS, Labelled, Select, SelectOption } from "@preman/desktop/renderer/ui/Controls.js";
import { CheckIcon } from "@preman/desktop/renderer/ui/icons.js";
import { cn } from "@preman/desktop/renderer/ui/cn.js";

const OVERLAY_CLASS = "scrim-enter fixed inset-0 z-menu bg-black/50";

/**
 * The `-translate-*` utilities stay, and `.modal-enter`'s `@starting-style` restates them inside its
 * own `transform` on purpose: a `transform` in `@starting-style` replaces the whole property, so a
 * bare `scale(0.98)` there would launch the dialog from the centre of the screen.
 */
const CONTENT_CLASS =
  "modal-enter fixed left-1/2 top-1/3 z-menu w-96 -translate-x-1/2 -translate-y-1/2 rounded-lg border border-line-strong bg-panel p-4 shadow-2xl shadow-black/60";

/** A rejected promise is not a sentence, so say the one thing that is always true instead. */
const UNEXPECTED_FAILURE = "That did not work.";

/**
 * What an asynchronous name confirmation reports back.
 *
 * `void` is still allowed, and every existing call site is still one: a rename or a new folder is
 * handled by the engine, which reports its own failure through the window's banner, so the dialog
 * has nothing to wait for. An answer that may be refused — creating a workspace whose name might
 * be taken — returns a promise instead, and the dialog stays open until it says `ok`.
 */
export type AskOutcome = { readonly ok: true } | { readonly ok: false; readonly message: string };

/**
 * The three things the `+` can make. A superset of `RequestKind` rather than a parallel enum, so
 * the two request arms stay the exact strings the engine already takes and only `folder` is new.
 */
export type CreateTarget = RequestKind | "folder";

/** A question the app is waiting on an answer to. */
export type Ask =
  | {
      readonly kind: "name";
      readonly title: string;
      readonly label: string;
      readonly initial: string;
      readonly submit: string;
      readonly onConfirm: (name: string) => void | Promise<AskOutcome>;
    }
  | {
      readonly kind: "confirm";
      readonly title: string;
      readonly body: string;
      readonly submit: string;
      readonly onConfirm: () => void;
    }
  /**
   * What to create, what to call it, where to put it — in that order, then one `Create`.
   *
   * The protocol used to be answered by which of two submits you pressed, on the reasoning that "a
   * dialog that asks for a name and a protocol is two questions where one item answers both". It is
   * a visible radio list instead, because the reasoning's own premise — the protocol decides which
   * fields the request even has, so it is not a setting you change later — argues for showing that
   * choice before the name is typed rather than hiding it in the way out. Decision 28.
   *
   * A folder is neither a protocol nor a third submit competing with the other two: it is the
   * secondary action, on the left of the footer, and it takes the name and the destination the form
   * already holds. The caller is told which of the three was pressed and does the rest.
   */
  | {
      readonly kind: "create";
      readonly title: string;
      readonly initial: string;
      readonly initialTarget: RequestKind;
      readonly destinations: readonly { readonly id: string; readonly label: string }[];
      readonly initialDestinationId: string;
      /** Which destination means "not inside anything", where only a group can be made. */
      readonly rootDestinationId: string;
      readonly onConfirm: (name: string, destinationId: string, target: CreateTarget) => void;
    };

export interface AskDialogProps {
  readonly ask: Ask | null;
  readonly onClose: () => void;
}

export function AskDialog({ ask, onClose }: AskDialogProps): React.JSX.Element {
  /*
   * Held here rather than in the form, because it is the dismissal that has to respect it and
   * dismissal is the `Root`'s. Escape, an outside click and the Cancel button all end up in
   * `onOpenChange`, and a user who closed the dialog while the request was still creating and
   * opening a workspace would have closed it over something that then happened anyway.
   */
  const [pending, setPending] = useState(false);

  const close = useCallback(() => {
    setPending(false);
    onClose();
  }, [onClose]);

  return (
    <Primitive.Root
      open={ask !== null}
      onOpenChange={(open) => {
        if (!open && !pending) close();
      }}
    >
      <Primitive.Portal>
        <Primitive.Overlay className={OVERLAY_CLASS} />
        <Primitive.Content className={CONTENT_CLASS} aria-describedby={undefined}>
          {ask === null ? null : <AskBody ask={ask} pending={pending} onPending={setPending} onClose={close} />}
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  );
}

function AskBody({
  ask,
  pending,
  onPending,
  onClose,
}: {
  readonly ask: Ask;
  readonly pending: boolean;
  readonly onPending: (pending: boolean) => void;
  readonly onClose: () => void;
}): React.JSX.Element {
  return (
    <>
      <Primitive.Title className="mb-3 text-sm font-medium text-ink">{ask.title}</Primitive.Title>
      {ask.kind === "name" ? (
        <NameForm ask={ask} pending={pending} onPending={onPending} onClose={onClose} />
      ) : ask.kind === "confirm" ? (
        <ConfirmForm ask={ask} onClose={onClose} />
      ) : (
        <CreateForm ask={ask} onClose={onClose} />
      )}
    </>
  );
}

const NAME_INPUT_ID = "ask-create-name";
const DESTINATION_INPUT_ID = "ask-create-destination";

/** One radio group on screen at a time, so the name is a constant rather than a generated id. */
const TARGET_GROUP = "ask-create-target";

const TARGET_CHOICES = [
  { value: "http-request", label: "HTTP request" },
  { value: "grpc-request", label: "gRPC request" },
] as const satisfies readonly { readonly value: RequestKind; readonly label: string }[];

/**
 * The secondary submit's two words. A group directly under the workspace root is what this app
 * calls a collection and a group anywhere else is what it calls a folder — the file written is the
 * same either way, and only the position differs — so the button says which one the picker above it
 * has selected rather than making the user learn that.
 */
const GROUP_SUBMIT = "New folder";
const ROOT_GROUP_SUBMIT = "New collection";

/** Why `Create` is off while the root is selected. A disabled button with no reason is a dead end. */
const ROOT_HINT = "A request has to live in a collection. Make one first, or pick one above.";

/**
 * The row tier and the sidebar's paint, because this is a vertical list with one current entry and
 * `docs/design-system.md` says that is what those wear. The tick is `SelectOption`'s, in the same
 * place for the same reason: it marks the row you are already on.
 */
const CHOICE_CLASS =
  "flex h-row cursor-default items-center gap-2 rounded-sm px-2 text-xs text-ink select-none has-[:focus-visible]:ring-1 has-[:focus-visible]:ring-accent";

function CreateForm({
  ask,
  onClose,
}: {
  readonly ask: Extract<Ask, { kind: "create" }>;
  readonly onClose: () => void;
}): React.JSX.Element {
  const [target, setTarget] = useState<RequestKind>(ask.initialTarget);
  const [name, setName] = useState(ask.initial);
  const [destinationId, setDestinationId] = useState(ask.initialDestinationId);
  const trimmed = name.trim();
  const unnamed = trimmed.length === 0;
  const atRoot = destinationId === ask.rootDestinationId;

  function commit(chosen: CreateTarget): void {
    ask.onConfirm(trimmed, destinationId, chosen);
    onClose();
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        // Guarded rather than trusted: Enter reaches here from the name field even while the
        // submit button is disabled.
        if (unnamed || atRoot) return;
        commit(target);
      }}
    >
      <div className="flex flex-col gap-3">
        <div>
          <p className={LABEL_CLASS}>Type</p>
          {/*
            Native radios inside labels, the same mechanism `SettingsPane`'s `Choice` uses and for
            the same reason: arrow-key navigation, the roving tab stop and "2 of 2" all arrive
            without being written here. The markup is not shared with it because the two are
            different shapes in the design system — a card in a grid there, a row in a vertical list
            here — and one component with a layout prop would make "which one" a judgement call.
          */}
          <div role="radiogroup" aria-label="Type" className="mt-1.5 flex flex-col gap-px">
            {TARGET_CHOICES.map((choice) => {
              const checked = choice.value === target;
              return (
                <label key={choice.value} className={cn(CHOICE_CLASS, checked ? "bg-selected" : "hover:bg-hover")}>
                  <input
                    type="radio"
                    name={TARGET_GROUP}
                    value={choice.value}
                    checked={checked}
                    onChange={() => setTarget(choice.value)}
                    className="sr-only"
                  />
                  {choice.label}
                  {checked && <CheckIcon className="ml-auto text-accent" />}
                </label>
              );
            })}
          </div>
        </div>
        <Labelled label="Name" htmlFor={NAME_INPUT_ID}>
          {/* Controlled for the same reason `NameForm`'s is: the submit gates on the value. */}
          {/*
            Autofocused here rather than on the group above: the type has a defensible default and
            the name has none, so the keyboard path is still type-a-name-and-press-Enter — which is
            what it was when Enter secretly meant HTTP, except that now it means what is on screen.
          */}
          <Field id={NAME_INPUT_ID} value={name} autoFocus onChange={(event) => setName(event.target.value)} />
        </Labelled>
        <Labelled label="In" htmlFor={DESTINATION_INPUT_ID} {...(atRoot ? { hint: ROOT_HINT } : {})}>
          <Select id={DESTINATION_INPUT_ID} full value={destinationId} onValueChange={setDestinationId} aria-label="In">
            {ask.destinations.map((destination) => (
              <SelectOption key={destination.id} value={destination.id}>
                {destination.label}
              </SelectOption>
            ))}
          </Select>
        </Labelled>
      </div>
      {/*
        Its own footer rather than `Actions`, for the one thing `Actions` does not draw: a secondary
        action, on the left, away from the pair that answers the dialog as asked. It is not a third
        `Create …` in the primary group, because it makes a different kind of thing rather than the
        same thing differently — and it leaves the accent on `Create` alone.
      */}
      <div className="mt-4 flex items-center gap-2">
        <Button disabled={unnamed} onClick={() => commit("folder")}>
          {atRoot ? ROOT_GROUP_SUBMIT : GROUP_SUBMIT}
        </Button>
        <div className="ml-auto flex gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={unnamed || atRoot}>
            Create
          </Button>
        </div>
      </div>
    </form>
  );
}

function NameForm({
  ask,
  pending,
  onPending,
  onClose,
}: {
  readonly ask: Extract<Ask, { kind: "name" }>;
  readonly pending: boolean;
  readonly onPending: (pending: boolean) => void;
  readonly onClose: () => void;
}): React.JSX.Element {
  const [name, setName] = useState(ask.initial);
  const [error, setError] = useState<string | null>(null);
  const trimmed = name.trim();

  function onSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (trimmed.length === 0 || pending) return;

    const answer = ask.onConfirm(trimmed);
    // Nothing to wait for: the caller reports its own failures elsewhere, so this is the behaviour
    // every synchronous call site already had.
    if (answer === undefined) {
      onClose();
      return;
    }

    setError(null);
    onPending(true);
    void answer.then(
      (outcome) => {
        onPending(false);
        if (outcome.ok) onClose();
        else setError(outcome.message);
      },
      (cause: unknown) => {
        onPending(false);
        setError(cause instanceof Error ? cause.message : UNEXPECTED_FAILURE);
      },
    );
  }

  return (
    <form onSubmit={onSubmit}>
      <label className="mb-1 block text-2xs font-medium tracking-wide text-ink-dim uppercase" htmlFor="ask-name">
        {ask.label}
      </label>
      {/*
        The one controlled `Field` in the app. Everywhere else a keystroke lands in a store and
        a re-render is waste, but here the submit button's enabled state depends on the value.
      */}
      {/*
        Not disabled while pending. A disabled input loses focus, and the caret would then have to
        be found again by hand to correct the very name the refusal is about. Submitting twice is
        prevented where it happens - the guard in `onSubmit` and the disabled button - rather than
        by taking the field away.
      */}
      <Field
        id="ask-name"
        value={name}
        autoFocus
        onChange={(event) => {
          setName(event.target.value);
          // A refusal was about the name that was submitted. The moment it changes, the message is
          // about something the user is no longer looking at.
          setError(null);
        }}
      />
      {/*
        One semantic `danger` line attached to the field, not a banner: the answer belongs beside
        the thing that caused it. `aria-live` because it appears without the focus moving, and a
        screen reader would otherwise report nothing at all in reply to a submit.
      */}
      <p className="mt-1 text-2xs text-danger" aria-live="polite">
        {error}
      </p>
      <Actions submit={ask.submit} disabled={trimmed.length === 0} pending={pending} onCancel={onClose} />
    </form>
  );
}

function ConfirmForm({
  ask,
  onClose,
}: {
  readonly ask: Extract<Ask, { kind: "confirm" }>;
  readonly onClose: () => void;
}): React.JSX.Element {
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        ask.onConfirm();
        onClose();
      }}
    >
      <p className="text-xs leading-relaxed text-ink-dim">{ask.body}</p>
      <Actions submit={ask.submit} danger onCancel={onClose} />
    </form>
  );
}

function Actions({
  submit,
  disabled = false,
  danger = false,
  pending = false,
  onCancel,
}: {
  readonly submit: string;
  readonly disabled?: boolean;
  readonly danger?: boolean;
  /** In flight: neither button acts, so the answer cannot be sent twice or walked away from. */
  readonly pending?: boolean;
  readonly onCancel: () => void;
}): React.JSX.Element {
  return (
    <div className="mt-4 flex justify-end gap-2">
      <Button disabled={pending} onClick={onCancel}>
        Cancel
      </Button>
      {/* Submitting is the reason the dialog is open, so it carries the only accent on screen. */}
      <Button type="submit" variant={danger ? "danger" : "primary"} disabled={disabled || pending}>
        {submit}
      </Button>
    </div>
  );
}
