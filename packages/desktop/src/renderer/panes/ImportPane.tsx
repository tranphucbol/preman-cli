/**
 * Import: a pasted `curl` or `grpcurl`, and the request file it would become.
 *
 * A dialog, like `MigratePane` and unlike the four panes in `stores/overlay.ts`, because an import
 * is a sentence with an end. The overlays are places you work — you leave the variable manager open
 * while you read a response — and this is a question with one answer, after which there is a new
 * tab to look at. A dialog is also what makes the paste box unmissable: it arrives focused with
 * nothing else on screen competing for the keystroke, which is the one gesture the feature is for.
 *
 * The one gesture being a paste is why the box is the first thing in it. Everything below the box is
 * downstream of that text and appears only once the engine has read it: the summary, the name, the
 * destination, the flags that did not survive, and the document itself.
 *
 * Plan-then-apply, like the protos pane, for a sharper reason. A shell command is a word list
 * whose meaning depends on a table of flags nobody has memorised, and the interesting half of an
 * import is what preman *refused* to carry across - a `-k`, a `--compressed`, a `-o file`. Writing
 * first and reporting after would make that a discovery about a file already on disk. So the
 * document is shown before it is written, and the drops are shown beside it.
 */
import * as Primitive from "@radix-ui/react-dialog";
import { useCallback, useEffect, useRef, useState } from "react";

import type { ImportPlan } from "@preman/desktop/engine/protocol.js";

import { mutate, planImport, type Failure } from "@preman/desktop/renderer/actions.js";
import {
  canImport,
  CLOSE_LABEL,
  defaultTarget,
  DESTINATION_LABEL,
  dismissible,
  DROPPED_TITLE,
  IMPORT_LABEL,
  importOp,
  importTargets,
  NAME_LABEL,
  NO_GROUPS_HINT,
  NO_PREVIEW,
  PANE_TITLE,
  PASTE_LABEL,
  PASTE_PLACEHOLDER,
  pastedCommand,
  previewLabel,
  previewTarget,
  previewVerb,
  WARNINGS_TITLE,
  type Preview,
} from "@preman/desktop/renderer/model/import.js";
import { useCatalogStore } from "@preman/desktop/renderer/stores/catalog.js";
import { Banner } from "@preman/desktop/renderer/ui/Banner.js";
import { cn } from "@preman/desktop/renderer/ui/cn.js";
import { CodeEditor } from "@preman/desktop/renderer/ui/CodeEditor.js";
import { Button, Field, IconButton, Labelled, Select, SelectOption } from "@preman/desktop/renderer/ui/Controls.js";
import { CloseIcon, PasteIcon, WarningIcon } from "@preman/desktop/renderer/ui/icons.js";
import { methodClass } from "@preman/desktop/renderer/ui/method.js";

const OVERLAY_CLASS = "scrim-enter fixed inset-0 z-menu bg-black/50";
/**
 * Wider and taller than `MigratePane`'s, and unpadded, because the content is not prose: a command,
 * a form row and a YAML document all want their own full-bleed band with a rule between them. The
 * `-translate-*` pair is restated inside `.modal-enter`'s `@starting-style`, so it is not optional.
 * `overflow-hidden` is what keeps those bands inside the rounded corner.
 */
const CONTENT_CLASS =
  "modal-enter fixed left-1/2 top-1/2 z-menu flex max-h-[calc(100vh-6rem)] w-[42rem] max-w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-lg border border-line-strong bg-panel shadow-2xl shadow-black/60";

/** Tall enough for a wrapped browser copy-as-cURL, short enough to leave the document visible. */
const BOX_CLASS = "h-32 shrink-0 border-b border-line";
const NAME_FIELD_ID = "import-name";
const DESTINATION_FIELD_ID = "import-destination";

export interface ImportPaneProps {
  readonly open: boolean;
  /** The group the dialog opens onto. Absent from the menu and the palette, set from a right-click. */
  readonly parentId?: string;
  readonly onDismiss: () => void;
}

