# 011: A file watcher reconciles external edits

Status: Accepted

## Decision

Each engine host watches its workspace. When a file changes underneath the app:

- a **clean** tab reloads silently,
- a **dirty** tab is flagged conflicted, offering keep-mine, take-theirs, or a diff.

The catalog is refreshed incrementally from the changed paths rather than rebuilt.

## Rationale

The premise of the whole tool is that these are ordinary files in an ordinary repository. Their
owner will `git pull`, switch branches, and edit them in an editor while the app is open. An app
that silently keeps showing pre-pull content, and then writes it back over the merge, is worse than
one that never opened the file.

Reloading a clean tab silently is safe by definition — there is nothing of the user's to lose, and
prompting would train them to dismiss prompts.

Overwriting a dirty tab is never safe, so it is never done automatically. The three-way choice is
offered because all three are legitimate: a branch switch usually wants theirs, a stray formatter
run usually wants mine, and anything surprising wants the diff.

## Consequences

Watching is per host, so the cost scales with open workspaces rather than with known ones.

Coalescing is required, not optional. An editor's save is several filesystem events, and a
`git checkout` is thousands. The watcher debounces (50ms) and the git-status push debounces again
(400ms).

**This is the hardest thing in the repository to test on macOS.** FSEvents does not deliver a write
made between `fs.watch` returning and the stream actually starting, so a test that writes once and
waits is flaky by construction. `pokeUntil()` in `test/helpers.ts` exists for this: it re-writes
until the watcher reports, and its poke interval must exceed both debounces or it resets the timer
it is waiting on.
