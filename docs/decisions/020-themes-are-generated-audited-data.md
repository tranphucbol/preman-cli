# 020: Themes are generated, audited data

Status: Accepted

## Decision

A theme is a value, not a stylesheet: an exhaustive `Record` of 21 interface colours and 36 syntax
colours, plus a variant and a shadow. `packages/desktop/src/renderer/appearance/themes/` holds one
module per theme and `index.ts` collects them; `apply.ts` writes them onto
`document.documentElement.style` as custom properties.

Forty-two of the forty-three are generated from vendored palette JSON by
`packages/desktop/scripts/generate-themes.ts`, run by hand. `preman-dark` is hand-written, ships
first in the list, and is byte-identical to what `app.css` said before this work.

Every theme, generated or not, must pass `auditTheme` in `packages/desktop/scripts/audit.ts`. The
generator refuses to emit a violating theme, and `test/renderer/themes.test.ts` re-runs the same
audit over every committed theme on every test run.

Light themes are in. Following the OS is out: no `nativeTheme`, no `prefers-color-scheme`, no
"System" entry in the picker.

## Rationale

Forty-three themes hand-tuned to a contrast floor is not work anyone does twice, and a palette that
somebody else already tuned is not a contrast guarantee — it is a set of hues. The two halves of
that problem want different tools. Conversion is a one-shot script that can be slow, chatty and
rerun; readability is an invariant that has to hold at review time and keep holding.

So the script derives and the audit judges, and the audit is the part that is committed twice: once
as the generator's gate, once as a test. The generator is a convenience. The test is the contract.
If someone hand-edits a colour in a generated file, the test catches it; if someone adds a theme
without the generator, the test still applies.

Fifteen of the twenty-one colours are direct reads from the source palette. Three — `ink-dim`,
`ink-faint` and `glyph` — are _solved_, walked from `ink` toward `canvas` until they hit 6.7, 4.7
and 3.3:1 against the worst of the five surfaces, because no palette publishes a three-tier dim
ladder and picking one by eye is how the tiers stop meaning anything. The method colours are solved
too: many palettes set `primary.base` and `status.info` to the same value, and six HTTP verbs that
are not visually distinct are six verbs the eye has to read instead of recognise.

The generated files are checked in rather than built. Vite bundles them statically, there is no
file I/O at runtime, and a reader can see what a theme actually is by opening it.

The OS half of the old dark-only rule survives untouched, and for the original reason: a request
tool that repaints itself at sunset is a tool that changed under the user's hands mid-debug. What
is being reversed is only the claim that the way to avoid that is to ship one theme.

## Consequences

**The palettes are vendored, and attribution travels with them.** `scripts/palettes/NOTICE` names
twenty-one upstream families and their licences. The directory is prettier-ignored because it is
copied verbatim. A generated theme is "after gruvbox", not "gruvbox" — the ladder is respaced, the
dim tiers are solved and the method column is repaired, so the result is recognisably related and
demonstrably not the same.

**The audit's thresholds are calibrated against `preman-dark`, not chosen.** `inkFaint` is 4.6 and
not 4.7 because the shipped theme measures 4.671 at its worst surface; `METHOD_MIN_DISTANCE` is
0.08 because the shipped `get`/`grpc` pair sits at 0.0847 in OKLab. Raising a threshold is a
deliberate act that fails the default theme first.

**Monochrome palettes produce ugly method colours.** `mono-light` and `flexoki-light` end up with
near-black verbs, `vesper-dark` with a grey gRPC. The repair passes exhaust hue rotation and fall
back to spreading lightness, which is the honest outcome for a palette with no hues to spend.
`scripts/palettes/overrides.json` exists for the day someone wants to fix one by hand; it is
currently empty.

**Custom themes from disk are deferred.** Bundling is eager and static, which is what keeps cold
start off the budget and the renderer free of file I/O. Reading a theme from the workspace or from
app data would mean a load path, a validation path and an audit that runs at run time rather than
at review time. It is a real feature and it is not this one.

**Two tokens the plan asked for were dropped.** Palette line-number colours measure around 2:1
against their own backgrounds, so the editor gutter keeps the solved `ink-faint`/`ink-dim` tiers
instead. A theme cannot make the gutter unreadable.

**`014` still holds, literally.** "One keymap, one theme, one find widget… The theme is defined
once" survives: there is exactly one `HighlightStyle` and one `EditorView.theme` spec, both static,
both naming `var(--syntax-*)`. Nothing is reconfigured when the theme changes — the editor repaints
because the custom properties underneath it did. The one `Compartment` this work adds carries the
`{ dark }` flag, which is a boolean facet and not a theme. Along the way it fixed a live bug:
`defaultHighlightStyle` is tuned for light backgrounds and measured about 1.3:1 on `--color-canvas`,
so syntax highlighting had been effectively invisible.
