# 007: Postman's information architecture, our own visual system

Status: Accepted

## Decision

Copy Postman's layout and keyboard shortcuts exactly. Do not copy its appearance.

The layout: left sidebar tree, request tabs across the top, a method/URL bar, sub-tabs for
Params / Auth / Headers / Body / Scripts / Settings, a response pane carrying status, time and
size, an environment selector top-right, a console drawer.

## Rationale

The users of this app are people who already use Postman on the same workspace files. Every hour
they spend learning where things are is a cost the app imposed for no benefit. Muscle memory for
`Cmd+Enter` and for which tab holds headers is worth more than any layout improvement available.

Appearance is the opposite case. Postman's visual language carries a decade of accreted product —
panels for features we do not have, chrome for accounts and teams and cloud sync. Reproducing it
would mean building the chrome to hang it on.

## Consequences

Anything Postman puts in a place we have no feature for simply is not there, rather than being
present and disabled. There is no account menu, no team switcher, no cloud sync indicator.

Where Postman's behaviour is a bug or an accident rather than a design, we deviate — and every such
deviation is a comment in the code saying so, because the next reader's default assumption is that
matching Postman was the intent.

The design system in `packages/desktop/src/renderer/app.css` is ours and every token in it is
contrast-audited. See 009 for how it is tuned.
