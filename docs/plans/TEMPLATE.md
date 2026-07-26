# Plan template

Copy this file to `docs/plans/<feature>.md` and replace every _italic guidance line_. Delete
sections that genuinely do not apply — an empty heading is worse than no heading.

Rules the existing plans follow, and this one should too:

- **Point at code.** Every claim about current behaviour cites `file.ts:line`. A plan that says
  "the runner ignores group scripts" without a line number cannot be checked.
- **Decide, don't survey.** The Decisions table holds rulings, not options. If a choice is still
  open, the plan is not ready.
- **Name the consequences.** Anything that changes existing behaviour, weakens a guarantee, or
  was chosen without asking gets called out by name before the phases start.
- **Phases land green.** Each phase is independently shippable with `bun run typecheck` and
  `bun run test` clean. A phase that only adds a field nothing reads belongs in the phase that
  reads it.
- **Write the test names.** Listing the `givenX_whenY_thenZ` cases up front is the cheapest
  scope check there is.
- **Keep it honest after the fact.** Update `Status:` and append the deviations when the work
  lands. The plan is a record, not a pitch.

---

# Plan: _short imperative title_

Status: _`not started` / `in progress` / `done`. When done, one paragraph on how reality
differed from the sketch — signature changes, files that moved, docs that live elsewhere.
Details go in "Deviations taken while implementing"; this is the headline._

## The issue

_Two or three paragraphs. What does the tool do today, what does it fail to do, and how does
that failure present to the user? Prefer the observable symptom ("a request returns 401 while
the folder that was supposed to authenticate it looks correctly configured") over the abstract
gap._

_If real workspaces or real files drive this, name them with paths. A plan grounded in a
concrete workspace is much harder to over-build._

## Why nothing happens today

_Only when the feature is "already looks configured but silently does nothing". For a
green-field addition, skip this section — the intro paragraph is enough._

| # | Cause |
| - | ----- |
| 1 | _`fn()` (`src/x.ts:30`) does A but not B_ |
| 2 | _..._ |

_Then any adjacent facts that shape the design but are not themselves causes — a field that
cannot be trusted, an existing sort that is wrong, a fixture that lies._

## Decisions

| #  | Decision |
| -- | -------- |
| 1  | _One ruling per row. Present tense, stated as the new behaviour, with the reason attached when it is not obvious: "…— matches Postman"_ |
| 2  | _..._ |

### Consequences worth naming

_A short bolded lead-in per consequence, then the explanation._

**_This is a behaviour change._** _What used to happen, what will happen, who it breaks, and
what the escape hatch is._

**_This constrains the implementation._** _e.g. a decision that rules out a library, or forces
a lower-level API._

**_This default was chosen without asking._** _State it so the reader can object._

---

## Phase 0 — _the smallest change that unblocks the rest_

_Per file, bullets of what changes. New modules get their exported signature inline:_

```ts
export function doTheThing(options: { … }): { … };
```

- _Behaviour bullets: what it replaces, what happens on the empty case, what raises `CliError`
  and with which exit code._
- _Module-scope constants instead of literals, per `AGENTS.md`:_

```ts
const SOME_SEPARATOR = ":";
```

_Where several files each get one job, a table reads better than prose:_

| File | Responsibility |
| ---- | -------------- |
| `src/x/target.ts` | _one sentence, plus the failure mode it owns_ |

_Where resolution has cases, tabulate them — this is also the test matrix:_

| Situation | Result |
| --------- | ------ |
| _..._ | _warning, skip_ |

## Phase 1 — _..._

## Phase _n_ — Fixtures, tests, docs

_Always the last phase._

_State the fixture constraint from `AGENTS.md` up front: several suites assert the exact
5-request list and its group statuses, so say which changes are permanent edits to the shared
fixture and which are made in a `cloneFixtureWorkspace()` clone._

Permanent:

- _fixture file, the edit, and why it is observably safe_

Cloned, via `cloneFixtureWorkspace()`:

- _..._

New `test/<area>.test.ts` for _the pure units_.

New cases:

`givenX_whenY_thenZ`,
`given…`.

_Docs: which section of `README.md` / `docs/reference.md` gains what. Name the section, not
just the file._

Every phase ends with `bun run typecheck` and `bun run test` both green.

---

## Deviations taken while implementing

_Added as the work lands, numbered, each with a bolded one-line claim then the reasoning.
A deviation is not an apology — it is the reason the next reader should not "fix" the code back
to what the plan said._

**1. _What actually happened._** _Why the plan's version was wrong or unshippable._

---

## Out of scope

- _Adjacent thing a reader will assume is included, and the one-line reason it is not._

## Known issue in the driving workspace, out of scope

_Only when the real workspace that motivated the plan still has a bug after all of it. Cite the
server-side or config file and line, and say plainly that it is a workspace edit, not a code
change._