export function ImportPane({ open, parentId, onDismiss }: ImportPaneProps): React.JSX.Element {
  /*
   * Held here rather than in the flow below, because it is the dismissal that has to respect it and
   * dismissal is the `Root`'s — the same split `MigratePane` and `AskDialog` make. Escape and an
   * outside click both arrive at `onOpenChange`.
   */
  const [importing, setImporting] = useState(false);

  const dismiss = useCallback(() => {
    setImporting(false);
    onDismiss();
  }, [onDismiss]);

  return (
    <Primitive.Root
      open={open}
      onOpenChange={(next) => {
        if (!next && dismissible(importing)) dismiss();
      }}
    >
      <Primitive.Portal>
        <Primitive.Overlay className={OVERLAY_CLASS} />
        <Primitive.Content
          className={CONTENT_CLASS}
          aria-describedby={undefined}
          /*
           * The editor takes the focus, not the first button. Radix focuses the first tabbable
           * child on open, which here is Paste — and landing on a button in a dialog whose whole
           * purpose is to receive Cmd+V is landing one Tab away from where everyone is going.
           */
          onOpenAutoFocus={(event) => {
            event.preventDefault();
          }}
        >
          {/* Mounted only while open, which is what resets the box, the preview and the
              destination between two imports without an effect clearing them: a reopen is a
              fresh mount, and it re-reads the clipboard, which is the point. */}
          <ImportFlow
            {...(parentId === undefined ? {} : { parentId })}
            onImporting={setImporting}
            onDismiss={dismiss}
          />
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  );
}

