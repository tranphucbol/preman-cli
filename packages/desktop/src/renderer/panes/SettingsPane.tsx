/**
 * Appearance, chosen by looking at it.
 *
 * There is no OK and no Cancel. Every control here applies and persists on the same tick it is
 * touched, because the only way to judge a theme is against the app it is for, and a preview that
 * has to be confirmed is a preview the user has to remember while they decide. Escape dismisses
 * the pane; there is nothing to dismiss *from*, since nothing here is pending.
 *
 * A theme is shown as its own colours rather than as a name. "Kanagawa Dragon" tells a reader who
 * already knows it nothing they do not know, and a reader who does not know it nothing at all; the
 * nine swatches say what the next hour will look like. The six method colours are in there because
 * they are the app's most-read colour signal and the hardest part of a palette to derive well —
 * this is the row that shows a theme whose verbs came out too close together.
 *
 * Diagnostics is a tab rather than a fourth section, because it is not an appearance preference and
 * was only ever underneath one: with everything in a single column, the four strings a bug report
 * asks for sat below forty-three theme cards. It shares this pane because it has nowhere better to
 * be, not because it is the same subject, and a tab is how that is said.
 *
 * Resources is here for the same reason and one more: a Radix tab unmounts when you leave it, and
 * that unmount is the signal that stops the sampler in the main process. A dedicated overlay would
 * have cost a menu item, a palette entry, a keybinding and a line of session state to obtain the
 * same boolean. See `docs/decisions/040`.
 */
import * as Tabs from "@radix-ui/react-tabs";
import { useEffect, useState } from "react";

import { DENSITIES, densityTokens } from "@preman/desktop/renderer/appearance/density.js";
import {
  MONO_SUGGESTIONS,
  SANS_SUGGESTIONS,
  isFontAvailable,
  sanitiseFamily,
} from "@preman/desktop/renderer/appearance/fonts.js";
import type { Theme } from "@preman/desktop/renderer/appearance/theme.js";
import { THEMES } from "@preman/desktop/renderer/appearance/themes/index.js";
import { formatCpu, formatMemory, loadClass, totalOf } from "@preman/desktop/renderer/model/resources.js";
import { useAppearanceStore } from "@preman/desktop/renderer/stores/appearance.js";
import { selectHistory, selectSample, useResourcesStore } from "@preman/desktop/renderer/stores/resources.js";
import { switchWorkspace, useSessionStore } from "@preman/desktop/renderer/stores/session.js";
import { cn } from "@preman/desktop/renderer/ui/cn.js";
import { Button, Field, IconButton, Labelled } from "@preman/desktop/renderer/ui/Controls.js";
import { CloseIcon } from "@preman/desktop/renderer/ui/icons.js";
import { Sparkline } from "@preman/desktop/renderer/ui/Sparkline.js";
import { TabTrigger, useTabUnderline } from "@preman/desktop/renderer/ui/Tabs.js";
import { SHARED_PROTO_ROOT } from "@preman/desktop/engine/protocol.js";
import type { Density, DiagnosticsInfo, ProcessReading } from "@preman/desktop/preload/bridge.js";

/** The nine colours a card shows: the three surfaces you look at, then the six verbs you read. */
const SWATCHES = [
  "canvas",
  "panel",
  "accent",
  "method-get",
  "method-post",
  "method-put",
  "method-patch",
  "method-delete",
  "method-grpc",
] as const;

/**
 * Small enough to be a reading preference and large enough to be one. Below 9 the mono faces this
 * app suggests stop resolving their own hinting; above 24 a response body is four words a line.
 */
const MIN_EDITOR_FONT_PX = 9;
const MAX_EDITOR_FONT_PX = 24;
const EDITOR_FONT_STEP_PX = 1;

const MONO_LIST_ID = "settings-mono-faces";
const SANS_LIST_ID = "settings-sans-faces";

