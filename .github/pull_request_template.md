<!-- Plain, everyday English in short sentences; 300 words at most for the whole description. -->

# 1. Purpose & Motivation

## Description

<!--
Clearly state the core problem or feature request this PR addresses and the solution implemented.
Use the GitHub issue description when available. If none exists, analyze the git diff to identify the problem and solution.
-->

## Context & Flow

<!--
Draw a plain-text flow diagram showing how the PR changes work at runtime. Cover:
- Request/data path through the changed components
- Old path vs new path — explicitly call out what changed
- Branching decisions and their outcomes

Use only these plain-text Unicode flow characters: →, │, ├, └, and ►. No Mermaid. No icons. Keep it terminal-readable.
Always wrap the diagram in a fenced code block (triple backticks) so GitHub preserves whitespace and indentation.

Example shape:

```
Request → ServiceA.method()
              │
              ├── [OLD] directly calls RepoB.query()
              │
              └── [NEW] validates input first
                          │
                          ├── invalid → return error
                          └── valid → calls RepoB.query() → return result
```
-->

# 2. Key Changes

## Description

<!--
Summarize the critical logical changes and architectural decisions. Use a repo overview doc (e.g. `docs/service-overview.md` or `AGENTS.md`/`CLAUDE.md`) as supporting context when one exists. Use another doc file only when it was read because it is directly relevant to the changed area. Treat the diff and implementation as the source of truth. List only the most important changes — do NOT enumerate every modified file.
Group related changes together and describe the intent, not the file list.
A reader should understand WHAT changed and WHY in under 30 seconds.

Focus on:
- Significant new capabilities or components added
- Core logic changes and their rationale
- Breaking or behavioral changes (API contracts, DB schema, config)
- Deleted functionality (if any)

Omit trivial changes: formatting, import reordering, renaming without behavior change, version bumps.
-->

## Technical Decisions

<!--
Briefly explain why the implementation uses this approach, including important tradeoffs, rejected alternatives, or consistency with existing patterns.
-->

# 3. Verification & Testing

<!--
Include only the test cases approved by the user. Render each approved test case as an unchecked checklist item. If none were approved, omit all checklist rows but keep this section and its fixed italic guidance sentence. Leave results and supporting evidence for the user to add directly in GitHub. Preserve the following italic guidance sentence verbatim in the generated PR.
-->

_Provide reproducible inputs or steps for each test case, followed by the result and supporting evidence._

- [ ] [User-approved test case]

# 4. Impact and Scope

<!--
Analyze the impact of changes by examining:
- Which modules/components are affected
- API changes and their backward compatibility
- Database schema changes
- Configuration dependencies
- External service integrations affected
- Performance implications
- Security considerations
-->
