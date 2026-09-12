# 056: The log can be watched while it is written

Status: Accepted

## Decision

The Settings pane's Diagnostics section renders the log. A button starts and stops a live stream of
the lines main is writing; while it is on, the window keeps the newest 500 and draws them, newest at
the bottom.

**This record amends 035.** Where 035 said "the pane points at the directory and never renders a
line from the file", the pane may now render the lines as they are written. Every other clause of
035 stands unchanged, and one of them is the reason this one can go: what may be written is still
fixed, and still excludes a URL, a header, a body, a variable name and a variable value.

The stream is a tee off `note()` in `main/main.ts` — the one function every log line in the app
passes through — and not a tail of `preman.log`. Main holds nothing while it is off; between the
press and the next press it batches lines on a 100ms timer and sends an array.

The switch lives in a renderer store and the subscription lives at the top of `App.tsx`, so both
outlive the pane. Leaving the Diagnostics tab, closing Settings, or opening anything else does not
stop the stream. Nothing persists: every launch starts with it off.

Switching on answers with the tail first: the last 500 lines of `preman.log`, read synchronously in
the same turn as the switch, sent as a batch that **replaces** rather than appends. The rotated
`preman.log.1` is not read. Every batch after it appends.

The controls are glyphs. Stream, Reveal, Clear and the search are `IconButton`s, and Clear and the
search float over the top-right corner of the log box rather than sitting above it. In the Updates
section on the same tab, Check now is a glyph too; Skip, Download and Restart and install are not.

The box is resizable and its text is selectable. Its bottom edge is a `separator` that drags with a
pointer and steps with the arrow keys, between a floor of 96px and whatever is left of the window;
the height lives in the same store as the switch, so it survives the section unmounting. The lines
themselves are `select-text`, a local exception to the app-wide `select-none`.

The search highlights rather than filters. A magnifier opens a field over the box; matches are
banded wherever they are, a counter says which of how many, and Next and Previous step between them,
wrapping. Escape closes it. The stream is not stopped or paused by searching.

## Rationale

035's refusal was one sentence in its Consequences — "a pane that showed the log would have to
decide what to redact, and this record already decided that by not writing it" — and it is that
second clause which makes the first one unnecessary. The redaction problem 035 solved is solved at
the writer. A window that draws the file decides nothing the writer had not already decided, so the
cost of showing it is no longer a security argument; it is only a question of whether it earns its
pixels.

It does, for the case Reveal does not cover. The file answers "what happened before it broke" and
is the right shape for a bug report. It is the wrong shape for the other question — "what happens
when I do this" — because answering that with a file manager is a loop of: press the thing, find
the window again, open the folder, open a 2MB file in whatever the OS thinks owns `.log`, scroll to
the end, and hope the editor reloaded. Nobody does that twice. A running tail turns it into one
press, and the app already has every line in hand.

A tee rather than a tail because the writer holds the level and the text as values. A tail would
have to watch the file, reassemble a partial last line, and notice the rename at `LOG_MAX_BYTES` —
three ways to display something other than what was written, bought in exchange for nothing.

The switch outliving the pane is the whole feature and not a convenience. The reason to watch a log
is to go and do the thing that fails, and everything worth doing in this app is somewhere other than
the Settings pane: sending a request, opening a workspace, watching a host die. A stream that ended
when the pane closed would be a stream that could only ever be aimed at the Settings pane. That is
also why it is not modelled on 040's sampler, which is paired with its section's mount precisely
because a reading taken while nobody is looking is worthless — here it is the opposite, and it is
the only reading that is worth anything.

The 500-line cap is what keeps this a live tail and not a file viewer. A window that could scroll
the whole file would need paging, the rotated file, and a decision about what to do when it rotates
mid-read, to duplicate a file manager the button beside it already opens.

**The tail is a bounded read, not paging.** The first version of this record had no backfill at all,
on the argument that the lines before the switch are in the file. That is true and it is not an
answer: the moment worth reading is almost always the one just before you thought to press the
button, and a stream that opened empty made the reader go to the file anyway — which is the loop
this record exists to remove. One read of a known size, at a press, with no scrollback above it,
buys that without buying a file viewer. The limit the window keeps and the limit the read takes are
the same number, derived from one constant: a buffer smaller than the tail would throw away part of
the answer on the frame it arrived.

The read is **synchronous and in the same turn as the switch**, which is the only reason the seam is
exact. Main is single-threaded and `note()` calls `push` from that same thread, so between "read the
file" and "start forwarding" there is no instant in which a line can be written and be missed by
both. An asynchronous read would have one, and its symptom would be a single missing line under load
— the least debuggable possible bug in the debugging tool. The cost is a blocking read of a file
capped at 2MB, once, when a button is pressed.

**The tail replaces what is on screen**, because switching on has to mean one thing. Stop, then
start again, and the fresh tail overlaps what the previous session left; appending it would print a
block the reader had already read, in the middle of a list that reads as continuous. Replacing means
the switch always says "here are the last 500 lines", whether it is the first press or the fourth.

