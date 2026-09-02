/**
 * The proto manager: which schemas this workspace declares, and the links they are reached through.
 *
 * A `.proto` lives in the repository that owns the service, not in the workspace that calls it, so
 * every declared path used to be a path to *this* machine's checkout - which is why a workspace
 * shared between two people arrives full of paths to somebody's home directory. So preman declares
 * a spec through a fixed shared root and points one link per repository at the local checkout.
 * The path in `resources.yaml` then means the same thing everywhere, and setting a workspace up is
 * one directory pick per repository instead of one edit per proto.
 *
 * Two halves, and the second is the one that earns the design. The top half is repair: every link
 * the declared specs need, with the ones this machine is missing offering to be located. The
 * bottom half is the specs themselves. Adding goes through a staged plan rather than straight to
 * disk, because both things an add decides - which checkout, and what the link is called - are
 * things the user may need to overrule, and because a plan is where core can say a proto will not
 * load while there is still something to do about it.
 */
import { useCallback, useEffect, useState } from "react";

import type {
  DeclaredSpec,
  LinkOverride,
  PlannedSpec,
  SharedLink,
  SpecPlan,
  SpecsView,
} from "@preman/desktop/engine/protocol.js";

import {
  applySpecs,
  collectProtos,
  linkCheckout,
  pickCheckout,
  pickProtoFiles,
  pickProtoFolder,
  planConversion,
  planSpecs,
  readSpecs,
  removeSpec,
  type Failure,
} from "@preman/desktop/renderer/actions.js";
import {
  freeName,
  linkStates,
  MISSING_LABEL,
  planBlocked,
  plannedWrites,
  specFlags,
  takenNames,
  UNLINKED_LABEL,
  unlinkedCount,
  type LinkState,
} from "@preman/desktop/renderer/model/protos.js";
import { Banner } from "@preman/desktop/renderer/ui/Banner.js";
import { cn } from "@preman/desktop/renderer/ui/cn.js";
import { Button, IconButton } from "@preman/desktop/renderer/ui/Controls.js";
import {
  AddIcon,
  CloseIcon,
  DeleteIcon,
  FolderOpenIcon,
  LinkIcon,
  RefreshIcon,
  WarningIcon,
} from "@preman/desktop/renderer/ui/icons.js";
import { AnimatePresence } from "@preman/desktop/renderer/ui/motion.js";

const FIRST_READ = 0;
const NEXT_READ = 1;
const NOTHING = 0;

const LOADING_HINT = "Reading protos…";
const NO_SPECS_HINT = "This workspace declares no protos yet.";
const NO_PLAN_HINT = "Every proto picked is already declared.";
/** A spec whose file is not on this machine cannot be linked, so its line is left as written. */
const LEFT_ALONE = "not on this machine";
const LOCATE_LABEL = "Locate…";
const REPOINT_LABEL = "Repoint…";

/**
 * How a plan got started, which is the only thing separating an add from a conversion once the
 * plan exists. Kept so re-planning after an override reruns the same question.
 */
type PlanSource = { readonly kind: "files"; readonly files: readonly string[] } | { readonly kind: "conversion" };

interface Staged {
  readonly source: PlanSource;
  readonly plan: SpecPlan;
  readonly overrides: Record<string, LinkOverride>;
}