function ImportFlow({
  parentId,
  onImporting,
  onDismiss,
}: {
  readonly parentId?: string;
  readonly onImporting: (importing: boolean) => void;
  readonly onDismiss: () => void;
}): React.JSX.Element {
  const nodes = useCatalogStore((state) => state.nodes);
  const selectedId = useCatalogStore((state) => state.selectedId);

  const [text, setText] = useState("");
  const [preview, setPreview] = useState<Preview>(NO_PREVIEW);
  const [name, setName] = useState("");
  const [failure, setFailure] = useState<Failure | null>(null);
  const [importing, setImporting] = useState(false);

  const targets = importTargets(nodes);
  const [target, setTarget] = useState(() => defaultTarget(targets, parentId, selectedId));

  /*
   * Which paste the preview belongs to. A plan is a round trip and the box is a text field, so
   * two pastes in quick succession can answer out of order; without this the dialog would settle
   * on the plan for text the box no longer holds.
   */
  const asked = useRef("");

  const plan = useCallback(
    async (pasted: string) => {
      asked.current = pasted;
      if (pasted.trim() === "") {
        setPreview(NO_PREVIEW);
        return;
      }
      setPreview({ kind: "planning" });
      const result = await planImport(pasted, undefined, target === "" ? undefined : target);
      if (asked.current !== pasted) return;
      if (!result.ok) {
        setPreview({ kind: "rejected", message: result.failure.message, details: result.failure.details });
        return;
      }
      setPreview({ kind: "planned", plan: result.value });
      setName(result.value.name);
    },
    [target],
  );

  /*
   * Read the clipboard once, on open, and only keep it if it is a command. This is the whole
   * point of the feature: the user copied a curl somewhere else, and the dialog they just opened
   * should already be showing what it would become.
   */
  useEffect(() => {
    let live = true;
    void navigator.clipboard
      .readText()
      .then((clipboard) => {
        const command = pastedCommand(clipboard);
        if (!live || command === "") return;
        setText(command);
        void plan(command);
      })
      // A denied clipboard is not a failure worth a banner: the box is still there to paste into.
      .catch(() => undefined);
    return () => {
      live = false;
    };
    // Open-once, deliberately: re-reading the clipboard when the destination changes would
    // overwrite whatever the user has typed since.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const paste = useCallback(() => {
    void navigator.clipboard
      .readText()
      .then((clipboard) => {
        setText(clipboard.trim());
        void plan(clipboard.trim());
      })
      // Same silence as on open, and for the same reason: the box is still there to paste into.
      .catch(() => undefined);
  }, [plan]);

  const runImport = useCallback(async () => {
    if (preview.kind !== "planned") return;
    setImporting(true);
    onImporting(true);
    setFailure(null);
    const result = await mutate(importOp(preview.plan, target, name), { open: true });
    setImporting(false);
    onImporting(false);
    if (result !== null) {
      setFailure(result);
      return;
    }
    onDismiss();
  }, [preview, target, name, onImporting, onDismiss]);

  return (
    <>
      {/*
        The two icons in the title row are the ones that act on the box: refill it, or abandon it.
        Neither commits anything, which is why an unlabelled glyph is enough for them and is not
        enough for the import itself.
      */}
      <div className="flex h-tab shrink-0 items-center gap-1 border-b border-line px-gutter">
        <Primitive.Title className="text-sm font-medium text-ink">{PANE_TITLE}</Primitive.Title>
        <div className="flex-1" />
        <IconButton label={PASTE_LABEL} disabled={importing} onClick={paste}>
          <PasteIcon />
        </IconButton>
        <IconButton label={CLOSE_LABEL} disabled={importing} onClick={onDismiss}>
          <CloseIcon />
        </IconButton>
      </div>

      {failure !== null && <Banner tone="danger" message={failure.message} details={failure.details} />}

      <CodeEditor
        value={text}
        language="text"
        gutter={false}
        autoFocus
        placeholder={PASTE_PLACEHOLDER}
        className={BOX_CLASS}
        onCommit={(next) => {
          setText(next);
          void plan(next);
        }}
      />

      {targets.length === 0 ? (
        <p className="p-gutter text-xs text-ink-faint">{NO_GROUPS_HINT}</p>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          {preview.kind === "rejected" && (
            <div className="p-gutter">
              <p className="flex items-start gap-2 text-xs leading-relaxed text-danger" aria-live="polite">
                <WarningIcon className="mt-0.5 shrink-0" />
                {preview.message}
              </p>
              {preview.details.length > 0 && (
                <ul className="mt-2 flex flex-col gap-0.5 text-2xs text-ink-dim">
                  {preview.details.map((detail) => (
                    <li key={detail}>{detail}</li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {preview.kind === "planned" && (
            <Planned
              plan={preview.plan}
              name={name}
              onName={setName}
              target={target}
              targets={targets}
              onTarget={(next) => {
                setTarget(next);
              }}
            />
          )}
        </div>
      )}

      {/*
        The one control here that writes a file, so it is the one that says so in words and sits
        where a dialog's commit belongs. It is rendered even with nothing planned, disabled, rather
        than appearing once the preview arrives: a button that materialises under the pointer is a
        button that gets clicked by accident.
      */}
      <div className="flex h-bar shrink-0 items-center justify-end border-t border-line px-gutter">
        <Button variant="primary" disabled={!canImport(preview, target, importing)} onClick={() => void runImport()}>
          {IMPORT_LABEL}
        </Button>
      </div>
    </>
  );
}

/** Everything downstream of a plan: what it is, what it will be called, and what it dropped. */
function Planned({
  plan,
  name,
  onName,
  target,
  targets,
  onTarget,
}: {
  readonly plan: ImportPlan;
  readonly name: string;
  readonly onName: (name: string) => void;
  readonly target: string;
  readonly targets: readonly { readonly id: string; readonly label: string }[];
  readonly onTarget: (id: string) => void;
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3 p-gutter">
      <p className="flex items-baseline gap-2 text-xs">
        <span className={cn("font-mono font-medium", methodClass(previewVerb(plan)))}>{previewLabel(plan)}</span>
        <span className="truncate font-mono text-ink-dim">{previewTarget(plan)}</span>
      </p>

      <div className="flex items-start gap-3">
        <Labelled label={NAME_LABEL} htmlFor={NAME_FIELD_ID}>
          <Field
            id={NAME_FIELD_ID}
            defaultValue={name}
            key={plan.name}
            onBlur={(event) => {
              onName(event.currentTarget.value);
            }}
          />
        </Labelled>
        <Labelled label={DESTINATION_LABEL} htmlFor={DESTINATION_FIELD_ID}>
          <Select id={DESTINATION_FIELD_ID} aria-label={DESTINATION_LABEL} value={target} onValueChange={onTarget}>
            {targets.map((option) => (
              <SelectOption key={option.id} value={option.id}>
                {option.label}
              </SelectOption>
            ))}
          </Select>
        </Labelled>
      </div>

      {plan.dropped.length > 0 && (
        <div>
          <p className="flex items-center gap-2 text-2xs font-medium tracking-wide text-warn uppercase">
            <WarningIcon />
            {DROPPED_TITLE}
          </p>
          <ul className="mt-1 flex flex-col gap-0.5 text-2xs text-ink-dim">
            {plan.dropped.map((item) => (
              <li key={item.flag}>
                <span className="font-mono">{item.flag}</span> — {item.reason}
              </li>
            ))}
          </ul>
        </div>
      )}

      {plan.warnings.length > 0 && (
        <div>
          <p className="flex items-center gap-2 text-2xs font-medium tracking-wide text-warn uppercase">
            <WarningIcon />
            {WARNINGS_TITLE}
          </p>
          <ul className="mt-1 flex flex-col gap-0.5 text-2xs text-ink-dim">
            {plan.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </div>
      )}

      <CodeEditor value={plan.contents} language="yaml" readOnly gutter={false} className="h-48 shrink-0" />
    </div>
  );
}
