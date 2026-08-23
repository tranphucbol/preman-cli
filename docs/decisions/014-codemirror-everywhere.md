# 014: CodeMirror 6 everywhere, no Monaco

Status: Accepted

## Decision

One editor component, CodeMirror 6, for every text surface: request bodies, the response viewer,
raw YAML, and scripts. One keymap, one theme, one find widget.

`pm.*` completion comes from a hand-written static schema, not from a language service.

## Rationale

Monaco is VS Code's editor and brings VS Code's weight: a large bundle, web workers per language,
and a DOM that assumes it owns a full-height pane. Against that it offers real TypeScript
diagnostics — which matters for exactly one of the four surfaces.

CodeMirror 6 is small enough to instantiate per tab, and its extension model is what makes the
response viewer possible at all: the windowed reader from 013 is a document source, not a string.

One editor across all four surfaces is the actual prize. `Cmd+F` behaves the same in a body and in
a script. The theme is defined once. A keymap change lands everywhere at once.

## Consequences

**Scripts get no type checking.** There is no red squiggle on a typo'd `pm.enviroment.set`; the
failure shows up at run time as an assertion that did not fire. This is the price of the decision
and it is the one users will feel.

The natural upgrade is `@valtown/codemirror-ts` with `@typescript/vfs` in a worker, against an
authored `pm.d.ts`. It is deliberately not in v1: it needs the `pm.d.ts` to exist and be correct
first, and that file is the real work.

Static completion drifts from the sandbox unless someone maintains it. It lists what `pm.*`
offers, and nothing enforces that it still matches `packages/core/src/scripts/`.
