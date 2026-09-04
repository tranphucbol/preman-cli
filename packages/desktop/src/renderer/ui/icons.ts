/**
 * The icon set, enumerated.
 *
 * One family, Phosphor, chosen because a request client needs folder, file-code, play, plug, key,
 * terminal and gear glyphs in one consistent hand. Nothing here is hand-drawn: an `svg` with a
 * `path` typed from memory is how an icon set stops being a set.
 *
 * Re-exported by name rather than imported ad hoc at each call site so that this file is the
 * audit. If a component wants a glyph, it appears here first, which makes "how many icons does
 * this app actually use" a question with an answer.
 */
export {
  ArrowClockwise as RefreshIcon,
  // The two halves of one button. Vertical because that is the axis a tree folds along: the arrows
  // meet where the rows are about to close up, and part where they are about to make room.
  ArrowsInLineVertical as CollapseAllIcon,
  ArrowsOutLineVertical as ExpandAllIcon,
  ArrowSquareOut as RevealIcon,
  BracketsCurly as FormatIcon,
  Broom as ClearIcon,
  CaretRight as CaretRightIcon,
  CaretUpDown as PickerIcon,
  Check as CheckIcon,
  CheckCircle as PassIcon,
  Circle as UnknownIcon,
  // A clipboard with writing on it, for the button that reads the clipboard again. The plain
  // `Clipboard` is an empty one, which is the state *after* a paste rather than the thing offered.
  ClipboardText as PasteIcon,
  Code as ScriptIcon,
  Copy as CopyIcon,
  DotsThree as MoreIcon,
  Export as ExportIcon,
  FileCode as RequestIcon,
  FilePlus as NewRequestIcon,
  FloppyDisk as SaveIcon,
  Folder as FolderIcon,
  FolderOpen as FolderOpenIcon,
  FolderPlus as NewFolderIcon,
  Funnel as FilterIcon,
  GitBranch as BranchIcon,
  Globe as EnvironmentIcon,
  Key as AuthIcon,
  // A chain link, for the thing that is literally a symlink. The noun is the same on both sides
  // of the screen, which is what makes "the acquiring-core link is missing" a sentence about a
  // row the user can see rather than about the filesystem.
  LinkSimple as LinkIcon,
  ListMagnifyingGlass as PaletteIcon,
  LockSimple as SecureIcon,
  LockSimpleOpen as InsecureIcon,
  // A bolt with no label, in a pane whose primary action is Send, reads as "run this"; a wand
  // reads as "make one for me", which is what generating an example does.
  MagicWand as GenerateIcon,
  MagnifyingGlass as SearchIcon,
  PencilSimple as RenameIcon,
  Play as SendIcon,
  PlayCircle as RunnerIcon,
  Plus as AddIcon,
  Prohibit as UnsupportedIcon,
  // The pane itself, drawn as a pane. The toggle is the only thing on screen naming the sidebar
  // while the sidebar is gone, so it has to be the noun and not a direction.
  SidebarSimple as SidebarIcon,
  Sliders as SettingsIcon,
  Stack as CollectionIcon,
  Stop as CancelIcon,
  Terminal as ConsoleIcon,
  Trash as DeleteIcon,
  // Deliberately not `Export` mirrored: this Phosphor release has no `Import`, and reusing the
  // export glyph would make the sidebar header's new button read as a second export. A tray
  // taking an arrow is the other half of that pair - something arrives and stays.
  TrayArrowDown as ImportIcon,
  Warning as WarningIcon,
  X as CloseIcon,
  XCircle as FailIcon,
} from "@phosphor-icons/react";

export { IconContext } from "@phosphor-icons/react";

/** The component type every export above shares, for a lookup table keyed by something else. */
export type { Icon } from "@phosphor-icons/react";

/**
 * One size and one weight for the whole app, applied through `IconContext` at the root.
 *
 * 14px against a 13px body size and a 28px row: an icon that matches the cap height of the text
 * beside it reads as punctuation, and an icon a size larger reads as a button. Most of these are
 * punctuation.
 */
export const ICON_DEFAULTS = { size: 14, weight: "regular" } as const;

/** Row affordances (chevrons, handles) sit on `--color-glyph`, which clears 3:1 but not 4.5:1. */
export const GLYPH_CLASS = "text-glyph";
