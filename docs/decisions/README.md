# Decisions

Architecture decision records. One file per decision, numbered, never renumbered. A decision that
is later reversed keeps its file and gains a status, so that the reasoning behind the reversal has
something to point at.

These are the decisions behind the desktop app. The CLI predates the practice.

| #                                                                   | Decision                                                             |
| ------------------------------------------------------------------- | -------------------------------------------------------------------- |
| [001](001-electron-not-tauri.md)                                    | Electron, not Tauri                                                  |
| [002](002-three-processes-and-a-direct-port.md)                     | Three processes, and a direct port between renderer and engine       |
| [003](003-core-stays-synchronous.md)                                | Core stays synchronous                                               |
| [004](004-the-app-authors-the-workspace.md)                         | The app authors the workspace, so core gains write responsibility    |
| [005](005-yaml-document-api-and-atomic-writes.md)                   | Writes go through the YAML Document API, atomically                  |
| [006](006-never-regenerate-methoddescriptor.md)                     | The app never regenerates `methodDescriptor`                         |
| [007](007-postman-information-architecture.md)                      | Postman's information architecture, our own visual system            |
| [008](008-react-and-zustand.md)                                     | React 19 with Zustand                                                |
| [009](009-radix-fenced-and-density-retuned.md)                      | shadcn on Radix, fenced — and density retuned first                  |
| [010](010-explicit-save-and-app-state.md)                           | Explicit save, and app state never enters the workspace              |
| [011](011-a-watcher-reconciles-external-edits.md)                   | A file watcher reconciles external edits                             |
| [012](012-one-window-many-workspaces.md)                            | One window, many workspaces, one engine host each                    |
| [013](013-response-bodies-stay-in-the-engine.md)                    | Response bodies stay in the engine host                              |
| [014](014-codemirror-everywhere.md)                                 | CodeMirror 6 everywhere, no Monaco                                   |
| [015](015-what-v1-ships.md)                                         | What v1 ships                                                        |
| [016](016-the-performance-budget-is-asserted.md)                    | The performance budget is an assertion, not an aspiration            |
| [017](017-interaction-budgets-measure-blocking-at-the-median.md)    | Interaction budgets measure blocking time, attributed, at the median |
| [018](018-what-goes-in-the-packaged-bundle.md)                      | What goes in the packaged bundle                                     |
| [019](019-the-failure-crosses-the-wire.md)                          | The failure crosses the wire                                         |
| [020](020-themes-are-generated-audited-data.md)                     | Themes are generated, audited data                                   |
| [021](021-density-is-a-preset-and-typescript-owns-the-token.md)     | Density is a preset, and TypeScript owns the token                   |
| [022](022-preferences-are-global-and-synchronous-at-first-paint.md) | Preferences are global, and read synchronously at first paint        |
| [023](023-the-parser-is-fed-a-masked-document.md)                   | The parser is fed a masked document                                  |
| [024](024-the-console-repeats-the-response-pane.md)                 | The console repeats the response pane                                |
| [025](025-variable-resolution-stays-in-the-engine.md)               | Variable resolution stays in the engine                              |

001-015 were taken before implementation began. 016-019 were taken during it, and 017 in particular
exists because measuring the budget in 016 disproved the first way it was phrased. 020-022 came with
configurable appearance; 021 answers 009 rather than reversing it, and 020 shows that 014's "the
theme is defined once" is still true word for word. 023 came straight after, from looking at what
the newly legible syntax colours had made obvious: the grammar had been misparsing every body with
a `{{token}}` in it all along. 024 is the first that accepts duplication as the point rather than
the cost: it widens 019's event again and then renders a response body a second way, because 013's
"bodies stay in the engine" also means the engine forgets them. 025 keeps the answer to a token in
that same engine, then gives plain inputs a lighter overlay rather than turning every grid cell into
a CodeMirror instance.

`TEMPLATE.md` is the shape of a new one.
