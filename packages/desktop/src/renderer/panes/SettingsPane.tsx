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
import { useEffect, useMemo, useRef, useState } from "react";

import { DENSITIES, densityTokens } from "@preman/desktop/renderer/appearance/density.js";
import {
  MONO_SUGGESTIONS,
  SANS_SUGGESTIONS,
  isFontAvailable,
  sanitiseFamily,
} from "@preman/desktop/renderer/appearance/fonts.js";
import type { Theme } from "@preman/desktop/renderer/appearance/theme.js";
import { THEMES } from "@preman/desktop/renderer/appearance/themes/index.js";
import {
  formatLogTime,
  levelClass,
  LOG_HEIGHT_MIN,
  matchingLines,
  splitMatches,
  stepMatch,
  NO_MATCH,
  NO_QUERY,
} from "@preman/desktop/renderer/model/log.js";
import { formatCpu, formatMemory, loadClass, totalOf } from "@preman/desktop/renderer/model/resources.js";
import { LOCAL_NETWORK_CAVEAT, updateHeadline } from "@preman/desktop/renderer/model/update.js";
import { useAppearanceStore } from "@preman/desktop/renderer/stores/appearance.js";
import { selectHeight, selectLines, selectWatching, useLogStore } from "@preman/desktop/renderer/stores/log.js";
import { selectHistory, selectSample, useResourcesStore } from "@preman/desktop/renderer/stores/resources.js";
import { switchWorkspace, useSessionStore } from "@preman/desktop/renderer/stores/session.js";
import { selectStatus, useUpdateStore } from "@preman/desktop/renderer/stores/update.js";
import { cn } from "@preman/desktop/renderer/ui/cn.js";
import { Button, Field, IconButton, Labelled } from "@preman/desktop/renderer/ui/Controls.js";
import {
  ClearIcon,
  CloseIcon,
  GLYPH_CLASS,
  NextMatchIcon,
  RefreshIcon,
  PreviousMatchIcon,
  RevealIcon,
  SearchIcon,
  StreamIcon,
} from "@preman/desktop/renderer/ui/icons.js";
import { Sparkline } from "@preman/desktop/renderer/ui/Sparkline.js";
import { TabTrigger, useTabUnderline } from "@preman/desktop/renderer/ui/Tabs.js";
import { SHARED_PROTO_ROOT } from "@preman/desktop/engine/protocol.js";
import type { Density, DiagnosticsInfo, ProcessReading, UpdateStatus } from "@preman/desktop/preload/bridge.js";

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

const UPDATES_HINT = "Whether there is a newer preman, and the two clicks that install one.";
/**
 * The preference's name says what it does and not what it enables. It gates the *check* only —
 * nothing is ever downloaded or installed without a press — and a label reading "update
 * automatically" would promise exactly the thing decision 16 refuses to build.
 */
const AUTO_CHECK_LABEL = "Check for updates automatically";
const CHECK_NOW_LABEL = "Check for updates now";

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
        <DensitySection />
        <FontSection />
        <ThemeSection />
      </Pane>

      {/* Its own tab rather than a fourth card under Appearance: where this machine resolves the
          shared proto root is not a matter of taste, and it is the one setting here that restarts
          every engine when it moves. */}
      <Pane value="protos">
        <ProtosSection />
      </Pane>

      {/* Updates sits above Diagnostics rather than in a tab of its own: both answer "which build
          is this and is it the right one", and a fifth tab holding three rows would be a tab
          nobody opens. */}
      <Pane value="diagnostics">
        <UpdatesSection />
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
/** Nothing collected yet, which is both a caption and the reason Clear is disabled. */
const NO_LINES = 0;

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
          {/* The one button in this pane that keeps the content tier, because it is the one paired
              with a field: a 26px button beside a 30px input is a row that does not line up, and
              matching the control it acts on is what the tiers are for. */}
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
 * Whether there is a newer preman, and the two clicks that get to it.
 *
 * Two clicks and not one, and never zero. The check is automatic and can be turned off here; the
 * download and the restart are separate deliberate presses, because a swap that fails takes the
 * app with it and nobody should meet that on a machine they walked away from. Decision 16.
 *
 * The running version is read here as well as in the section below it. That is one extra IPC round
 * trip on opening this tab, and it buys a section that says a whole sentence — "preman 1.3.0, up to
 * date" — rather than half of one with the other half four rows down.
 */
