/**
 * The two questions this app asks: name something, or confirm destroying something.
 *
 * Both are one mounted Radix `Dialog` driven by a discriminated union, not a dialog per call
 * site. A tree with five thousand rows must not carry five thousand dialogs, and a modal that
 * only exists while it is open cannot leak a stale target.
 */
import * as Primitive from "@radix-ui/react-dialog";
import { useState, type FormEvent } from "react";

import { Button, Field } from "@preman/desktop/renderer/ui/Controls.js";

const OVERLAY_CLASS = "fixed inset-0 z-menu bg-black/50";

const CONTENT_CLASS =
  "fixed left-1/2 top-1/3 z-menu w-96 -translate-x-1/2 -translate-y-1/2 rounded-lg border border-line-strong bg-panel p-4 shadow-2xl shadow-black/60";

/** A question the app is waiting on an answer to. */
export type Ask =
  | {
      readonly kind: "name";
      readonly title: string;
      readonly label: string;
      readonly initial: string;
      readonly submit: string;
      readonly onConfirm: (name: string) => void;
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
  return (
    <Primitive.Root
      open={ask !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Primitive.Portal>
        <Primitive.Overlay className={OVERLAY_CLASS} />
        <Primitive.Content className={CONTENT_CLASS} aria-describedby={undefined}>
          {ask === null ? null : <AskBody ask={ask} onClose={onClose} />}
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  );
}

function AskBody({ ask, onClose }: { readonly ask: Ask; readonly onClose: () => void }): React.JSX.Element {
  return (
    <>
      <Primitive.Title className="mb-3 text-sm font-medium text-ink">{ask.title}</Primitive.Title>
      {ask.kind === "name" ? <NameForm ask={ask} onClose={onClose} /> : <ConfirmForm ask={ask} onClose={onClose} />}
    </>
  );
}

function NameForm({
  ask,
  onClose,
}: {
  readonly ask: Extract<Ask, { kind: "name" }>;
  readonly onClose: () => void;
}): React.JSX.Element {
  const [name, setName] = useState(ask.initial);
  const trimmed = name.trim();

  function onSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (trimmed.length === 0) return;
    ask.onConfirm(trimmed);
    onClose();
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
      <Field
        id="ask-name"
        value={name}
        autoFocus
        onChange={(event) => {
          setName(event.target.value);
        }}
      />
      <Actions submit={ask.submit} disabled={trimmed.length === 0} onCancel={onClose} />
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
  onCancel,
}: {
  readonly submit: string;
  readonly disabled?: boolean;
  readonly danger?: boolean;
  readonly onCancel: () => void;
}): React.JSX.Element {
  return (
    <div className="mt-4 flex justify-end gap-2">
      <Button onClick={onCancel}>Cancel</Button>
      {/* Submitting is the reason the dialog is open, so it carries the only accent on screen. */}
      <Button type="submit" variant={danger ? "danger" : "primary"} disabled={disabled}>
        {submit}
      </Button>
    </div>
  );
}
