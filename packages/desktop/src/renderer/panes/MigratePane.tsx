/**
 * Migrating a Postman cloud workspace: pick one, say where it goes, read what came across.
 *
 * A pane rather than a fourth `Ask` arm in `ui/Dialog.tsx`. The list needs a row per cloud
 * workspace, and the report needs a per-kind count and a list of what could not be carried;
 * neither the `name`, `confirm` nor `create` arm can hold either, and a fourth product-specific
 * variant in a generic module is the signal that module already names.
 *
 * It is not in `stores/overlay.ts` with the other three panes either, and that is load-bearing:
 * every overlay is dismissed when an engine port arrives, and the port for the workspace this pane
 * just wrote arrives while its own report is still the thing the user is reading. Held as window
 * state, it survives the switch it caused.
 *
 * While a migration is in flight nothing here dismisses or re-submits. It issues hundreds of
 * requests against someone's Postman account, so a second one started by an impatient click is
 * both slow and, at the destination, a directory that is no longer empty.
 */
import * as Primitive from "@radix-ui/react-dialog";
import { useCallback, useEffect, useState } from "react";

import type { CloudWorkspace, MigrateOutcome, MigrationProgress } from "@preman/desktop/preload/bridge.js";
import { phaseMessage, progressDetail } from "@preman/desktop/renderer/model/migration.js";
import { migrateFromPostman } from "@preman/desktop/renderer/stores/session.js";
import { Button } from "@preman/desktop/renderer/ui/Controls.js";
import { CheckIcon, WarningIcon } from "@preman/desktop/renderer/ui/icons.js";
import { cn } from "@preman/desktop/renderer/ui/cn.js";
import { Progress } from "@preman/desktop/renderer/ui/Progress.js";

const OVERLAY_CLASS = "scrim-enter fixed inset-0 z-menu bg-black/50";
/**
 * Wider than `AskDialog`'s `w-96`, and the `-translate-*` pair is restated inside `.modal-enter`'s
 * `@starting-style` there for a reason this shares: a list of workspace names is a line of text
 * each, and a question about a name is not.
 */
const CONTENT_CLASS =
  "modal-enter fixed left-1/2 top-1/4 z-menu w-[32rem] max-w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-line-strong bg-panel p-4 shadow-2xl shadow-black/60";

/** The vertical list tier from `docs/design-system.md`: the row height is the token, not a number. */
const ROW_CLASS =
  "flex h-row cursor-default items-center gap-2 rounded-sm px-2 text-xs text-ink select-none has-[:focus-visible]:ring-1 has-[:focus-visible]:ring-accent";

/** One radio group on screen at a time, so the name is a constant rather than a generated id. */
const WORKSPACE_GROUP = "migrate-workspace";

const TITLE = "Migrate from Postman";
const LISTING = "Asking Postman Desktop what it can see…";
const WORKING = "Migrating. This can take a minute on a large workspace.";

const NOTHING_TO_MIGRATE = "This Postman account has no cloud workspaces.";
/** Said before the first request, because the whole feature depends on it and nothing else says so. */
const PREREQUISITE = "Postman Desktop has to be running and signed in.";
const SKIPPED_TITLE = "Not migrated";

/**
 * The plural of every kind a plan counts, in the order the report reads them out: what contains
 * things first, then the things themselves. An unknown kind falls back to its own name rather than
 * being dropped — a count the report cannot label is still a count the user should see.
 */
const KIND_LABELS: Readonly<Record<string, readonly [string, string]>> = {
  collection: ["collection", "collections"],
  folder: ["folder", "folders"],
  environment: ["environment", "environments"],
  "grpc-request": ["gRPC request", "gRPC requests"],
  "http-request": ["HTTP request", "HTTP requests"],
};
const KIND_ORDER = ["collection", "folder", "environment", "grpc-request", "http-request"] as const;
const SINGULAR = 1;
const NOTHING = 0;

