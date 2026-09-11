# 053: A JSON body arrives pretty-printed

Status: Accepted

Narrows 013 for one content type. A response body still never crosses to the renderer whole unless
it is JSON and small enough that the reader was already free to ask for it whole.

## Decision

When a response body would be pretty-printed by the toggle, the viewer pretty-prints it on arrival
without being asked. The predicate is `formatAvailability` and it is unchanged: JSON by content type
or by sniff, at most `BODY_FORMAT_LIMIT_BYTES`, which is two megabytes. Above that, or for any other
content type, the body arrives exactly as it was sent and the disabled toggle says why.

The automatic pass fires once per response — the viewer is keyed on the body handle, so a new
response is a new decision and turning the toggle back off does not hand the old one a second
chance. Its failure is silent where the toggle's is reported: the reader did not ask for it, and the
raw body behind it is still readable.

The toggle stays, and its label now depends on its state, because it is lit before anyone has
touched it.

## Rationale

Every API preman is pointed at returns minified JSON, and nobody reads minified JSON. The toggle was
one click away, but it was one click away on every response, which is the definition of a default in
the wrong place.

The limit is deliberately the toggle's own rather than a second, lower one chosen for the automatic
case. A separate threshold would be defensible on cost grounds — two megabytes of JSON formatted in
the engine, sent over the port and given a syntax tree is not free, and it now happens without
anyone asking. It was rejected because of what it looks like from the outside: between the two
numbers the reader would find a toggle that is offered, enabled, and did not fire, and no tooltip
can explain that state in a way anyone would remember. One number means one sentence — if preman can
pretty-print it, it already has.

The alternatives considered:

- **A preference.** Rejected. `Preferences` holds theme, density, fonts and the shared proto root:
  things where two reasonable people genuinely want different answers. This is not one of them. A
  setting here would be the toggle again, further away, and it would have to be discovered before it
  could be turned on.
- **Format in the renderer.** Rejected. `JSON.parse` plus `JSON.stringify` over a two-megabyte
  string blocks the main thread for long enough to blow the interaction budgets, and it would put a
  second formatter next to the engine's, free to disagree with it.
- **Hold the first paint until the formatted body arrives.** Rejected. An untruncated preview _is_
  the body, which is why a small response paints in one frame today; gating that frame on a round
  trip to the engine would trade a repaint nobody minds for a delay on every response, including
  every response that turns out not to be JSON.

## Consequences

A JSON response paints twice: raw, then formatted a round trip later. The `body-enter` fade is
running across the same moment, which hides most of it, but it is a real repaint and on a slow
machine it will be visible. That is the price of not gating the first paint, and it was the cheaper
of the two.

The renderer now holds up to two megabytes of a body it was not asked to hold, on every JSON
response, where before it held at most `VIEWER_RETAINED_BYTES`. This does not weaken 013 — the
reader could always reach that state with one click, and the cap is the same cap — but it does mean
the pane's "it will not hold the body" is now true with a named exception rather than absolutely,
and the module doc says so.

A truncated JSON body under the limit costs one wasted window. The automatic format and window zero
are requested in the same tick and the format wins, so sixty-four kilobytes are fetched and never
shown. Suppressing it would mean the window loader knowing what the formatter is about to do, and
the coupling costs more than the bytes.

The automatic pass swallows its own errors, which is a silence. It is bounded: the same click that
the toggle always offered still reports, so a reader who wonders why a JSON body came back raw has a
way to find out, and the only failures reachable here are a dead engine — which has louder symptoms
— and a body that did not parse, which is the case where the raw text is the answer anyway.
