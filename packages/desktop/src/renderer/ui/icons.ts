/**
 * The icon set, enumerated.
 *
 * One family, Phosphor, chosen because a request client needs folder, file-code, play, plug, key,
 * terminal and gear glyphs in one consistent hand. The glyph for each verb is the one table-craft
 * draws for the same verb, so the two apps read as one family when they sit side by side; see
 * `docs/decisions/059`.
 *
 * Nothing here is hand-drawn except `runGlyphs.tsx`, which is table-craft's file and not a
 * drawing made here: three shapes on Phosphor's own `IconBase`, so they take the same size,
 * colour and context as the rest. An `svg` with a `path` typed from memory is how an icon set
 * stops being a set.
 *
 * Re-exported by name rather than imported ad hoc at each call site so that this file is the
 * audit. If a component wants a glyph, it appears here first, which makes "how many icons does
 * this app actually use" a question with an answer.
 */
export {
  ArrowClockwise as RefreshIcon,
  // A newer preman, in the title bar's chip. Not `ImportIcon`: the tray below is already the
  // sidebar's "Import from cURL", and one glyph in one window cannot mean both "read this file"
  // and "there is a new version". Up rather than down because what the chip announces is a version
  // to move to, which is the same arrow an app store draws; the download it starts is a step on the
  // way and says so in words.
  ArrowCircleUp as UpdateIcon,
  // Which way a frame went. Every event in a server-sent stream came down, so today this is the
  // only direction there is - it is here because the alternative, an unmarked row, reads as a log
  // line rather than as something that arrived, and because a stream that can also send (a
  // websocket) needs its opposite and should not have to invent a matching pair at that point.
  ArrowDown as InboundIcon,
  // The two halves of one button. Vertical because that is the axis a tree folds along: the arrows
  // meet where the rows are about to close up, and part where they are about to make room.
  ArrowsInLineVertical as CollapseAllIcon,
  ArrowsOutLineVertical as ExpandAllIcon,
  ArrowSquareOut as RevealIcon,
  Broom as ClearIcon,
  // The two halves of "go to the next one of these", in the log search. Down and up rather than
  // right and left because the thing being stepped through is a column of lines, and a caret
  // pointing the way the list runs is the only part of a 14px glyph anyone reads.
  CaretDown as NextMatchIcon,
  CaretRight as CaretRightIcon,
  CaretUp as PreviousMatchIcon,
  // One caret, the way it opens. The up-down pair is the macOS popup button, and every picker
  // here is a Radix menu that drops below its trigger rather than one that centres on it.
  CaretDown as PickerIcon,
  Check as CheckIcon,
  CheckCircle as PassIcon,
  Circle as UnknownIcon,
  // A clipboard with writing on it, for the button that reads the clipboard again. The plain
  // `Clipboard` is an empty one, which is the state *after* a paste rather than the thing offered.
  ClipboardText as PasteIcon,
  Code as ScriptIcon,
  // The bare `</>` above is already the Scripts tab, and a script and a command are both code, so
  // the two would be one glyph meaning two things. The boxed one is the command aside: at 14px the
  // rectangle is the only part of either that reads, and a box around code is a code *panel*.
  CodeBlock as CommandIcon,
  // Two verbs, two glyphs: the single sheet puts text on the clipboard, the stacked pair makes a
  // second request in the tree. One glyph for both made "Duplicate" in the sidebar menu read as
  // "copy this request's path".
  Copy as DuplicateIcon,
  CopySimple as CopyIcon,
  Export as ExportIcon,
  // Deliberately not `Export` mirrored: this Phosphor release has no `Import`, and reusing the
  // export glyph would make the sidebar header's new button read as a second export. A file taking
  // an arrow is what an import is here - a cURL, a collection, something that becomes a file.
  FileArrowDown as ImportIcon,
  FileCode as RequestIcon,
  FilePlus as NewRequestIcon,
  FloppyDisk as SaveIcon,
  // One folder glyph, open or shut. The tree's caret already says which, and an open folder beside
  // an open caret said it twice in a 16px column that has room for one.
  FolderSimple as FolderIcon,
  FolderSimplePlus as NewFolderIcon,
  Funnel as FilterIcon,
  // A gear, because that is what a desktop app's settings are drawn as; sliders read as a pane
  // of adjustments to the thing on screen rather than to the app.
  GearSix as SettingsIcon,
  GitBranch as BranchIcon,
  Globe as EnvironmentIcon,
  Key as AuthIcon,
  // A chain link, for the thing that is literally a symlink. The noun is the same on both sides
  // of the screen, which is what makes "the acquiring-core link is missing" a sentence about a
  // row the user can see rather than about the filesystem.
  LinkSimple as LinkIcon,
  ListMagnifyingGlass as PaletteIcon,
  Lock as SecureIcon,
  LockOpen as InsecureIcon,
  // A bolt with no label, in a pane whose primary action is Send, reads as "run this"; a wand
  // reads as "make one for me", which is what generating an example does.
  MagicWand as GenerateIcon,
  MagnifyingGlass as SearchIcon,
  PencilSimple as RenameIcon,
  Plus as AddIcon,
  Prohibit as UnsupportedIcon,
  // Watching the log, on the button that starts and stops it. Not `SendIcon`'s triangle and not
  // `CancelIcon`'s square: those two are a request's verbs, and a strip that used them here would
  // say "send" on the tab that cannot. A heartbeat is the thing itself — a line that keeps
  // arriving — and it reads at 14px, which a wave or a radio glyph does not.
  Pulse as StreamIcon,
  // The pane itself, drawn as a pane. The toggle is the only thing on screen naming the sidebar
  // while the sidebar is gone, so it has to be the noun and not a direction.
  SidebarSimple as SidebarIcon,
  Stack as CollectionIcon,
  Terminal as ConsoleIcon,
  // Reformat the body, by indenting it. Not the braces: those are the JSON they act on, and a
  // toolbar whose button is the content's own glyph reads as a label rather than as a verb.
  TextIndent as FormatIcon,
  Trash as DeleteIcon,
  Warning as WarningIcon,
  X as CloseIcon,
  XCircle as FailIcon,
} from "@phosphor-icons/react";