const DENSITY_LABEL: Readonly<Record<Density, string>> = {
  compact: "Compact",
  default: "Default",
  comfortable: "Comfortable",
};

const VARIANT_LABEL = { dark: "Dark", light: "Light" } as const;

const NO_FONT = null;
const EMPTY = "";

const MISSING_FONT_HINT = "Not installed on this machine — the shipped stack is being used instead.";

const SHARED_ROOT_FIELD_ID = "settings-shared-proto-root";
const SHARED_ROOT_HINT = "Where a declared proto path is resolved to a checkout on this machine.";
const SHARED_ROOT_NOTE =
  "Workspaces always record the default. Overriding it only moves where this machine looks, and re-opens the workspace.";
const NO_OVERRIDE = null;

const ESCAPE = "Escape";

const SETTINGS_TABS = ["appearance", "protos", "diagnostics", "resources"] as const;
type SettingsTab = (typeof SETTINGS_TABS)[number];

const SETTINGS_TAB_LABEL: Readonly<Record<SettingsTab, string>> = {
  appearance: "Appearance",
  protos: "Protos",
  diagnostics: "Diagnostics",
  resources: "Resources",
};

/**
 * Not remembered between openings. The pane is unmounted on dismiss, so this resets to Appearance
 * every time, which is the tab that answers the question the pane is opened for.
 */
const DEFAULT_SETTINGS_TAB: SettingsTab = "appearance";

