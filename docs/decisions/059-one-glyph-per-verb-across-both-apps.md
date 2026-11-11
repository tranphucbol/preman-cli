# 059: One glyph per verb across both apps

Status: Accepted

## Decision

preman draws the same glyph TableCraft draws for every verb the two apps share. Both already used
Phosphor at the same version, so this is a choice of glyph and not of library: `ui/icons.ts` keeps
its semantic names and re-points the ones that disagreed.

| Name                          | Was                             | Now                           |
| ----------------------------- | ------------------------------- | ----------------------------- |
| `SendIcon`                    | `Play`                          | `RunGlyph` (rounded triangle) |
| `RunnerIcon`                  | `PlayCircle`                    | `RunAllGlyph` (two triangles) |
| `CancelIcon`                  | `Stop`                          | `StopGlyph` (rounded square)  |
| `SettingsIcon`                | `Sliders`                       | `GearSix`                     |
| `CopyIcon`                    | `Copy`                          | `CopySimple`                  |
| `DuplicateIcon` (new)         | — (shared `CopyIcon`)           | `Copy`                        |
| `ImportIcon`                  | `TrayArrowDown`                 | `FileArrowDown`               |
| `FormatIcon`                  | `BracketsCurly`                 | `TextIndent`                  |
| `PickerIcon`                  | `CaretUpDown`                   | `CaretDown`                   |
| `FolderIcon`                  | `Folder` / `FolderOpen`         | `FolderSimple`, open or shut  |
| `NewFolderIcon`               | `FolderPlus`                    | `FolderSimplePlus`            |
| `SecureIcon` / `InsecureIcon` | `LockSimple` / `LockSimpleOpen` | `Lock` / `LockOpen`           |

The three run glyphs are TableCraft's `runGlyphs.tsx`, copied: polygons on Phosphor's `IconBase`
with a round-joined stroke for the corners, one shape in every weight.

**Size is 16px in every density**, through the one `IconContext` in `App.tsx`. TableCraft's
`iconPx` is 16 in all its presets too; the smallest control here is 24px, which still leaves 4px
either side.

**Weight carries meaning, in three places only.** An icon inside a labelled `Button` is `fill`
(`LABELLED_ICON`), an `IconButton` stays `regular`, the tick that confirms a copy is `bold`
(`CONFIRMATION_WEIGHT`), and a warning that marks one row or one notice is `fill`
(`STATUS_WEIGHT`). A section heading's warning stays `regular`: it names a category, it is not the
problem.

## Rationale

Someone who moves between the two apps all day reads glyphs before labels. A gear that opens
settings in one window and a set of sliders that opens them in the other is a small tax paid every
time; so is one app's Copy meaning duplicate a row while the other's means put text on the
clipboard. TableCraft has the larger icon audit — an `ACTION_ICONS` map naming each verb — so the
cheaper direction is for preman to follow it, verb by verb, where the meaning is the same.

Two of the swaps are corrections rather than imports. Copy and Duplicate were one glyph for two
verbs, and `BracketsCurly` as Format was the same mark the body itself is made of. `FolderOpen`
went because the row's caret already says open or shut; a second open/shut signal one glyph later
was noise.

A density `icon` token was considered and refused. `test/renderer/appearance.test.ts` holds the
shipped default to the numbers `app.css` declares and counts the properties `apply.ts` writes, so a
token is a CSS variable, a test fixture and a migration for one number that no preset varies.
Should one ever vary, that is the time to pay for it.

## Consequences

- Anyone who learned preman's old glyphs relearns six of them, and the README GIFs show the old ones
  until they are re-recorded (`bun run readme:media`).
- 16px against 13.5px body text is a heavier icon row than before, and noticeably so in compact.
  It is what TableCraft ships; if compact reads as crowded, the token above is the fix.
- `runGlyphs.tsx` is the one hand-drawn file in `ui/`. It is a copy, so a change to TableCraft's
  run glyph has to be copied here as well; the shared verb list is the contract, not a package.
- A new icon starts in TableCraft's `ACTION_ICONS`: if the verb is there, use its glyph.