/**
 * Where the pane is in the one sequence it runs. A union rather than four booleans: `loading` and
 * `failed` at once is not a state this pane has, and a union is how that stays true.
 */
type Stage =
  | { readonly kind: "listing" }
  | { readonly kind: "choosing"; readonly workspaces: readonly CloudWorkspace[] }
  /**
   * Carries the list it was started from, so a dismissed destination dialog goes back to the
   * choice rather than to a second round trip for a list that has not changed in ten seconds.
   *
   * `progress` is `undefined` until the first report, which is the truth for as long as the native
   * destination dialog is still open and nothing has started.
   */
  | {
      readonly kind: "working";
      readonly workspaces: readonly CloudWorkspace[];
      readonly progress: MigrationProgress | undefined;
    }
  | { readonly kind: "done"; readonly outcome: MigrateOutcome }
  | { readonly kind: "failed"; readonly message: string; readonly details: readonly string[] };

const LISTING_STAGE: Stage = { kind: "listing" };

function label(kind: string, count: number): string {
  const pair = KIND_LABELS[kind];
  if (pair === undefined) return `${String(count)} ${kind}`;
  return `${String(count)} ${count === SINGULAR ? pair[0] : pair[1]}`;
}

/** Kinds the plan counted, in `KIND_ORDER`, then anything the plan knew about and this file did not. */
function countLines(counts: Readonly<Record<string, number>>): string[] {
  const known = KIND_ORDER.filter((kind) => (counts[kind] ?? NOTHING) > NOTHING);
  const rest = Object.keys(counts).filter(
    (kind) => !KIND_ORDER.includes(kind as (typeof KIND_ORDER)[number]) && (counts[kind] ?? NOTHING) > NOTHING,
  );
  return [...known, ...rest].map((kind) => label(kind, counts[kind] ?? NOTHING));
}

export interface MigratePaneProps {
  readonly open: boolean;
  readonly onDismiss: () => void;
}

export function MigratePane({ open, onDismiss }: MigratePaneProps): React.JSX.Element {
  /*
   * Held here rather than in the flow below, because it is the dismissal that has to respect it and
   * dismissal is the `Root`'s — the same split `AskDialog` makes, and for the same reason. Escape,
   * an outside click and Cancel all arrive at `onOpenChange`.
   */
  const [working, setWorking] = useState(false);

  const dismiss = useCallback(() => {
    setWorking(false);
    onDismiss();
  }, [onDismiss]);

  return (
    <Primitive.Root
      open={open}
      onOpenChange={(next) => {
        if (!next && !working) dismiss();
      }}
    >
      <Primitive.Portal>
        <Primitive.Overlay className={OVERLAY_CLASS} />
        <Primitive.Content className={CONTENT_CLASS} aria-describedby={undefined}>
          <Primitive.Title className="mb-3 text-sm font-medium text-ink">{TITLE}</Primitive.Title>
          {/* Mounted only while open, which is what makes the stage below start at `listing`
              without an effect setting it: a reopen is a fresh mount, and the list is asked for
              again. An account gains and loses workspaces between two migrations, and a cached
              list is a list with the wanted workspace missing from it. */}
          <MigrateFlow onWorking={setWorking} onDismiss={dismiss} />
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  );
}