export function SettingsPane({ onDismiss }: { readonly onDismiss: () => void }): React.JSX.Element {
  const [tab, setTab] = useState<SettingsTab>(DEFAULT_SETTINGS_TAB);
  const underline = useTabUnderline();

  /*
   * Escape leaves. Bound while this pane is mounted rather than at the window, because the runner
   * and the variable manager have work in them that a stray Escape should not throw away, and this
   * pane has nothing that is not already saved.
   *
   * `defaultPrevented` is the check that keeps a Radix layer above this one — the palette, a
   * dropdown — from closing the pane behind it as well as itself.
   */
  useEffect(() => {
    function onKeyDown(pressed: KeyboardEvent): void {
      if (pressed.key === ESCAPE && !pressed.defaultPrevented) onDismiss();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onDismiss]);

  return (
    <Tabs.Root
      value={tab}
      onValueChange={(next) => {
        setTab(next as SettingsTab);
      }}
      className="flex min-h-0 flex-1 flex-col"
    >
      {/* The title row no longer carries "Appearance and diagnostics": the two triggers below say
          the same sentence, and a subtitle that names the tabs is the sentence written twice. */}
      <div className="flex h-tab shrink-0 items-center gap-2 border-b border-line px-gutter">
        <span className="text-xs font-medium text-ink">Settings</span>
        <div className="flex-1" />
        <IconButton label="Close settings" onClick={onDismiss}>
          <CloseIcon />
        </IconButton>
      </div>

      <Tabs.List className="flex shrink-0 items-center border-b border-line px-gutter" aria-label="Settings sections">
        {SETTINGS_TABS.map((each) => (
          <TabTrigger key={each} value={each} active={each === tab} underline={underline}>
            {SETTINGS_TAB_LABEL[each]}
          </TabTrigger>
        ))}
      </Tabs.List>

      <Pane value="appearance">
        <ThemeSection />
        <DensitySection />
        <FontSection />
      </Pane>

      {/* Its own tab rather than a fourth card under Appearance: where this machine resolves the
          shared proto root is not a matter of taste, and it is the one setting here that restarts
          every engine when it moves. */}
      <Pane value="protos">
        <ProtosSection />
      </Pane>

      <Pane value="diagnostics">
        <DiagnosticsSection />
      </Pane>

      {/* Not `forceMount`, and that is the whole gate: Radix unmounts an inactive tab, the section's
          effect tears down with it, and main stops sampling. */}
      <Pane value="resources">
        <ResourcesSection />
      </Pane>
    </Tabs.Root>
  );
}

/**
 * Each tab owns its own scroller rather than sharing one below the list, so arriving at Diagnostics
 * does not inherit however far down the theme grid the last visit had scrolled.
 */
function Pane({ value, children }: { readonly value: SettingsTab; readonly children: React.ReactNode }) {
  return (
    <Tabs.Content
      value={value}
      className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-gutter focus:outline-none"
    >
      <div className="flex max-w-4xl flex-col gap-6">{children}</div>
    </Tabs.Content>
  );
}

function Section({
  title,
  hint,
  children,
}: {
  readonly title: string;
  readonly hint: string;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex flex-col gap-0.5">
        <h2 className="text-xs font-medium text-ink">{title}</h2>
        <p className="text-2xs text-ink-faint">{hint}</p>
      </div>
      {children}
    </section>
  );
}

/**
 * A card in a mutually-exclusive set, over a native radio.
 *
 * The radio is the control and the card is its label, rather than a `<button aria-pressed>` per
 * option: a set where exactly one is on is a radio group, and going native buys arrow-key
 * navigation, the roving tab stop and the announcement "3 of 43" without any of it being written
 * here. The input is `sr-only` rather than hidden, because a hidden input cannot be focused.
 */
function Choice({
  group,
  value,
  checked,
  onChoose,
  children,
}: {
  readonly group: string;
  readonly value: string;
  readonly checked: boolean;
  readonly onChoose: () => void;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return (
    <label
      className={cn(
        "flex cursor-default flex-col gap-2 rounded-md border p-2 select-none has-[:focus-visible]:ring-1 has-[:focus-visible]:ring-accent",
        checked ? "border-accent bg-selected" : "border-line-strong bg-control hover:bg-hover",
      )}
    >
      <input type="radio" name={group} value={value} checked={checked} onChange={onChoose} className="sr-only" />
      {children}
    </label>
  );
}

const THEME_GROUP = "preman-theme";
const DENSITY_GROUP = "preman-density";

function ThemeSection(): React.JSX.Element {
  const current = useAppearanceStore((state) => state.preferences.themeId);
  const setTheme = useAppearanceStore((state) => state.setTheme);

  return (
    <Section title="Theme" hint="Every palette here is contrast-audited. None of them follow the system.">
      <div role="radiogroup" aria-label="Theme" className="grid grid-cols-[repeat(auto-fill,minmax(13rem,1fr))] gap-2">
        {THEMES.map((theme) => (
          <Choice
            key={theme.id}
            group={THEME_GROUP}
            value={theme.id}
            checked={theme.id === current}
            onChoose={() => {
              setTheme(theme.id);
            }}
          >
            <ThemeCard theme={theme} />
          </Choice>
        ))}
      </div>
    </Section>
  );
}

function ThemeCard({ theme }: { readonly theme: Theme }): React.JSX.Element {
  return (
    <>
      <span className="flex min-w-0 items-baseline gap-1.5">
        <span className="truncate text-xs text-ink">{theme.name}</span>
        <span className="shrink-0 text-2xs text-ink-faint">{VARIANT_LABEL[theme.variant]}</span>
      </span>
      {/* The swatches carry the whole message, so they are marked decorative rather than read out
          one hex value at a time; the accessible name of the card is its theme's name. */}
      <span aria-hidden className="flex gap-0.5 overflow-hidden rounded-xs">
        {SWATCHES.map((token) => (
          <span key={token} className="h-4 flex-1" style={{ backgroundColor: theme.colors[token] }} />
        ))}
      </span>
    </>
  );
}

function DensitySection(): React.JSX.Element {
  const current = useAppearanceStore((state) => state.preferences.density);
  const setDensity = useAppearanceStore((state) => state.setDensity);

  return (
    <Section title="Density" hint="How tall a row, a control and a toolbar are, and the type that fits in them.">
      <div role="radiogroup" aria-label="Density" className="grid grid-cols-3 gap-2">
        {DENSITIES.map((density) => (
          <Choice
            key={density}
            group={DENSITY_GROUP}
            value={density}
            checked={density === current}
            onChoose={() => {
              setDensity(density);
            }}
          >
            <span className="text-xs text-ink">{DENSITY_LABEL[density]}</span>
            <span className="font-mono text-2xs text-ink-faint">{densityTokens(density).row}px row</span>
          </Choice>
        ))}
      </div>
    </Section>
  );
}

function FontSection(): React.JSX.Element {
  const fontMono = useAppearanceStore((state) => state.preferences.fontMono);
  const fontSans = useAppearanceStore((state) => state.preferences.fontSans);
  const editorFontSize = useAppearanceStore((state) => state.preferences.editorFontSize);
  const setFontMono = useAppearanceStore((state) => state.setFontMono);
  const setFontSans = useAppearanceStore((state) => state.setFontSans);
  const setEditorFontSize = useAppearanceStore((state) => state.setEditorFontSize);

  return (
    <Section
      title="Type"
      hint="A family named here goes in front of the stack the app ships with, so a missing one still resolves."
    >
      <div className="grid grid-cols-[repeat(auto-fit,minmax(15rem,1fr))] gap-4">
        <FontField
          id="settings-font-mono"
          label="Monospace"
          listId={MONO_LIST_ID}
          suggestions={MONO_SUGGESTIONS}
          family={fontMono}
          onCommit={setFontMono}
        />
        <FontField
          id="settings-font-sans"
          label="Interface"
          listId={SANS_LIST_ID}
          suggestions={SANS_SUGGESTIONS}
          family={fontSans}
          onCommit={setFontSans}
        />
        <Labelled
          label="Editor size"
          htmlFor="settings-editor-size"
          hint="The document only; the find bar follows the density."
        >
          <Field
            id="settings-editor-size"
            type="number"
            min={MIN_EDITOR_FONT_PX}
            max={MAX_EDITOR_FONT_PX}
            step={EDITOR_FONT_STEP_PX}
            value={editorFontSize}
            onChange={(event) => {
              const next = event.target.valueAsNumber;
              if (Number.isNaN(next)) return;
              setEditorFontSize(Math.min(Math.max(next, MIN_EDITOR_FONT_PX), MAX_EDITOR_FONT_PX));
            }}
          />
        </Labelled>
      </div>
    </Section>
  );
}

/** What the Engine row says when nothing is open, which is a state and not an absence of one. */
const NO_WORKSPACE = "No workspace open";
const ENGINE_RUNNING = "Running";
const ENGINE_STOPPED = "Stopped";
/** Before the one `invoke` settles. It is a local round trip, so this is a frame, not a wait. */
const UNKNOWN_VALUE = "…";

/**
 * Where this machine resolves a shared proto link.
 *
 * The one control in this pane that is not about appearance, and the one that breaks the pane's
 * own no-Cancel rule in spirit: it commits on blur rather than per keystroke, because a half-typed
 * path is a path to nowhere and every workspace would re-open against it.
 *
 * The asymmetry is the point, and the hint says it: `SHARED_PROTO_ROOT` is what gets written into
 * `resources.yaml` on every machine, and this only says where *this* one looks. Nobody should need
 * it. It exists for a machine whose `/Users/Shared` is not writable, which is a real thing on a
 * managed laptop and an unfixable one from inside the app.
 *
 * Saving it closes every engine, because a host reads the root from its environment at fork and
 * cannot be told about a new one. The workspace is re-opened here rather than left to the user,
 * since the alternative is a window whose sidebar is correct and whose engine is gone.
 */
function ProtosSection(): React.JSX.Element {
  const shared = useAppearanceStore((state) => state.preferences.sharedProtoRoot);
  const preferences = useAppearanceStore((state) => state.preferences);
  const setPreferences = useAppearanceStore((state) => state.setPreferences);
  const root = useSessionStore((state) => state.root);
  const [draft, setDraft] = useState(shared ?? EMPTY);

  function commit(next: string | null): void {
    if (next === shared) return;
    setPreferences({ ...preferences, sharedProtoRoot: next });
    if (root !== null) void switchWorkspace(root);
  }

  return (
    <Section title="Protos" hint={SHARED_ROOT_HINT}>
      <Labelled label="Shared proto root" htmlFor={SHARED_ROOT_FIELD_ID} hint={SHARED_ROOT_NOTE}>
        <div className="flex items-center gap-2">
          <input
            id={SHARED_ROOT_FIELD_ID}
            spellCheck={false}
            placeholder={SHARED_PROTO_ROOT}
            value={draft}
            className="h-control-lg w-full min-w-0 rounded-sm border border-line-strong bg-control px-2 font-mono text-2xs text-ink placeholder:text-ink-faint"
            onChange={(changed) => {
              setDraft(changed.target.value);
            }}
            onBlur={() => {
              const clean = draft.trim();
              commit(clean === EMPTY ? NO_OVERRIDE : clean);
            }}
          />
          <Button
            variant="neutral"
            disabled={shared === NO_OVERRIDE}
            onClick={() => {
              setDraft(EMPTY);
              commit(NO_OVERRIDE);
            }}
          >
            Use the default
          </Button>
        </div>
      </Labelled>
    </Section>
  );
}

/**
 * The four versions a bug report needs, and where to find the log.
 *
 * Not a line of the log is rendered. A pane that showed it would have to decide what to redact, and
 * `docs/decisions/035` decided that by not writing it — the console drawer is where a request is
 * looked at. The button reveals the *directory* rather than the file: the rotated `preman.log.1` is
 * half of what a report wants, and a file manager showing the folder gives both.
 */
function DiagnosticsSection(): React.JSX.Element {
  const [info, setInfo] = useState<DiagnosticsInfo | null>(null);
  const root = useSessionStore((state) => state.root);
  const failed = useSessionStore((state) => state.hostFailure !== null);

  // Once, on mount: none of it changes while the app runs, and re-reading it would only be a way
  // for the pane to disagree with itself. A failed read leaves the placeholders, which is honest.
  useEffect(() => {
    let live = true;
    void window.preman
      .diagnostics()
      .then((read) => {
        if (live) setInfo(read);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  return (
    <Section title="Diagnostics" hint="What a bug report needs, and where the app writes things down.">
      <dl className="flex flex-col gap-2">
        <DiagnosticsRow term="Versions">
          <span className="text-2xs text-ink-dim">
            preman {info?.appVersion ?? UNKNOWN_VALUE} · Electron {info?.electronVersion ?? UNKNOWN_VALUE} · Chromium{" "}
            {info?.chromeVersion ?? UNKNOWN_VALUE} · Node {info?.nodeVersion ?? UNKNOWN_VALUE}
          </span>
        </DiagnosticsRow>
        <DiagnosticsRow term="Engine">
          <span className="truncate font-mono text-2xs text-ink-dim">{root ?? NO_WORKSPACE}</span>
          <span className={cn("text-2xs", failed ? "text-danger" : "text-ink-faint")}>
            {failed ? ENGINE_STOPPED : ENGINE_RUNNING}
          </span>
        </DiagnosticsRow>
        <DiagnosticsRow term="Log">
          <span className="truncate font-mono text-2xs text-ink-dim">{info?.logFile ?? UNKNOWN_VALUE}</span>
          <Button
            variant="neutral"
            disabled={info === null}
            onClick={() => {
              if (info !== null) void window.preman.revealInFileManager(info.directory);
            }}
          >
            Reveal
          </Button>
        </DiagnosticsRow>
      </dl>
    </Section>
  );
}

function DiagnosticsRow({
  term,
  children,
}: {
  readonly term: string;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <dt className="w-24 shrink-0 text-2xs text-ink-faint">{term}</dt>
      <dd className="flex min-w-0 flex-1 items-center gap-2">{children}</dd>
    </div>
  );
}

/** One second of nothing, because the first reading is discarded to make the second one honest. */
const FIRST_READING = "Taking the first reading…";

/**
 * The sentence without which this pane generates bug reports.
 *
 * `docs/performance.md` has the long version: the total is roughly 372MB on a machine whose private
 * footprint is nearer 250MB, because Chromium's working set counts the shared framework once in
 * every process that maps it. Saying so is the alternative to subtracting an estimate nobody can
 * audit — see `docs/decisions/040`.
 */
const MEMORY_CAVEAT =
  "Working set, as Chromium reports it: the shared framework is counted once in every process that maps it, so the total is larger than the memory the app holds. Activity Monitor adds it up the same way. CPU is a percentage of one core, as Activity Monitor also reports it, so a process using two cores reads 200% and the total is a sum across processes.";

/**
 * The colour, in words.
 *
 * `model/resources.ts` bands CPU green through red by magnitude, which is htop's reading of the
 * same number and not a claim that anything is wrong. Saying so is not optional: a red row that
 * means "busy" and is read as "broken" is a bug report, and a legend is the cheapest possible fix.
 * The total keeps the plain ink tier because it is a sum across processes — five quiet rows add up
 * to a figure that no per-core band describes.
 */
const LOAD_LEGEND =
  "The line and the CPU figure are green, amber or red by size, not by health: amber is a quarter of a core, red is most of one, and a run looks like red.";

const NUMBER_CELL_CLASS = "text-right font-mono text-2xs tabular-nums text-ink-faint";
const HEAD_CELL_CLASS = "text-2xs font-normal text-ink-faint";
const TOTAL_LABEL = "Total";
/** A sum of two peaks taken at two different moments is not a peak. `model/resources.ts` says why. */
const NO_TOTAL = "—";
const NO_SERIES: readonly number[] = [];

/**
 * What the app costs, while somebody is looking.
 *
 * The effect is the gate. Its dependencies are the store's own action identities, which are created
 * once, so this runs on mount and tears down on unmount and never in between — and the unmount is
 * whichever comes first of leaving the tab and dismissing the pane. Between those two moments the
 * main process holds a one-second interval; outside them it holds no timer at all.
 */
function ResourcesSection(): React.JSX.Element {
  const sample = useResourcesStore(selectSample);
  const history = useResourcesStore(selectHistory);
  const apply = useResourcesStore((state) => state.apply);
  const forget = useResourcesStore((state) => state.forget);

  useEffect(() => {
    const unsubscribe = window.preman.onResourceSample(apply);
    window.preman.watchResources(true);
    return () => {
      window.preman.watchResources(false);
      unsubscribe();
      // Forgotten rather than left for the next open. A minute-old line drawn as though it were
      // current is worse than an empty one, and there is no honest way to draw the gap.
      forget();
    };
  }, [apply, forget]);

  if (sample === null) {
    return (
      <Section title="Resources" hint="Sampled once a second, and only while this tab is open.">
        <p className="text-2xs text-ink-faint">{FIRST_READING}</p>
      </Section>
    );
  }

  const total = totalOf(sample.processes);

  return (
    <Section title="Resources" hint="Sampled once a second, and only while this tab is open.">
      <table className="w-full table-fixed">
        <thead>
          <tr className="h-row border-b border-line">
            <th className={cn(HEAD_CELL_CLASS, "text-left")}>Process</th>
            <th className={cn(HEAD_CELL_CLASS, "w-24 text-left")}>Last minute</th>
            <th className={cn(HEAD_CELL_CLASS, "w-20 text-right")}>CPU</th>
            <th className={cn(HEAD_CELL_CLASS, "w-24 text-right")}>Memory</th>
            <th className={cn(HEAD_CELL_CLASS, "w-24 text-right")}>Peak</th>
          </tr>
        </thead>
        <tbody>
          {sample.processes.map((process) => (
            <ResourceRow key={process.pid} reading={process} series={history.get(process.pid) ?? NO_SERIES} />
          ))}
        </tbody>
        <tfoot>
          <tr className="h-row border-t border-line">
            <th scope="row" className="text-left text-xs font-medium text-ink">
              {TOTAL_LABEL}
            </th>
            <td />
            <td className={cn(NUMBER_CELL_CLASS, "text-ink")}>{formatCpu(total.cpuPercent)}</td>
            <td className={cn(NUMBER_CELL_CLASS, "text-ink")}>{formatMemory(total.memoryKb)}</td>
            <td className={NUMBER_CELL_CLASS}>{NO_TOTAL}</td>
          </tr>
        </tfoot>
      </table>
      <p className="text-2xs text-ink-faint">{LOAD_LEGEND}</p>
      <p className="text-2xs text-ink-faint">{MEMORY_CAVEAT}</p>
    </Section>
  );
}

function ResourceRow({
  reading,
  series,
}: {
  readonly reading: ProcessReading;
  readonly series: readonly number[];
}): React.JSX.Element {
  // One band, read once, worn by the line and by the number it traces. Two calls would be two
  // chances for the wash and the figure beside it to disagree about which band the row is in.
  const tone = loadClass(reading.cpuPercent);
  return (
    <tr className="h-row">
      <th scope="row" className="truncate text-left text-xs font-normal text-ink">
        {reading.label}
      </th>
      {/* The cell keeps its width whether or not there is a line in it, so the columns to the right
          do not move when the first sample lands. */}
      <td>
        <div className="h-4 w-20">
          <Sparkline series={series} className={tone} />
        </div>
      </td>
      <td className={cn(NUMBER_CELL_CLASS, tone)}>{formatCpu(reading.cpuPercent)}</td>
      {/* Memory stays quiet. It has no ceiling to band against — a process is not at 60% of a
          working set — and colouring a column that cannot mean anything by it is how the columns
          that do mean something stop being read. */}
      <td className={NUMBER_CELL_CLASS}>{formatMemory(reading.memoryKb)}</td>
      <td className={NUMBER_CELL_CLASS}>{formatMemory(reading.peakMemoryKb)}</td>
    </tr>
  );
}

/**
 * Uncontrolled while being typed, committed on blur.
 *
 * A family is not a valid preference until it is finished — committing per keystroke would apply
 * "J", "Je", "Jet" and repaint the app three times on the way to "JetBrains Mono". The warning
 * under it is live, though, because a typo is exactly what it exists to catch.
 */
function FontField({
  id,
  label,
  listId,
  suggestions,
  family,
  onCommit,
}: {
  readonly id: string;
  readonly label: string;
  readonly listId: string;
  readonly suggestions: readonly string[];
  readonly family: string | null;
  readonly onCommit: (family: string | null) => void;
}): React.JSX.Element {
  const [draft, setDraft] = useState(family ?? EMPTY);
  const clean = sanitiseFamily(draft);
  const missing = clean !== EMPTY && !isFontAvailable(clean);

  return (
    <Labelled label={label} htmlFor={id} hint={missing ? MISSING_FONT_HINT : undefined}>
      <input
        id={id}
        list={listId}
        spellCheck={false}
        placeholder="The shipped stack"
        value={draft}
        className={cn(
          "h-control-lg w-full min-w-0 rounded-sm border bg-control px-2 text-xs text-ink placeholder:text-ink-faint",
          missing ? "border-warn" : "border-line-strong",
        )}
        onChange={(changed) => {
          setDraft(changed.target.value);
        }}
        onBlur={() => {
          onCommit(clean === EMPTY ? NO_FONT : clean);
        }}
      />
      <datalist id={listId}>
        {suggestions.map((suggestion) => (
          <option key={suggestion} value={suggestion} />
        ))}
      </datalist>
    </Labelled>
  );
}
