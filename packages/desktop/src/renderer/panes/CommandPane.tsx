/**
 * Copy: one request, as the `curl` or `grpcurl` that would send it.
 *
 * An aside beside the request, not a dialog over it. The command is a consequence of the request,
 * and the only way to see that it is one is to have both on screen at once: change the URL, watch
 * the words change. A modal can only ever show you the answer after you have stopped asking.
 *
 * That is also why it re-plans on the draft rather than on the file. The aside is open while the
 * request is being typed into, so "what is on disk" is a version nobody is looking at, and a panel
 * that sat there showing it would be confidently wrong rather than merely late.
 *
 * "The draft" means the tab's, not the caret's: a `Field` commits on blur and a `CodeEditor` on an
 * idle, so this tracks a url when focus leaves it and a body as typing stops. That is deliberate.
 * It makes the command exactly as current as the Save button, so what is shown is always what a
 * save would write; reading in-flight input state instead would be a second source that disagrees.
 *
 * The command is the first thing in it, and everything below the command is what the command does
 * not say. That ordering is the whole design. A shell command is a flat word list — `ui/shell.ts`
 * colours the four parts of one a reader scans for — and the two
 * things a reader most needs to know about this one are invisible in it: that the scripts which
 * would have set a header did not run, and that every `{{token}}` is now a literal — including the
 * ones that were credentials. `Not in this command` and `In cleartext` are those two facts, put
 * where they cannot be scrolled past on the way to the button.
 *
 * The clipboard is written on a press and never on open (decision 18). An aside that copied as it
 * appeared would put a bearer token on the clipboard of someone who opened it to read what the
 * request would send — and this one appears far more readily than the dialog it replaced.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { CommandPlan, RequestDraft } from "@preman/desktop/engine/protocol.js";

import { planCommand } from "@preman/desktop/renderer/actions.js";
import {
  canCopy,
  CLOSE_LABEL,
  COPIED_LABEL,
  COPY_LABEL,
  dialectTitle,
  NOT_EXPRESSED_TITLE,
  PLANNING,
  PLANNING_TITLE,
  REVEALED_TITLE,
  revealedLabel,
  revealedOrder,
  WARNINGS_TITLE,
  type Preview,
} from "@preman/desktop/renderer/model/command.js";
import { project } from "@preman/desktop/renderer/model/request.js";
import { useSessionStore } from "@preman/desktop/renderer/stores/session.js";
import type { Tab } from "@preman/desktop/renderer/stores/tabs.js";
import { CodeEditor } from "@preman/desktop/renderer/ui/CodeEditor.js";
import { IconButton } from "@preman/desktop/renderer/ui/Controls.js";
import { CheckIcon, CloseIcon, CopyIcon, WarningIcon } from "@preman/desktop/renderer/ui/icons.js";
import { TOKEN_COLOR } from "@preman/desktop/renderer/ui/template.js";

/**
 * How long a keystroke has to be the last one before the engine is asked again.
 *
 * Short enough that it reads as live and long enough that holding a key down is one round trip
 * rather than thirty. Every plan resolves a proto and walks the ancestor chain, so this is not a
 * cheap call, and the aside is open the whole time the request is being edited.
 */
const REPLAN_MS = 150;
/** The same window `CopyErrorButton` uses, so the two copy affordances in the app feel alike. */
const COPY_FEEDBACK_MS = 1500;
const SECTION_HEADING_CLASS = "flex items-center gap-2 text-2xs font-medium tracking-wide text-warn uppercase";
const SECTION_LIST_CLASS = "mt-1 flex flex-col gap-0.5 text-2xs text-ink-dim";
/**
 * The command takes the column and the notes take what is left, bounded.
 *
 * The other way round — notes sized to their content, command in the remainder — puts a request
 * with four scripts and six variables in a position to squeeze the command down to two lines,
 * which is the one thing on screen the panel exists for.
 */
const COMMAND_CLASS = "min-h-0 flex-1 select-text";
const NOTES_CLASS = "max-h-64 shrink-0 overflow-auto border-t border-line";

export interface CommandPaneProps {
  /** The tab the aside is about. It follows the active one rather than pinning to a node. */
  readonly tab: Tab;
  readonly onDismiss: () => void;
}

