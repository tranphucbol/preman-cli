/**
 * The two questions this app asks: name something, or confirm destroying something.
 *
 * Both are one mounted Radix `Dialog` driven by a discriminated union, not a dialog per call
 * site. A tree with five thousand rows must not carry five thousand dialogs, and a modal that
 * only exists while it is open cannot leak a stale target.
 */
import * as Primitive from "@radix-ui/react-dialog";
import { useCallback, useState, type FormEvent } from "react";

import { Button, Field } from "@preman/desktop/renderer/ui/Controls.js";

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
      ) : (
        <ConfirmForm ask={ask} onClose={onClose} />
      )}
    </>
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