function UpdatesSection(): React.JSX.Element {
  const status = useUpdateStore(selectStatus);
  const preferences = useAppearanceStore((state) => state.preferences);
  const setPreferences = useAppearanceStore((state) => state.setPreferences);
  const [running, setRunning] = useState<string | null>(null);

  // Once, on mount, and it never changes while the app runs — the same read and the same reasoning
  // as `DiagnosticsSection` below. A failed read leaves the placeholder, which is honest.
  useEffect(() => {
    let live = true;
    void window.preman
      .diagnostics()
      .then((read) => {
        if (live) setRunning(read.appVersion);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  return (
    <Section title="Updates" hint={UPDATES_HINT}>
      <dl className="flex flex-col gap-2">
        <DiagnosticsRow term="Running">
          <span className="font-mono text-2xs text-ink-dim">preman {running ?? UNKNOWN_VALUE}</span>
        </DiagnosticsRow>
        <DiagnosticsRow term="Status">
          {/* `min-w-0` so a long headline shrinks rather than overflowing, but deliberately not
              `flex-1`: that would hand the span every leftover pixel of the column and strand the
              button at the far edge, which is not what the Log row below does with Reveal. */}
          <span className={cn("min-w-0 text-2xs", status.phase === "failed" ? "text-danger" : "text-ink-dim")}>
            {updateHeadline(status)}
          </span>
          <UpdateActions status={status} />
        </DiagnosticsRow>
      </dl>
      {/* A `hint`, not a `Banner`: this is a standing caveat about how ad-hoc-signed code and TCC
          interact, true of every update this app will ever install, and a bar that said it would
          be a bar that said it forever. */}
      {status.phase === "ready" && <p className="text-2xs text-ink-faint">{LOCAL_NETWORK_CAVEAT}</p>}
      <label className="flex items-center gap-1.5 text-2xs text-ink-dim">
        <input
          type="checkbox"
          checked={preferences.autoCheckUpdates}
          className="size-3 accent-accent"
          onChange={(changed) => {
            setPreferences({ ...preferences, autoCheckUpdates: changed.currentTarget.checked });
          }}
        />
        {AUTO_CHECK_LABEL}
      </label>
    </Section>
  );
}

/**
 * The one action for the phase, and never two.
 *
 * Skip sits beside Download on `available` only, because that is the one state where "not this
 * one" is a coherent answer: before a check there is nothing to skip, and after a download there
 * is 317MB already staged that skipping would silently throw away.
 */
function UpdateActions({ status }: { readonly status: UpdateStatus }): React.JSX.Element | null {
  if (status.phase === "available") {
    return (
      <span className="flex shrink-0 items-center gap-1">
        <Button
          variant="neutral"
          tier="chrome"
          onClick={() => {
            void window.preman.skipUpdate(status.version);
          }}
        >
          Skip
        </Button>
        <Button
          tier="chrome"
          onClick={() => {
            void window.preman.downloadUpdate();
          }}
        >
          Download
        </Button>
      </span>
    );
  }
  if (status.phase === "ready") {
    return (
      <Button
        tier="chrome"
        onClick={() => {
          void window.preman.installUpdate();
        }}
      >
        Restart and install
      </Button>
    );
  }
  // Absent rather than disabled while a check or a download is in flight: a greyed button that
  // will come back in four seconds is a button the reader has to keep watching.
  if (status.phase === "checking" || status.phase === "downloading") return null;
  // The one glyph in this section, and the only one that earns it. Skip, Download and Restart and
  // install are consequential and rare — one of them reboots the app — so they say what they do.
  // This one means refresh, which has a glyph everyone already reads, and costs nothing if it is
  // misread: it checks again. See `docs/decisions/056`.
  return (
    <IconButton
      label={CHECK_NOW_LABEL}
      onClick={() => {
        void window.preman.checkForUpdate();
      }}
    >
      <RefreshIcon />
    </IconButton>
  );
}

/**
 * The four versions a bug report needs, where the log is, and what is being written to it.
 *
 * The lines are here because there was never anything to redact: `docs/decisions/035` fixed what
 * may be written at all — no URL, no header, no body, no variable — so a window that draws the file
 * decides nothing that the writer had not already decided. `docs/decisions/056` is that argument
 * and the switch it bought. The console drawer is still where a *request* is looked at; this is
 * where the app says what it is doing to itself.
 *
 * Reveal still opens the *directory* rather than the file: the rotated `preman.log.1` is half of
 * what a report wants, and a file manager showing the folder gives both.
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
          <StreamToggle />
          <IconButton
            label={REVEAL_LABEL}
            disabled={info === null}
            onClick={() => {
              if (info !== null) void window.preman.revealInFileManager(info.directory);
            }}
          >
            <RevealIcon />
          </IconButton>
        </DiagnosticsRow>
      </dl>
      <LogStream />
    </Section>
  );
}

/**
 * The words for the glyphs. Every control in this section is an icon now, which means each one's
 * whole label lives in its tooltip — so these are sentences a reader meets cold, not captions
 * under a picture that already said it.
 */
const REVEAL_LABEL = "Reveal the log folder";
const STREAM_START = "Stream the log";
const STREAM_STOP = "Stop streaming the log";
const CLEAR_LABEL = "Clear what is on screen";
const SEARCH_LABEL = "Find in the log";
const SEARCH_CLOSE = "Close the search";
const SEARCH_NEXT = "Next match";
const SEARCH_PREVIOUS = "Previous match";
const SEARCH_PLACEHOLDER = "Find";

/** While it is on and the file was empty too, which on a first run is most of the time. */
const STREAM_IDLE = "Streaming. The file was empty, and nothing has been written since.";
const STREAM_LIVE = "Streaming. The tail of the file, then whatever is written next, newest at the bottom.";
const STREAM_STOPPED = "Stopped. These are the lines that were collected while it was on.";

/** Ordinals count from one and indices from zero. The one place that difference is arithmetic. */
const MATCH_ORDINAL_OFFSET = 1;
/** What a query with matches steps to before anybody has stepped. */
const FIRST_MATCH = 0;
const STEP_FORWARD = 1;
const STEP_BACK = -1;
const MATCH_COUNT_SEPARATOR = "/";
/** `splitMatches` answers with one segment when nothing matched, and it is the whole string. */
const SINGLE_SEGMENT = 1;

const ESCAPE_KEY = "Escape";
const ENTER_KEY = "Enter";

/**
 * How close to the bottom still counts as being at it.
 *
 * Fractional line heights mean the arithmetic almost never lands on zero, so a strict comparison
 * would unpin the view on a scroll nobody performed. A few pixels is smaller than a line.
 */
const PIN_SLACK_PX = 4;

/**
 * How much taller than the window the box may be: not at all, less a margin.
 *
 * Measured at the moment of the drag rather than written down, because the window is resizable and
 * a constant would be wrong on every screen but the author's. Deliberately not "what is left below
 * the box", which was the first attempt and is the wrong question here: this pane scrolls, so a box
 * taller than the space under it does not push anything off anything — it scrolls, like every other
 * row in the pane. Measuring the leftover space made the ceiling a function of how much text
 * happened to be above the box, which on a full Diagnostics tab meant the edge could be dragged
 * about five pixels. The margin that is left is what keeps the box from becoming a second viewport
 * with no way to see its own edges.
 */
const LOG_CEILING_MARGIN_PX = 80;

/** What a resize step moves on an arrow key. A line and a bit, so a press is visible. */
const LOG_RESIZE_STEP_PX = 24;
const GROW = 1;
const SHRINK = -1;

/**
 * The edge is reachable and movable from the keyboard, which is what makes it a `separator` rather
 * than a decorated div. A drag handle that only answers a pointer is a size a keyboard cannot
 * choose, and this one changes how much of the thing being read is visible.
 */
const RESIZE_LABEL = "Resize the log";
const RESIZE_KEYS: Record<string, number | undefined> = {
  ArrowDown: GROW,
  ArrowUp: SHRINK,
};

/** Which of the three states the line above the box is in. */
function streamCaption(watching: boolean, count: number): string {
  if (!watching) return STREAM_STOPPED;
  return count === NO_LINES ? STREAM_IDLE : STREAM_LIVE;
}

/**
 * The switch, wherever it happens to be drawn.
 *
 * The state it toggles is in the store rather than here, which is the whole feature: this button
 * unmounts when the tab changes, the pane closes, or the window shows something else, and the
 * stream is supposed to survive all three. See `docs/decisions/056`.
 */
function StreamToggle(): React.JSX.Element {
  const watching = useLogStore(selectWatching);
  const setWatching = useLogStore((state) => state.setWatching);

  return (
    // `active` and not a second glyph: the pressed state is what `IconButton` has for exactly this,
    // and a button that swapped a heartbeat for a stop square would be two icons to learn for one
    // switch. The tooltip carries the verb, and it changes with the state.
    <IconButton
      label={watching ? STREAM_STOP : STREAM_START}
      active={watching}
      onClick={() => {
        setWatching(!watching);
      }}
    >
      <StreamIcon />
    </IconButton>
  );
}

/**
 * The tail itself, drawn only once there is a reason to.
 *
 * Absent rather than empty when the stream has never been on, because an empty box under a button
 * that has not been pressed reads as a box that failed to fill. Once it has been on it stays, with
 * whatever it caught, until Clear — stopping is not throwing away.
 */
function LogStream(): React.JSX.Element | null {
  const lines = useLogStore(selectLines);
  const watching = useLogStore(selectWatching);
  const clear = useLogStore((state) => state.clear);
  const height = useLogStore(selectHeight);
  const resize = useLogStore((state) => state.resize);
  const viewport = useRef<HTMLDivElement | null>(null);
  const field = useRef<HTMLInputElement | null>(null);
  /**
   * Whether the view follows the bottom. A ref and not state: it changes on every scroll frame and
   * nothing renders differently for it, so making it state would repaint the list to store a
   * boolean the list does not read.
   */
  const pinned = useRef(true);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState(NO_QUERY);
  /** Where the reader has stepped to, which is not always where they are. See `active` below. */
  const [stepped, setStepped] = useState(NO_MATCH);

  const matches = useMemo(() => matchingLines(lines, query), [lines, query]);
  /**
   * The match the reader is on: what they stepped to, clamped to what is still there.
   *
   * Derived rather than corrected in an effect, because the list moves underneath the search — a
   * live line arriving at a full buffer drops the oldest and shifts every index — and an effect
   * that fixed it afterwards would paint one frame of an ordinal it had already decided was wrong.
   * Before anyone steps, it is the first match: a search that highlighted matches but stood on none
   * of them would make Next mean "second" the first time it is pressed.
   */
  const active =
    matches.length === NO_LINES
      ? NO_MATCH
      : Math.min(Math.max(stepped, FIRST_MATCH), matches.length - MATCH_ORDINAL_OFFSET);
  const activeLine = active === NO_MATCH ? NO_MATCH : (matches[active] ?? NO_MATCH);

  // Pinned to the bottom, and only while it is pinned. A reader who has scrolled up is reading
  // something, and a tail that yanked them back down on the next line would be unusable for the
  // one thing it is for. Stepping through matches scrolls, which unpins, which is why a search
  // does not have to stop the stream to stay still.
  useEffect(() => {
    const node = viewport.current;
    if (node === null || !pinned.current) return;
    node.scrollTop = node.scrollHeight;
  }, [lines]);

  // The row, by position among the scroller's children. The children *are* the rows, one per line
  // in order, so the index into `lines` is the index into them — which beats an attribute and a
  // selector, both of which would be a second statement of the same fact.
  useEffect(() => {
    if (activeLine === NO_MATCH) return;
    viewport.current?.children.item(activeLine)?.scrollIntoView({ block: "nearest" });
  }, [activeLine]);

  useEffect(() => {
    if (searching) field.current?.focus();
  }, [searching]);

  function step(delta: number): void {
    setStepped(stepMatch(matches.length, active, delta));
  }

  /**
   * How tall the box may be right now: the window, less a margin. Read at the moment it is asked
   * for, so a window the reader has just resized is the one that answers.
   */
  function ceiling(): number {
    return globalThis.innerHeight - LOG_CEILING_MARGIN_PX;
  }

  /**
   * Drag the bottom edge.
   *
   * The pointer is captured, so the drag survives leaving the 5px strip — which it will, on the
   * first fast pull — and keeps reporting until the button comes up. Height is measured from the
   * box's own top to the pointer rather than accumulated from a delta: the element cannot drift
   * away from the cursor, and letting go at the floor and pulling back up starts growing on the
   * first pixel instead of after paying back the slack.
   */
  function onResizePointerDown(pressed: React.PointerEvent<HTMLDivElement>): void {
    const node = viewport.current;
    if (node === null) return;
    const strip = pressed.currentTarget;
    const from = node.getBoundingClientRect().top;
    const limit = ceiling();
    strip.setPointerCapture(pressed.pointerId);

    function onMove(moved: PointerEvent): void {
      resize(moved.clientY - from, limit);
    }
    function onUp(): void {
      strip.removeEventListener("pointermove", onMove);
      strip.removeEventListener("pointerup", onUp);
    }
    strip.addEventListener("pointermove", onMove);
    strip.addEventListener("pointerup", onUp);
  }

  function closeSearch(): void {
    setSearching(false);
    setQuery(NO_QUERY);
    setStepped(NO_MATCH);
  }

  if (!watching && lines.length === NO_LINES) return null;

  return (
    <div className="flex flex-col gap-1.5">
      <p className="min-w-0 text-2xs text-ink-faint">{streamCaption(watching, lines.length)}</p>
      {/* The controls float over the log rather than sitting above it, which is what the reader
          asked for and what a tail wants: the box is the tall thing in this section, and a strip of
          chrome above it would push the newest line — the one being watched — further down. */}
      <div className="relative">
        <div
          ref={viewport}
          // A log is read, not operated: `tabIndex` so a scroller full of text can be reached and
          // paged by a keyboard, which a plain overflow container cannot be.
          tabIndex={0}
          role="log"
          aria-label="Application log"
          onScroll={() => {
            const node = viewport.current;
            if (node === null) return;
            pinned.current = node.scrollHeight - node.scrollTop - node.clientHeight <= PIN_SLACK_PX;
          }}
          style={{ height }}
          // `select-text` is a deliberate local exception to the app-wide `select-none` in
          // `app.css`, the same one `ResponsePane` and `ResponseFailure` take and for the same
          // reason: this is the text of a bug report. A log you cannot copy a line out of sends the
          // reader to the file for something they are already looking at.
          className="overflow-y-auto overscroll-contain rounded-sm border border-line bg-canvas p-1.5 font-mono text-2xs select-text focus-visible:outline-1 focus-visible:outline-accent"
        >
          {lines.map((line, index) => (
            <div key={line.seq} className={cn("flex gap-2", index === activeLine && "bg-hover")}>
              <span className="shrink-0 text-ink-faint tabular-nums">
                <Marked text={formatLogTime(line.at)} query={query} active={index === activeLine} />
              </span>
              <span className={cn("w-10 shrink-0", levelClass(line.level))}>
                <Marked text={line.level} query={query} active={index === activeLine} />
              </span>
              <span className="min-w-0 break-all whitespace-pre-wrap text-ink-dim">
                <Marked text={line.text} query={query} active={index === activeLine} />
              </span>
            </div>
          ))}
        </div>
        {/* The bottom edge, grabbable. Not `ui/Handle` — that one is a `react-resizable-panels`
            `Separator` and only means anything inside a `PanelGroup`, which this scrolling pane is
            not. What it does carry over is the paint: a hairline that answers on hover, because a
            visible gutter is a visible gutter every time the pane is opened. `touch-none` is what
            stops the pane scrolling under a drag on a trackpad that reports touch. */}
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label={RESIZE_LABEL}
          aria-valuenow={height}
          aria-valuemin={LOG_HEIGHT_MIN}
          tabIndex={0}
          onPointerDown={onResizePointerDown}
          onKeyDown={(pressed) => {
            const delta = RESIZE_KEYS[pressed.key];
            if (delta === undefined) return;
            // Claimed, or the arrow also scrolls the pane behind the handle the reader is holding.
            pressed.preventDefault();
            resize(height + delta * LOG_RESIZE_STEP_PX, ceiling());
          }}
          className="group -mb-1 flex h-2 cursor-row-resize touch-none items-center justify-center focus-visible:outline-1 focus-visible:outline-accent"
        >
          <div className="h-px w-10 rounded-full bg-line transition-colors duration-(--duration-glyph) ease-out group-hover:bg-glyph group-active:bg-accent" />
        </div>
        {/* Its own surface and border: `bg-panel` is what every floating thing in this app sits on,
            and without one the glyphs would be drawn on top of the log text they are for.
            `items-center` is what lets a 30px field share a strip with 26px buttons — the strip is
            sized by the tallest and the rest are centred in it, rather than a row pretending to be
            one tier while holding two. */}
        <div className="absolute top-1 right-2.5 z-chrome flex items-center gap-0.5 rounded-sm border border-line bg-panel p-0.5">
          {searching ? (
            <>
              <div className="w-48">
                <Field
                  ref={field}
                  mono
                  value={query}
                  placeholder={SEARCH_PLACEHOLDER}
                  aria-label={SEARCH_LABEL}
                  lead={<SearchIcon className={GLYPH_CLASS} />}
                  onChange={(event) => {
                    setQuery(event.target.value);
                    // Back to the first match of the new query, not the third match of the old
                    // one. `active` resolves an unstepped search to the first hit, so this is the
                    // whole of "typing starts the search over".
                    setStepped(NO_MATCH);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === ESCAPE_KEY) {
                      // Claimed, or the pane's own window-level Escape closes Settings out from
                      // under a reader who only meant to put the search away. That listener skips
                      // a prevented event for exactly this — it is how a Radix layer above the
                      // pane keeps its dismissal to itself.
                      event.preventDefault();
                      closeSearch();
                      return;
                    }
                    if (event.key !== ENTER_KEY) return;
                    // Enter in a field inside a pane would otherwise be the pane's to interpret.
                    event.preventDefault();
                    step(event.shiftKey ? STEP_BACK : STEP_FORWARD);
                  }}
                />
              </div>
              <span className="px-1 text-2xs text-ink-faint tabular-nums">
                {matches.length === NO_LINES ? FIRST_MATCH : active + MATCH_ORDINAL_OFFSET}
                {MATCH_COUNT_SEPARATOR}
                {matches.length}
              </span>
              <IconButton
                label={SEARCH_PREVIOUS}
                disabled={matches.length === NO_LINES}
                onClick={() => {
                  step(STEP_BACK);
                }}
              >
                <PreviousMatchIcon />
              </IconButton>
              <IconButton
                label={SEARCH_NEXT}
                disabled={matches.length === NO_LINES}
                onClick={() => {
                  step(STEP_FORWARD);
                }}
              >
                <NextMatchIcon />
              </IconButton>
              <IconButton label={SEARCH_CLOSE} onClick={closeSearch}>
                <CloseIcon />
              </IconButton>
            </>
          ) : (
            <>
              <IconButton
                label={SEARCH_LABEL}
                onClick={() => {
                  setSearching(true);
                }}
              >
                <SearchIcon />
              </IconButton>
              <IconButton label={CLEAR_LABEL} disabled={lines.length === NO_LINES} onClick={clear}>
                <ClearIcon />
              </IconButton>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * One column of a row, with whatever the query matched banded.
 *
 * A match is a *line* and not an occurrence, which is why `active` is per column rather than per
 * hit: what Next steps to is a line the reader then reads, and banding one of three occurrences on
 * it more strongly than the other two would be a distinction about a row they are already on.
 *
 * Runs and not characters. `CommandPalette`'s `Highlighted` goes letter by letter because a fuzzy
 * subsequence is letters; this is a substring, so a full screen of log costs a handful of spans
 * rather than thirty thousand. The common case — no query — is one segment and no spans at all.
 */
function Marked({
  text,
  query,
  active,
}: {
  readonly text: string;
  readonly query: string;
  readonly active: boolean;
}): React.JSX.Element {
  const segments = splitMatches(text, query);
  if (segments.length === SINGLE_SEGMENT) return <>{text}</>;
  return (
    <>
      {segments.map((segment, index) =>
        segment.hit ? (
          // The index is the identity: the same word twice in one line is two places.
          <span key={index} className={cn("rounded-xs", active ? "bg-match-active" : "bg-match")}>
            {segment.text}
          </span>
        ) : (
          <span key={index}>{segment.text}</span>
        ),
      )}
    </>
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

/**
 * Shape only, no colour, for the same reason `ui/Sparkline.tsx` carries none: `cn` is a plain join
 * and not `tailwind-merge`, so a colour here plus a colour at the call site both reach the element
 * and the generated stylesheet's declaration order picks the winner. Three of the five cells below
 * do override it, so every one of them names its own tier instead.
 */
const NUMBER_CELL_CLASS = "text-right font-mono text-2xs tabular-nums";
const HEAD_CELL_CLASS = "text-2xs font-normal text-ink-faint";
/** The tier the numbers that are nobody's headline read at: memory, peak, and the absent total. */
const QUIET_CELL_CLASS = "text-ink-faint";
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
            <td className={cn(NUMBER_CELL_CLASS, QUIET_CELL_CLASS)}>{NO_TOTAL}</td>
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
      <td className={cn(NUMBER_CELL_CLASS, QUIET_CELL_CLASS)}>{formatMemory(reading.memoryKb)}</td>
      <td className={cn(NUMBER_CELL_CLASS, QUIET_CELL_CLASS)}>{formatMemory(reading.peakMemoryKb)}</td>
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