export function CommandPane({ tab, onDismiss }: CommandPaneProps): React.JSX.Element {
  /*
   * The selected environment, because a command has no `{{token}}` left in it: which environment
   * was chosen is the difference between a command that runs and one that points at nothing.
   */
  const environment = useSessionStore((state) => state.environment);
  const [preview, setPreview] = useState<Preview>(PLANNING);

  /*
   * The two draft shapes, picked the way `saveTab` picks them: a tab that has raw YAML edits took
   * them last, so that is the one the user is looking at. `project` returns its input untouched
   * when there are no edits, so an untouched tab hands the same object back every render and this
   * memo does not re-fire the effect below.
   */
  const draft = useMemo<RequestDraft>(
    () => (tab.text === null ? { data: project(tab.saved?.data, tab.edits) } : { text: tab.text }),
    [tab.text, tab.saved, tab.edits],
  );

  useEffect(() => {
    let live = true;
    const timer = setTimeout(() => {
      void planCommand(tab.nodeId, environment, draft).then((result) => {
        if (!live) return;
        setPreview(
          result.ok
            ? { kind: "planned", plan: result.value }
            : { kind: "rejected", message: result.failure.message, details: result.failure.details },
        );
      });
    }, REPLAN_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [tab.nodeId, environment, draft]);

  const title = preview.kind === "planned" ? dialectTitle(preview.plan.format) : PLANNING_TITLE;

  return (
    <div className="flex h-full min-h-0 flex-col border-l border-line bg-panel">
      <div className="flex h-tab shrink-0 items-center gap-2 border-b border-line px-2">
        <span className="text-2xs tracking-wide text-ink-dim uppercase">{title}</span>
        <div className="flex-1" />
        {/* Copy sits beside Close rather than in a band of its own. There is one action here and
            the panel is a column of text: a 40px footer holding a single button took a tenth of a
            narrow aside to say what a glyph next to the title says. `ConsoleDrawer` is the pattern. */}
        <CopyButton preview={preview} />
        <IconButton label={CLOSE_LABEL} onClick={onDismiss}>
          <CloseIcon />
        </IconButton>
      </div>

      {preview.kind === "rejected" ? (
        <div className="min-h-0 flex-1 overflow-auto p-gutter">
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
      ) : (
        <>
          <CodeEditor
            value={preview.kind === "planned" ? preview.plan.command : ""}
            language="shell"
            readOnly
            gutter={false}
            className={COMMAND_CLASS}
          />
          {preview.kind === "planned" && hasNotes(preview.plan) && (
            <div className={NOTES_CLASS}>
              <Planned plan={preview.plan} />
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** Whether there is anything below the command at all, so an empty bordered strip never appears. */
function hasNotes(plan: CommandPlan): boolean {
  return plan.unexpressed.length > 0 || plan.revealed.length > 0 || plan.warnings.length > 0;
}

/** The three lists: what the command left behind, what it spelled out, and what to watch for. */
function Planned({ plan }: { readonly plan: CommandPlan }): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3 p-gutter">
      {plan.unexpressed.length > 0 && (
        <div>
          <p className={SECTION_HEADING_CLASS}>
            <WarningIcon />
            {NOT_EXPRESSED_TITLE}
          </p>
          <ul className={SECTION_LIST_CLASS}>
            {plan.unexpressed.map((entry) => (
              <li key={entry.field}>
                <span className="font-mono">{entry.field}</span> — {entry.reason}
              </li>
            ))}
          </ul>
        </div>
      )}

      {plan.revealed.length > 0 && (
        <div>
          <p className={SECTION_HEADING_CLASS}>
            <WarningIcon />
            {REVEALED_TITLE}
          </p>
          <ul className={SECTION_LIST_CLASS}>
            {revealedOrder(plan.revealed).map((entry) => (
              <li key={`${entry.scope}:${entry.name}`}>
                {/* The token colour, because this is the same substitution the editor draws in
                    it: what was `{{name}}` in the file is a literal in the words above. */}
                <span className="font-mono" style={{ color: TOKEN_COLOR }}>
                  {entry.name}
                </span>{" "}
                <span className="text-ink-faint">{revealedLabel(entry)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {plan.warnings.length > 0 && (
        <div>
          <p className={SECTION_HEADING_CLASS}>
            <WarningIcon />
            {WARNINGS_TITLE}
          </p>
          <ul className={SECTION_LIST_CLASS}>
            {plan.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/**
 * The one control that touches the clipboard, and the only thing in this aside that does. A
 * timeout rather than a store flag, the same call `CopyErrorButton` makes: this is one button's
 * own transient state and nothing else in the app needs to re-render for it.
 */
function CopyButton({ preview }: { readonly preview: Preview }): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  const timeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timeout.current !== null) clearTimeout(timeout.current);
    };
  }, []);

  const command = preview.kind === "planned" ? preview.plan.command : "";

  const onClick = useCallback(() => {
    void navigator.clipboard.writeText(command);
    setCopied(true);
    if (timeout.current !== null) clearTimeout(timeout.current);
    timeout.current = setTimeout(() => {
      setCopied(false);
    }, COPY_FEEDBACK_MS);
  }, [command]);

  /*
   * The label carries the feedback, because the glyph swapping to a tick is the whole of what an
   * icon button can say and it is gone again in a second and a half. `CopyErrorButton` reads the
   * same way, and the label is what a screen reader is given either way.
   */
  return (
    <IconButton label={copied ? COPIED_LABEL : COPY_LABEL} disabled={!canCopy(preview)} onClick={onClick}>
      {copied ? <CheckIcon /> : <CopyIcon />}
    </IconButton>
  );
}
