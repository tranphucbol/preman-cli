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
  ArrowSquareOut as RevealIcon,
  BracketsCurly as FormatIcon,
  Broom as ClearIcon,
  CaretRight as CaretRightIcon,
  CaretUpDown as PickerIcon,
  Check as CheckIcon,
  CheckCircle as PassIcon,
  Circle as UnknownIcon,
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
  Sliders as SettingsIcon,
  Stack as CollectionIcon,
  Stop as CancelIcon,
  Terminal as ConsoleIcon,
  Trash as DeleteIcon,
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