function MigrateFlow({
  onWorking,
  onDismiss,
}: {
  readonly onWorking: (working: boolean) => void;
  readonly onDismiss: () => void;
}): React.JSX.Element {
  const [stage, setStage] = useState<Stage>(LISTING_STAGE);

  useEffect(() => {
    let live = true;
    void window.preman.listPostmanWorkspaces().then(
      (result) => {
        if (!live) return;
        setStage(
          result.status === "listed"
            ? { kind: "choosing", workspaces: result.workspaces }
            : { kind: "failed", message: result.message, details: result.details },
        );
      },
      (cause: unknown) => {
        if (!live) return;
        setStage({ kind: "failed", message: reason(cause), details: [] });
      },
    );
    return () => {
      live = false;
    };
  }, []);

  /*
   * Subscribed for the flow's whole life rather than only while working, because the alternative is
   * re-subscribing on a state the reports themselves change. A report that arrives outside the
   * working stage is dropped: the migration that sent it is the one whose report the user is
   * already reading, or whose failure they are.
   */
  useEffect(
    () =>
      window.preman.onMigrateProgress((progress) => {
        setStage((current) => (current.kind === "working" ? { ...current, progress } : current));
      }),
    [],
  );

  const migrate = useCallback(
    (workspaceId: string) => {
      setStage((current) =>
        current.kind === "choosing"
          ? { kind: "working", workspaces: current.workspaces, progress: undefined }
          : current,
      );
      onWorking(true);
      void migrateFromPostman(workspaceId).then(
        (result) => {
          onWorking(false);
          if (result.status === "migrated") setStage({ kind: "done", outcome: result.outcome });
          // A dismissed destination dialog is not a failure and not a migration: the pane goes back
          // to the choice it came from, with nothing said about it.
          else if (result.status === "cancelled")
            setStage((current) =>
              current.kind === "working" ? { kind: "choosing", workspaces: current.workspaces } : current,
            );
          else setStage({ kind: "failed", message: result.message, details: result.details });
        },
        (cause: unknown) => {
          onWorking(false);
          setStage({ kind: "failed", message: reason(cause), details: [] });
        },
      );
    },
    [onWorking],
  );

  return <Body stage={stage} onMigrate={migrate} onDismiss={onDismiss} />;
}

/** Never swallow the cause: a rejected invoke still knows something the user does not. */
function reason(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function Body({
  stage,
  onMigrate,
  onDismiss,
}: {
  readonly stage: Stage;
  readonly onMigrate: (workspaceId: string) => void;
  readonly onDismiss: () => void;
}): React.JSX.Element {
  if (stage.kind === "listing") return <Waiting message={LISTING} />;
  if (stage.kind === "working") return <Waiting message={WORKING} progress={stage.progress} />;
  if (stage.kind === "failed") return <Failed stage={stage} onDismiss={onDismiss} />;
  if (stage.kind === "done") return <Report outcome={stage.outcome} onDismiss={onDismiss} />;
  return <Choice workspaces={stage.workspaces} onMigrate={onMigrate} onDismiss={onDismiss} />;
}

/**
 * A wait, with a bar under it.
 *
 * `aria-live` on the sentence, because neither wait moves the focus and a screen reader would
 * otherwise report nothing at all in reply to a click that starts a minute of work. It says the
 * phase, so it speaks about six times over a whole migration — the counts underneath are
 * `aria-hidden` and left to the `progressbar`, because a live region reading out a number that
 * changes a hundred times is not a report, it is a barrage.
 */
function Waiting({
  message,
  progress,
}: {
  readonly message: string;
  readonly progress?: MigrationProgress;
}): React.JSX.Element {
  const said = progress === undefined ? message : phaseMessage(progress.phase, message);

  return (
    <div>
      <p className="text-xs leading-relaxed text-ink-dim" aria-live="polite">
        {said}
      </p>
      <Progress done={progress?.done ?? NOTHING} total={progress?.total} label={said} className="mt-3" />
      {progress !== undefined && (
        <p className="mt-1.5 text-2xs text-ink-faint tabular-nums" aria-hidden="true">
          {progressDetail(progress)}
        </p>
      )}
    </div>
  );
}

function Choice({
  workspaces,
  onMigrate,
  onDismiss,
}: {
  readonly workspaces: readonly CloudWorkspace[];
  readonly onMigrate: (workspaceId: string) => void;
  readonly onDismiss: () => void;
}): React.JSX.Element {
  const first = workspaces[0];
  const [chosen, setChosen] = useState(first?.id ?? "");

  if (first === undefined) {
    return (
      <>
        <p className="text-xs leading-relaxed text-ink-dim">{NOTHING_TO_MIGRATE}</p>
        <div className="mt-4 flex justify-end">
          <Button onClick={onDismiss}>Close</Button>
        </div>
      </>
    );
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onMigrate(chosen);
      }}
    >
      <p className="mb-3 text-xs leading-relaxed text-ink-dim">{PREREQUISITE}</p>
      {/*
        Native radios inside labels, the same mechanism `Dialog`'s `CreateForm` and `SettingsPane`'s
        `Choice` use, and for the same reason: arrow-key navigation, the roving tab stop and "3 of
        12" all arrive without being written here.
      */}
      <div role="radiogroup" aria-label="Workspace" className="flex max-h-64 flex-col gap-px overflow-y-auto">
        {workspaces.map((workspace) => {
          const checked = workspace.id === chosen;
          return (
            <label key={workspace.id} className={cn(ROW_CLASS, checked ? "bg-selected" : "hover:bg-hover")}>
              <input
                type="radio"
                name={WORKSPACE_GROUP}
                value={workspace.id}
                checked={checked}
                onChange={() => setChosen(workspace.id)}
                className="sr-only"
              />
              <span className="truncate">{workspace.name}</span>
              {/* Postman's own word for who owns it, which is the only thing distinguishing two
                  workspaces that share a name — and two of those is exactly why this is a list. */}
              {workspace.type !== undefined && <span className="text-2xs text-ink-faint">{workspace.type}</span>}
              {checked && <CheckIcon className="ml-auto text-accent" />}
            </label>
          );
        })}
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Button onClick={onDismiss}>Cancel</Button>
        <Button type="submit" variant="primary">
          Choose destination…
        </Button>
      </div>
    </form>
  );
}

