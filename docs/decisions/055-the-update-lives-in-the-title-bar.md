# 055: The update lives in the title bar

Status: Accepted

## Decision

A newer preman is announced by a chip in the title bar, not by a banner across the window.

`updateChip()` in `packages/desktop/src/renderer/model/update.ts` replaces `updateBanner()`. It
answers for three phases and `null` for the other five. `App.tsx` draws the answer as one
chrome-tier control at the trailing end of the title bar, after the Settings gear:

| Phase         | Chip                      | Press              |
| ------------- | ------------------------- | ------------------ |
| `available`   | `Update 0.4.2`            | downloads          |
| `downloading` | `Downloading 47%`         | nothing to press   |
| `ready`       | `Restart to update 0.4.2` | quits and installs |

`idle`, `checking`, `current`, `unsupported` and `failed` draw nothing at all. The full sentence —
the one the banner used to carry, `updateHeadline()` — is the chip's tooltip, and the Settings
pane's Updates section is unchanged and still holds Skip, Check now, and every phase in words.

`Banner`'s `info` tone and `InfoIcon` are deleted. Both existed for this one caller.

## Rationale

**A bar is the shape this app uses for a problem, and this is not one.** `Banner` is
`ui/Banner.tsx`, it is a sibling of the whole resizable workspace, and `design-system.md` lists it
under "Saying something went wrong". ADR 054 knew this and answered it by adding a third tone that
means "nothing is wrong" — which is a tone arguing with its own component. The argument was visible
in the pixels: the strip was the same width as the window and the same shape as a host crash, so a
release announcement read with the urgency of an engine that had died.

**It cost a permanent row for a once-a-release fact.** The banner is `shrink-0` above the panel
group, so every pixel it takes is a pixel the editor and the console do not get, for as long as the
user does not press it — and "not now" is the honest answer to an update most of the time. A
40-pixel strip is a tax on postponing. A chip is not.

**Chrome is where a fact about the whole window already goes.** The title bar's stated job in
`App.tsx` is the workspace picker: a fact about the window rather than about the request. Which
build this is, and that there is a newer one, is the same kind of fact. The chip borrows the
picker's geometry exactly — `h-control`, `rounded-sm`, `px-1.5`, `text-xs` — so the row reads as one
strip with two things in it rather than as a strip with a notification bolted on.

**The accent stops being an exception.** ADR 054 had to argue that the banner was the one place the
accent appears without being the thing you came to press. In the title bar it _is_ the thing you
came to press, and it is the only accent in the row, so `design-system.md`'s rule holds as written
instead of carrying a carve-out.

**`downloading` becomes showable, which is the one thing the move adds.** The banner deliberately
refused that phase: the user pressed the button that started the download, and a strip across the
window reporting their own press back at them is noise. A chip has the opposite problem — it _is_
the button they pressed, and a control that disappears on the press and returns two minutes later as
a different control is a control that looks broken. So the chip stays and reports itself in place,
with the percentage where the version was. There is still no `Progress`: `design-system.md` reserves
that for a wait that is long, opaque, and has a denominator that cannot be revised, and a download
with no `content-length` fails the third. When there is no denominator the chip says the version
instead of inventing a percentage.

**The phase with nothing to press is a `<span>`, not a disabled `<button>`.** A disabled button
emits no pointer events in Chromium, so its tooltip never opens — the rule `design-system.md`
already states for the gRPC field's lock, met here for the second time. Marking it up as a status
also stops it being a tab stop that does nothing.

**It sits after the gear, not before it.** `App.tsx` opens by promising the layout never moves, and
the gear is the one control in that row people aim at without looking. Anything inserted to its left
would move it twice per release. The trailing corner is also where a transient belongs.

## Consequences

**`BannerTone` loses a third of itself, and that is the point.** `info` had one caller. Keeping a
tone nothing wears would leave the next reader deciding what it is for, so it is gone along with
`InfoIcon` — `ui/icons.ts` is the icon audit, and an unused export makes "how many icons does this
app use" a question with the wrong answer. `ICON_BY_TONE` collapsed too, because both remaining
tones are warnings. A tone that is not a warning has to bring its own map back.

**ADR 054's last consequence no longer holds.** "The banner grows a third tone" was true for one
release. 054 keeps its file, its number and its status; this is what replaced that paragraph.

**A user who never looks at the title bar will not learn about an update.** Accepted, and it is the
deliberate half of the trade: the previous design guaranteed they saw it by taking a row of the
window until they acted, and an update is not worth that. The automatic check still runs, the chip
is accent-tinted against otherwise neutral chrome, and `Check for updates` is in the app menu and
the Settings pane for anyone who goes looking.

**Skip is now two steps away rather than one row away.** A chip that opened a menu would be a notice
that had stopped being a single press, so Skip stays in the Settings pane where 054 put it. The
chip's tooltip names the version, which is the thing someone deciding to skip wants to read first.

**The title bar now has a control that appears and disappears.** It is the first one. It spreads
`BANNER_MOTION` rather than declaring a second easing curve, so `docs/design-system.md`'s claim that
exactly one curve is duplicated for Motion's sake stays true.