/**
 * A request's verbs - send it, run the whole collection, stop - as table-craft draws Run, Run All
 * and Cancel. Phosphor's `Play` and `Stop` round their corners by 16 of 256 units, which reads as
 * sharp at 16px; these are solid at every weight, so a filled button and an outlined one agree.
 */
export { RunGlyph as SendIcon, RunAllGlyph as RunnerIcon, StopGlyph as CancelIcon } from "./runGlyphs.js";

export { IconContext } from "@phosphor-icons/react";

/** The component type every export above shares, for a lookup table keyed by something else. */
export type { Icon } from "@phosphor-icons/react";

/**
 * One size and one weight for the whole app, applied through `IconContext` at the root.
 *
 * 16px, table-craft's size, in every density: the glyph is the same drawing at 24px rows and at
 * 32px ones, and the controls it sits in are at least 24px, so it keeps four pixels either side
 * even at its tightest. Regular, the outline, is what an icon-only control and a row draw.
 */
export const ICON_DEFAULTS = { size: 16, weight: "regular" } as const;

/**
 * A `Button` that has a label beside its icon fills the icon, table-craft's rule: the outline is
 * the glyph standing alone, and next to a word it is the word's mark rather than the control.
 */
export const LABELLED_ICON = { ...ICON_DEFAULTS, weight: "fill" } as const;

/** A transient confirmation - the tick after a copy - is drawn bold so it reads as the answer. */
export const CONFIRMATION_WEIGHT = "bold";

/** A status mark at the head of an error or warning line is solid, so it reads before the words. */
export const STATUS_WEIGHT = "fill";

/** Row affordances (chevrons, handles) sit on `--color-glyph`, which clears 3:1 but not 4.5:1. */
export const GLYPH_CLASS = "text-glyph";