function Failed({
  stage,
  onDismiss,
}: {
  readonly stage: Extract<Stage, { kind: "failed" }>;
  readonly onDismiss: () => void;
}): React.JSX.Element {
  return (
    <>
      <p className="flex items-start gap-2 text-xs leading-relaxed text-danger" aria-live="polite">
        <WarningIcon className="mt-0.5 shrink-0" />
        <span>{stage.message}</span>
      </p>
      {stage.details.length > NOTHING && (
        <ul className="mt-2 flex flex-col gap-0.5 text-2xs text-ink-dim">
          {stage.details.map((detail) => (
            <li key={detail} className="whitespace-pre-wrap">
              {detail}
            </li>
          ))}
        </ul>
      )}
      <div className="mt-4 flex justify-end">
        <Button onClick={onDismiss}>Close</Button>
      </div>
    </>
  );
}

/**
 * What came across, and what did not.
 *
 * The skipped list is not a footnote. A websocket request that Postman had and this workspace does
 * not is the one thing a migration can lose silently, so it is named here, in full, at the moment
 * the user is deciding whether to trust the result.
 */
function Report({
  outcome,
  onDismiss,
}: {
  readonly outcome: MigrateOutcome;
  readonly onDismiss: () => void;
}): React.JSX.Element {
  return (
    <>
      <p className="text-xs leading-relaxed text-ink">
        Migrated <span className="font-medium">{outcome.workspaceName}</span> into{" "}
        <span className="font-mono text-ink-dim">{outcome.root}</span>
      </p>
      <ul className="mt-2 flex flex-col gap-0.5 text-2xs text-ink-dim">
        {countLines(outcome.counts).map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      {outcome.skipped.length > NOTHING && (
        <div className="mt-3">
          <p className="flex items-center gap-2 text-2xs font-medium tracking-wide text-warn uppercase">
            <WarningIcon />
            {SKIPPED_TITLE}
          </p>
          <ul className="mt-1 flex flex-col gap-0.5 text-2xs text-ink-dim">
            {outcome.skipped.map((item) => (
              <li key={`${item.path}:${item.kind}`}>
                <span className="font-mono">{item.path}</span> — {item.kind}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="mt-4 flex justify-end">
        <Button variant="primary" onClick={onDismiss}>
          Done
        </Button>
      </div>
    </>
  );
}
