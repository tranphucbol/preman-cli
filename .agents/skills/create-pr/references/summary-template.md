# PR Summary Template

Generate the pull request summary following this exact structure, in the style and within the
length below.

## Template

The structure lives in the repository, so a pull request opened in the GitHub web UI starts from
the same one: `.github/pull_request_template.md` at the repository root. Follow its headings in
order. Each `<!-- ... -->` comment is the guidance for its section: replace it with the content it
asks for and drop the comment. Keep the italic guidance sentence under "Verification & Testing"
verbatim.

## Closing Keywords

When a GitHub issue is the tracked context (`{issue_number}` from Step 1), add a line right after
the title-equivalent context — the first line of the "Description" subsection is the natural spot —
using a GitHub closing keyword so merging the PR closes the issue automatically:

```
Closes #{issue_number}
```

## Style

Write in plain, everyday English that a reviewer new to the code can read once and understand.

- Short sentences, one idea each. Active voice: "The console now stops the query", not "The query
  is stopped".
- Common words over jargon. Name a file, function or setting in backticks only when the reviewer
  needs it to find the change.
- Say what changed and why. Leave out how you worked, what you tried first, and anything the diff
  already shows line by line.
- No hype, no filler ("This PR aims to..."), no emoji, no exclamation marks.
- Bullets for lists of changes; a short paragraph for the problem and the reason.

## Analysis Guidelines

### For Code Changes (any language):

- Identify new classes, methods, or interfaces added
- Note modifications to existing business logic
- Check for changes in exception handling
- Review service layer modifications
- Analyze controller/API endpoint changes

### For Configuration Changes:

- Review application properties modifications
- Check database configuration updates
- Analyze external service configurations
- Note environment-specific changes

### For Database Changes:

- Review SQL migration files
- Identify new tables, columns, or indexes
- Check for data migration scripts
- Analyze schema changes impact

### For API Changes:

- Identify new endpoints added
- Note modifications to existing endpoints
- Check request/response model changes
- Review authentication/authorization changes

## Output Constraints

- At most 300 words in the whole draft, headings and checklist included, as `wc -w` counts the
  draft file. A small change needs far fewer. When a draft runs over, cut repetition and detail
  the diff already shows; never cut a risk, a test you did not run, or a step someone must take
  before or after merging
- Key Changes section covers sufficient context but does NOT list every file — only significant changes grouped by intent
- Impact and Scope includes only scopes with material impact. Omit unaffected scopes entirely instead of stating that they have no changes or impact
- Problem statement is clear and specific
- Solution approach is well-explained
- Testing scenarios are relevant to changes
