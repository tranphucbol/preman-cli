# 013: Response bodies stay in the engine host

Status: Accepted

## Decision

A response body is never sent to the renderer whole. The engine host keeps it and hands out a
handle plus metadata and a 256KB preview (`PREVIEW_BYTES`). The renderer asks for further windows
as the user scrolls.

Pretty-printing, syntax highlighting and folding happen only below 2MB
(`BODY_FORMAT_LIMIT_BYTES`). Above that the body is shown as plain text, and `Cmd+F` runs the
search in the engine rather than in the page.

## Rationale

A 200MB response is not exotic — one unpaginated list endpoint produces one. Structured-cloning it
across the port costs a copy in each process and puts 400MB in play to display the first screenful,
of which the user reads about forty lines.

The 2MB formatting cutoff is a separate limit with a different cause: highlighting and folding are
superlinear in document size, and CodeMirror on a 50MB JSON document is not slow, it is
unresponsive. Degrading to plain text keeps the window usable, which is what the user needs when
the thing they are debugging is the size of the response.

Searching in the engine follows from the same premise: the renderer cannot search text it has
deliberately not been given.

## Consequences

The body store is per host and is therefore reaped with it — see 012. A handle does not survive a
workspace being closed.

The renderer's body viewer is a windowed reader over a remote buffer, not a string. That is more
machinery than `<pre>{body}</pre>` and it is why `src/renderer/model/` has body-window logic that
is pure and unit-tested apart from React.

"Save response to file" is an engine operation. The bytes never pass through the window.