**Only the current file.** Reaching into `preman.log.1` to pad a short tail would put a gap of
unknown size in the middle of a list with no seam drawn in it, because the rotation is a rename and
not a boundary the reader can see. Just after a rotation the tail is short, which is true.

**The search highlights in place rather than filtering.** A filter is the better tool for "show me
every line mentioning X" and the worse one for the question this pane gets asked, which is "what
happened around X". A log line is only interesting with its neighbours — the request before the
failure, the retry after it — and a filter deletes exactly those. Banding the hits and stepping
between them keeps the context and gives up nothing except the density a filter would have bought.

That choice is also what lets the search leave the stream running. Stepping to a match scrolls the
box, and scrolling is what unpins the view from the bottom, so a line arriving while the reader is
standing on a match cannot yank them away from it. A search that froze the stream would have had to
explain why the log stopped, and would have dropped the lines it did not show.

**Icons, and where they stop.** `IconButton` was already the chrome tier with no border and no
fill, and it already takes a `label` that is both the tooltip and the accessible name, so nothing had
to be invented and nothing is lost to a screen reader. Clear and the search float over the box for
the same reason the box is the tall thing in the section — a strip of chrome above it would push the
newest line, the one being watched, further down the pane.

The line is drawn at cost of being misread, not at section boundaries. Check now is a glyph because
it means refresh, which is the most legible glyph there is, and because the worst a misreading costs
is a second check. Skip, Download and Restart and install keep their words: they appear only when
there is an update, they are each a decision, and one of them reboots the app mid-sentence. There is
no glyph that says "Restart and install", and a strip of four unlabelled buttons over a version
number is a quiz.

**The box is dragged, not cycled through sizes.** How much log you want on screen depends on what
you are chasing — four lines around a failure, or a hundred while a workspace loads — and a control
offering three answers would be wrong twice. The edge is a `separator` and not a decorated div
because it is focusable and answers the arrow keys: a drag handle that only takes a pointer is a
size a keyboard cannot choose, and this one decides how much of the thing being read is visible.
It is not `ui/Handle`, which is a `react-resizable-panels` `Separator` and means nothing outside a
`PanelGroup` this scrolling pane does not have; what it does borrow is the paint, a hairline that
answers on hover, because a visible gutter is a visible gutter every time the pane is opened.

The ceiling is measured at the moment of the drag rather than written down — the window is
resizable, so a constant would be wrong on every screen but the author's — and it is the window less
a margin, not the space left underneath the box. That distinction was found by dragging the thing:
measuring the leftover space makes the ceiling a function of how much text happens to sit above the
box, and on a Diagnostics tab with an Updates section on it the edge moved about five pixels. The
pane scrolls, so a box taller than the space under it pushes nothing off anything; it scrolls, like
every other row in the pane.

The height sits in the store beside the switch for the switch's own reason: it is dragged taller
_because_ the reader is about to go and do something, and doing it unmounts the section.

**Selectable, because it is the text of a bug report.** The app is `select-none` so that dragging
across a list of requests does not paint half of it blue; the response panes already take a local
exception, and this is the same case. A log a reader cannot copy a line out of sends them to the
file for something they are already looking at, which is the loop this record exists to close.

The match band is `--color-match` and `--color-match-active`, derived from `--color-accent` with the
same 14% and 30% mixes `ui/editorTheme.ts` already solved for the editor's selection. `--color-selected`
is a row tint argued down to hover luminance and reads at about 1.2:1, which is not enough behind
four characters, where WCAG 1.4.11 asks 3:1. Deriving from the accent costs no new row in the audit,
no regenerated theme and nothing in the other forty-two palettes.

## Consequences

035 keeps its file, its number and every clause but one; this record is named in its status line and
beside the sentence it amends. The invariant that made the amendment safe is 035's own, so anyone
loosening what may be written into the file is now reversing two records rather than one — and the
second one has a window in it.

An app with the stream on holds a batching timer between a line and its delivery, and one branch per
logged line when it is off. The idle cost 040 fought for is untouched: there is no periodic work
here at all, because the clock that drives this is whatever the app was already doing.

The window can be left streaming for a week, and will hold 500 lines. What it cannot do is tell you
about the 501st line back — the file can, and the pane says so in the sentence above the box and
puts Reveal in the row above that.

`main/diagnostics.ts` now reads the format it writes, in `parseLog`, which makes the stamp a
contract with itself rather than a string it emits. A line that does not begin with one is treated
as the second line of the record before it, which is how a stack trace survives the round trip;
only a continuation with nothing to continue is dropped, and that happens at most once per file,
at the top, where a rotation cut a record in half.

The renderer now renders text the main process wrote, which is a thing no other pane does. It is
still not a channel out of `main/`: what crosses is a level, a millisecond and a string, declared in
`preload/bridge.ts` beside every other thing that crosses.