export function ProtosPane({ onDismiss }: { readonly onDismiss: () => void }): React.JSX.Element {
  const [view, setView] = useState<SpecsView | null>(null);
  const [staged, setStaged] = useState<Staged | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [busy, setBusy] = useState(false);
  /** Bumped by Reload. A link can be made in a terminal, so re-reading has to be offerable. */
  const [nonce, setNonce] = useState(FIRST_READ);

  useEffect(() => {
    let live = true;
    void readSpecs().then((result) => {
      if (!live) return;
      if (result.ok) {
        setView(result.value);
        setFailure(null);
        return;
      }
      setFailure(result.failure);
    });
    return () => {
      live = false;
    };
  }, [nonce]);

  /**
   * Run one action, keeping the pane honest about being busy.
   *
   * Every write here creates a symlink or rewrites a committed file, so a second click while the
   * first is in flight is not something to leave to chance.
   */
  const guard = useCallback(async <T,>(work: () => Promise<T | null>): Promise<T | null> => {
    setBusy(true);
    try {
      return await work();
    } finally {
      setBusy(false);
    }
  }, []);

  const plan = useCallback(async (source: PlanSource, overrides: Record<string, LinkOverride>): Promise<void> => {
    const result = source.kind === "files" ? await planSpecs(source.files, overrides) : await planConversion(overrides);
    if (!result.ok) {
      setFailure(result.failure);
      return;
    }
    setFailure(null);
    // Nothing to stage is an answer, not a modal with an empty table in it.
    if (result.value.entries.length === NOTHING) {
      setStaged(null);
      setFailure({ message: NO_PLAN_HINT, details: [] });
      return;
    }
    setStaged({ source, plan: result.value, overrides });
  }, []);

  const addFiles = useCallback(async (): Promise<void> => {
    const files = await pickProtoFiles();
    if (files.length === NOTHING) return;
    await guard(() => plan({ kind: "files", files }, {}));
  }, [guard, plan]);

  const addFolder = useCallback(async (): Promise<void> => {
    const dir = await pickProtoFolder();
    if (dir === null) return;
    await guard(async () => {
      const found = await collectProtos(dir);
      if (!found.ok) {
        setFailure(found.failure);
        return null;
      }
      if (found.value.length === NOTHING) {
        setFailure({ message: `No .proto files under ${dir}.`, details: [] });
        return null;
      }
      await plan({ kind: "files", files: found.value }, {});
      return null;
    });
  }, [guard, plan]);

  const convert = useCallback(async (): Promise<void> => {
    await guard(() => plan({ kind: "conversion" }, {}));
  }, [guard, plan]);

  /** Re-plan with one link decided differently. The plan is derived, so it is never patched. */
  const override = useCallback(
    async (name: string, decision: LinkOverride): Promise<void> => {
      if (staged === null) return;
      const next = { ...staged.overrides, [name]: decision };
      await guard(() => plan(staged.source, next));
    },
    [guard, plan, staged],
  );

  const apply = useCallback(async (): Promise<void> => {
    if (staged === null) return;
    await guard(async () => {
      const result = await applySpecs(staged.plan);
      if (!result.ok) {
        setFailure(result.failure);
        return null;
      }
      setView(result.value);
      setStaged(null);
      setFailure(null);
      return null;
    });
  }, [guard, staged]);

  const locate = useCallback(
    async (link: SharedLink): Promise<void> => {
      const target = await pickCheckout(link.name, view?.ownCheckout ?? null);
      if (target === null) return;
      await guard(async () => {
        // Repointing is always allowed from this button: the link is already on screen with its
        // current target beside it, so the user has seen the thing they are replacing.
        const result = await linkCheckout(link.name, target, true);
        if (!result.ok) {
          setFailure(result.failure);
          return null;
        }
        setView(result.value);
        setFailure(null);
        return null;
      });
    },
    [guard, view?.ownCheckout],
  );

  const drop = useCallback(
    async (spec: DeclaredSpec): Promise<void> => {
      await guard(async () => {
        const result = await removeSpec(spec.declared);
        if (!result.ok) {
          setFailure(result.failure);
          return null;
        }
        setView(result.value);
        setFailure(null);
        return null;
      });
    },
    [guard],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-tab shrink-0 items-center gap-2 border-b border-line px-gutter">
        <span className="text-xs font-medium text-ink">Protos</span>
        <span className="truncate font-mono text-2xs text-ink-faint" title={view?.sharedRoot}>
          {view?.sharedRoot}
        </span>
        <div className="flex-1" />
        <IconButton
          label="Reload"
          onClick={() => {
            setStaged(null);
            setNonce((current) => current + NEXT_READ);
          }}
        >
          <RefreshIcon />
        </IconButton>
        <IconButton label="Close protos" onClick={onDismiss}>
          <CloseIcon />
        </IconButton>
      </div>

      <AnimatePresence>
        {failure !== null && <Banner tone="danger" message={failure.message} details={failure.details} />}
      </AnimatePresence>

      {view === null ? (
        <Hint>{LOADING_HINT}</Hint>
      ) : staged === null ? (
        <Declared view={view} busy={busy} onLocate={locate} onRemove={drop} />
      ) : (
        <Review
          staged={staged}
          links={view.links}
          busy={busy}
          onOverride={override}
          onApply={apply}
          onCancel={() => {
            setStaged(null);
          }}
        />
      )}

      {staged === null && (
        <div className="flex shrink-0 items-center gap-2 border-t border-line px-gutter py-1.5">
          <Button
            tier="chrome"
            disabled={busy}
            onClick={() => {
              void addFiles();
            }}
          >
            Add protos…
          </Button>
          <Button
            tier="chrome"
            disabled={busy}
            onClick={() => {
              void addFolder();
            }}
          >
            Add a folder…
          </Button>
          <div className="flex-1" />
          {view !== null && unlinkedCount(view) > NOTHING && (
            <Button
              tier="chrome"
              disabled={busy}
              onClick={() => {
                void convert();
              }}
            >
              {`Move ${String(unlinkedCount(view))} onto links…`}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function Hint({ children }: { readonly children: React.ReactNode }) {
  return <p className="p-gutter text-xs text-ink-faint">{children}</p>;
}

function SectionHeading({ children }: { readonly children: React.ReactNode }) {
  return (
    <div className="sticky top-0 z-chrome flex h-row shrink-0 items-center border-b border-line bg-panel px-gutter text-2xs font-medium tracking-wide text-ink-faint uppercase">
      {children}
    </div>
  );
}

/** The declared state: links first, because a missing one is what makes the specs below it red. */
function Declared({
  view,
  busy,
  onLocate,
  onRemove,
}: {
  readonly view: SpecsView;
  readonly busy: boolean;
  readonly onLocate: (link: SharedLink) => Promise<void>;
  readonly onRemove: (spec: DeclaredSpec) => Promise<void>;
}): React.JSX.Element {
  const states = linkStates(view);

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      {states.length > NOTHING && (
        <>
          <SectionHeading>Links</SectionHeading>
          {states.map((state) => (
            <LinkRow key={state.name} state={state} busy={busy} onLocate={onLocate} />
          ))}
        </>
      )}

      <SectionHeading>{`Protos (${String(view.specs.length)})`}</SectionHeading>
      {view.specs.length === NOTHING ? (
        <Hint>{NO_SPECS_HINT}</Hint>
      ) : (
        view.specs.map((spec) => <SpecRow key={spec.declared} spec={spec} busy={busy} onRemove={onRemove} />)
      )}
    </div>
  );
}

/** One link and its wording, both worked out in `model/protos.ts` so this is only the painting. */
function LinkRow({
  state,
  busy,
  onLocate,
}: {
  readonly state: LinkState;
  readonly busy: boolean;
  readonly onLocate: (link: SharedLink) => Promise<void>;
}) {
  const { name, detail, missing } = state;
  // Nothing to repoint when the entry is not there at all - which now includes the healthy case
  // where the link is absent because the workspace's own checkout answered for it (ADR 042).
  const label = state.link.resolves ? REPOINT_LABEL : LOCATE_LABEL;

  return (
    <div className="flex h-row items-center gap-2 border-b border-line px-gutter hover:bg-hover">
      <LinkIcon className={cn("shrink-0", missing ? "text-danger" : "text-glyph")} />
      <span className="w-48 shrink-0 truncate font-mono text-xs text-ink" title={name}>
        {name}
      </span>
      <span
        className={cn("min-w-0 flex-1 truncate font-mono text-2xs", missing ? "text-danger" : "text-ink-faint")}
        title={detail}
      >
        {detail}
      </span>
      {/*
       * The two states want opposite weights. On a machine that has never linked anything this is
       * the one action that repairs every spec under the link, so it asks to be pressed. Repointing
       * a healthy link is read by every workspace naming it, so it stays quiet and is not invited.
       */}
      <Button
        variant={missing ? "primary" : "quiet"}
        disabled={busy}
        onClick={() => {
          void onLocate(state.link);
        }}
      >
        {label}
      </Button>
    </div>
  );
}

/** One declared spec, shown as it is written rather than as it resolves. The file is the truth. */
function SpecRow({
  spec,
  busy,
  onRemove,
}: {
  readonly spec: DeclaredSpec;
  readonly busy: boolean;
  readonly onRemove: (spec: DeclaredSpec) => Promise<void>;
}) {
  const { missing, unlinked } = specFlags(spec);

  return (
    <div className="group flex h-row items-center gap-2 border-b border-line px-gutter hover:bg-hover">
      <span
        className={cn("min-w-0 flex-1 truncate font-mono text-xs", missing ? "text-danger" : "text-ink")}
        title={spec.path}
      >
        {spec.declared}
      </span>
      {missing && <span className="shrink-0 text-2xs text-danger">{MISSING_LABEL}</span>}
      {unlinked && <span className="shrink-0 text-2xs text-warn">{UNLINKED_LABEL}</span>}
      <IconButton
        label={`Remove ${spec.declared}`}
        disabled={busy}
        onClick={() => {
          void onRemove(spec);
        }}
      >
        <DeleteIcon />
      </IconButton>
    </div>
  );
}

/**
 * The staged plan, which is the whole write shown before any of it happens.
 *
 * A conflict is not an error here. It is a row with two buttons, because "that name is taken" has
 * exactly two sensible answers and making the user go and rename a symlink by hand to give one of
 * them would be the tool refusing to do its job.
 */
function Review({
  staged,
  links,
  busy,
  onOverride,
  onApply,
  onCancel,
}: {
  readonly staged: Staged;
  readonly links: readonly SharedLink[];
  readonly busy: boolean;
  readonly onOverride: (name: string, decision: LinkOverride) => Promise<void>;
  readonly onApply: () => Promise<void>;
  readonly onCancel: () => void;
}): React.JSX.Element {
  const { plan } = staged;
  const blocked = planBlocked(plan);
  const taken = takenNames(links);
  const writes = plannedWrites(plan);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-auto">
        <SectionHeading>Links</SectionHeading>
        {plan.links.map((planned) => (
          <div key={planned.name} className="flex h-row items-center gap-2 border-b border-line px-gutter">
            <LinkIcon className={cn("shrink-0", planned.action === "conflict" ? "text-danger" : "text-glyph")} />
            <span className="w-48 shrink-0 truncate font-mono text-xs text-ink" title={planned.name}>
              {planned.name}
            </span>
            <span className="min-w-0 flex-1 truncate font-mono text-2xs text-ink-faint" title={planned.target}>
              {planned.target}
            </span>
            {planned.action === "conflict" ? (
              <>
                <span className="shrink-0 truncate text-2xs text-danger" title={planned.existingTarget}>
                  {`taken by ${planned.existingTarget ?? MISSING_LABEL}`}
                </span>
                <Button
                  variant="quiet"
                  disabled={busy}
                  onClick={() => {
                    void onOverride(planned.name, { name: freeName(planned.name, taken) });
                  }}
                >
                  {`Use ${freeName(planned.name, taken)}`}
                </Button>
                <Button
                  variant="quiet"
                  disabled={busy}
                  onClick={() => {
                    void onOverride(planned.name, { repoint: true });
                  }}
                >
                  Repoint
                </Button>
              </>
            ) : (
              <span className="shrink-0 text-2xs text-ink-faint">{planned.action}</span>
            )}
          </div>
        ))}

        <SectionHeading>{`Protos (${String(writes)})`}</SectionHeading>
        {plan.entries.map((entry) => (
          <PlannedRow key={entry.source} entry={entry} />
        ))}
      </div>

      <div className="flex shrink-0 items-center gap-2 border-t border-line px-gutter py-1.5">
        <span className="min-w-0 flex-1 truncate text-2xs text-ink-faint">
          {blocked
            ? `${String(plan.conflicts.length)} link name in use — decide above`
            : `Writes ${String(writes)} into resources.yaml`}
        </span>
        <Button tier="chrome" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
        <Button
          variant="primary"
          tier="chrome"
          disabled={busy || blocked}
          onClick={() => {
            void onApply();
          }}
        >
          Apply
        </Button>
      </div>
    </div>
  );
}

/**
 * One staged spec. A proto that will not load still applies - the declaration is not the thing
 * that is wrong - but it says so here, while the include dirs it would get are still the subject.
 */
function PlannedRow({ entry }: { readonly entry: PlannedSpec }) {
  return (
    <div className="flex min-h-row flex-col justify-center gap-0.5 border-b border-line px-gutter py-1">
      <div className="flex items-center gap-2">
        {entry.link === undefined ? (
          <WarningIcon className="shrink-0 text-warn" />
        ) : entry.replaces === undefined ? (
          <AddIcon className="shrink-0 text-glyph" />
        ) : (
          <FolderOpenIcon className="shrink-0 text-glyph" />
        )}
        <span
          className={cn(
            "min-w-0 flex-1 truncate font-mono text-xs",
            entry.link === undefined ? "text-ink-dim" : "text-ink",
          )}
          title={entry.source}
        >
          {entry.declared}
        </span>
        {entry.duplicate && <span className="shrink-0 text-2xs text-ink-faint">already declared</span>}
        {entry.link === undefined && <span className="shrink-0 text-2xs text-warn">{LEFT_ALONE}</span>}
      </div>
      {entry.replaces !== undefined && (
        <span className="truncate pl-6 font-mono text-2xs text-ink-faint" title={entry.replaces}>
          {`was ${entry.replaces}`}
        </span>
      )}
      {entry.loadError !== undefined && (
        <span className="truncate pl-6 text-2xs text-warn" title={entry.loadError}>
          {entry.loadError}
        </span>
      )}
    </div>
  );
}
