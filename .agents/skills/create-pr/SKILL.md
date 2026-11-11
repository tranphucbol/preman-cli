---
name: create-pr
description: Generate a pull request summary draft, optionally attach test evidence images to a dedicated evidence branch, and create or update a GitHub pull request using the gh CLI. Use when the user asks to "create PR", "create pull request", "draft PR summary", "prepare pull request", "PR summary", "push and create PR", "open a PR", or any task involving generating a PR description from code changes and creating or updating a GitHub pull request.
---

# Create PR

Draft a PR summary from git diff plus optional GitHub issue context, optionally attach test evidence
images, then create a GitHub pull request or update the description of an existing one -- all
through the `gh` CLI, which owns auth so this skill never touches a token directly.

This is the GitHub sibling of the `merge-request` skill. The workflow shape, the summary
template, and the evidence-attachment step all mirror it deliberately, so a user working across
both GitLab and GitHub projects gets the same drafting quality and the same review gates in
either place. What differs is mechanical: `gh` replaces raw curl + `GITLAB_TOKEN` calls, and
GitLab's project uploads endpoint has no GitHub equivalent, so evidence images are committed to a
branch that is never merged.

## Prerequisites

- `gh` CLI installed and authenticated (`gh auth status`) -- needs the `repo` scope
- Write access to the repo if evidence images will be attached; they are committed to an
  evidence branch
- Git repo with a GitHub remote
- Current branch has commits ahead of the base branch

## Workflow

Six steps, executed sequentially:

1. **Detect context** -- Resolve the GitHub repo and base branch via `gh`, read the current
   branch, extract a GitHub issue number, derive a PR title
2. **Fetch issue context** (optional) -- GitHub issue via `gh issue view`, when the branch
   references one
3. **Draft summary** -- Analyze git diff, generate summary in `gdb/{branch_name}.md`
4. **Attach evidence** (optional) -- Commit test evidence images to an evidence branch and embed
   them in the draft
5. **Check draft** -- Check length and content yourself; no approval prompt
6. **Create or update PR** -- Push without asking, safely handle an existing open PR, return URL

### Step 1: Detect Context

Set `{SKILL_ROOT}` to the directory containing this `SKILL.md`.

**a) Resolve the repo and base branch with `gh`:**

```bash
gh repo view --json nameWithOwner,defaultBranchRef,url
```

Store:

- `{repo}` -- `nameWithOwner` (e.g. `tranphucbol/preman-cli`)
- `{default_branch}` -- `defaultBranchRef.name`

If this errors, the remote is not a GitHub repo `gh` can resolve, or `gh` is not authenticated.
Stop and tell the user to run `gh auth login`, or check `git remote get-url origin`. Do not fall
back to manually parsing the remote URL -- that duplicates a job `gh` already does correctly,
including SSH vs HTTPS remotes and GitHub Enterprise hosts.

**b) Get current branch:**

```bash
git branch --show-current
```

Store as `{current_branch}`. Empty output means detached HEAD; stop and ask the user to check out
or create a named branch first, since a PR needs one.

**c) Extract a GitHub issue number from the branch name:**

Match a numeric path segment on its own -- `(?:^|[-/])(\d+)(?:[-/]|$)`, or an explicit `gh-(\d+)` /
`issue-(\d+)` form -- in `{current_branch}`.

Example: `123-fix-login-redirect` -> `123`

A digit run embedded in a longer token (a date, a version) is not a signal; require the number to
be its own segment. If no match, set `{issue_number}` to empty.

**d) Parse branch name into PR title:**

1. Remove common prefixes: `feature/`, `bugfix/`, `hotfix/`, `fix/`, `chore/`, `refactor/`
2. If `{issue_number}` is set: strip the number segment, then
   `{rest-of-branch-with-dashes-as-spaces} (#{issue_number})`
3. Else: `{rest-of-branch-with-dashes-as-spaces}`
4. Title-case the result

Examples:

- `123-fix-login-redirect` -> `Fix login redirect (#123)`
- `tabstrip-grpc-label` -> `Tabstrip Grpc Label`

**In this repository** a branch is `<kind>/<what-it-does>` with kind `feature/`, `fix/` or
`chore/` (`CONTRIBUTING.md#branches`), and it carries no issue number: leave `{issue_number}` empty
unless the user names an issue, and skip step 2. The title is a Conventional Commit subject, in the
same form as a commit (`CONTRIBUTING.md#commits`): `<type>: <summary>`, no scope, imperative and
lower case, no full stop, within 72 characters. Pick the type from the diff -- `feat` for something
the CLI, the engine or the app can now do, `fix` for a wrong behaviour made right, and `docs`,
`test`, `refactor`, `perf`, `ci` or `chore` as the commit table defines them.

- `feature/event-stream-and-response-timer` -> `feat: stream event responses and time each request`
- `fix/tab-activation-and-token-anchor` -> `fix: reveal the editor on tab activation and anchor token boxes`
- `chore/readme-media` -> `chore: record the readme media from the built app`

Name the behaviour a user sees, not the files; reword from the diff when the branch name alone
reads poorly. This repository uses no release-notes labels -- `.github/release-notes.sh` builds the
notes from the commits -- so a pull request is created without one.

### Step 2: Fetch Issue Context (Optional)

Skip this step entirely when `{issue_number}` is empty.

```bash
gh issue view {issue_number} --json title,body,labels,state
```

Extract `issue_title`, `issue_body`, `issue_labels`. `issue_body` fills "Description" and "Context
& Flow" in the draft, and any checklist-shaped content in it pre-populates "Verification &
Testing" candidates. If the issue does not exist or the command errors, treat it as no context
found -- a guessed branch number is a hint, not a guarantee, and a wrong guess must not fail the
rest of the workflow.

### Step 3: Draft Summary

**a) Run git diff analysis:**

```bash
git diff origin/{default_branch}...HEAD --name-only
git diff origin/{default_branch}...HEAD --stat
git diff origin/{default_branch}...HEAD
```

Check whether a repo overview doc exists in the current working tree -- `docs/service-overview.md`
if present, otherwise `AGENTS.md` or `CLAUDE.md` at the repo root. Read it before drafting when
present. Do not scan or read other files under `docs/` by default. Read a specific additional
documentation file only when it is relevant to the changed area and either the overview doc links
to it, or the diff changes a documented API, datastore, integration, or infrastructure component
and more detail is necessary to explain the change accurately.

Use documentation as supporting context only. The git diff and implementation remain the source
of truth when documentation is stale or conflicts with the code.

**b) Pick Verification Test Cases:**

Use the issue context (if any), the git diff and any test cases the user or the plan already
named (a plan in `docs/plans/`, for one) to pick concrete test cases for the changed behavior.
Do not ask the user to confirm them; store them as `verification_test_cases`, rendered as
unchecked checklist items. Do not include results or evidence in them; evidence is handled
separately in Step 4. When none apply, keep the **Verification & Testing** heading and its fixed
italic guidance sentence but omit all checklist rows.

**c) Generate the summary:**

Read `references/summary-template.md` for the rules, and the template it names,
`.github/pull_request_template.md` at the repository root, for structure. Its Style section sets
the voice: plain, everyday English in short sentences, readable by someone new to the code. Its
Output Constraints cap the draft at 300 words.

Key rules:

- Use issue context to inform "Purpose & Motivation"
- When `{issue_number}` is set, add the closing keyword line described in
  `references/summary-template.md` so merging the PR closes the issue
- Include the `verification_test_cases` from Step 3b as unchecked items in "Verification &
  Testing" (this overrides the template comment about user-approved cases); omit checklist rows
  when there are none
- Use git diff as the source of truth for "Key Changes", supplemented by the targeted
  documentation context collected during diff analysis
- Do not invent test evidence or add an evidence placeholder; Step 4 adds user-supplied
  descriptions and uploaded images directly beneath the mapped test cases
- Exclude version.conf and pom.xml version changes

**d) Write draft to file:**

```bash
mkdir -p gdb
```

Write the generated summary to `gdb/{branch_name}.md`, `/` replaced by `_` in the branch name.

Example: branch `feature/123-add-auth` -> file `gdb/feature_123-add-auth.md`

This is a local draft only -- do not commit it.

Check the length with `wc -w "gdb/{branch_name}.md"`. Over 300 words, shorten the draft and check
again before Step 4; report the final count with the draft in Step 5.

### Step 4: Attach Test Evidence (Optional)

Skip this step when `verification_test_cases` is empty.

If the user already provided test evidence entries, use those without asking again. Otherwise ask
one combined question:

```yaml
header: "Test Evidence"
question: "Provide repeatable `#{test_case_order} descriptions-or-image-paths` entries, for example `#1 Payment reached COMPLETED /tmp/payment-success.png`, or select No Evidence."
options:
  - label: "No Evidence"
    description: "Continue without uploading test evidence"
```

The custom response may repeat the same test-case order and may contain multiple descriptions,
image paths, or both. Interpret `#N` as the 1-based order of the test case in
`verification_test_cases`. Treat existing local file paths as images and all other content after
`#N` as user-supplied descriptions. Preserve quoted paths that contain spaces.

Reject entries whose `#N` does not identify a test case and ask the user to correct them
before continuing. If a test case has image paths but no description, ask only for the missing
description:

```yaml
header: "Evidence Description"
question: "What do the images for test case #{test_case_order} demonstrate, for example that the payment reached COMPLETED status?"
options: []
```

Do not ask for a description when the user included one with the evidence entries. Combine
repeated descriptions for the same test case in their supplied order. Upload every image path
associated with each test case:

```bash
python3 {SKILL_ROOT}/scripts/upload_evidence.py --file "{image_path}"
```

The script returns JSON:

```json
{
  "repo": "tranphucbol/preman-cli",
  "branch": "pr-evidence",
  "path": "evidence/tabstrip-after-f4f90315.png",
  "url": "https://raw.githubusercontent.com/tranphucbol/preman-cli/pr-evidence/evidence/tabstrip-after-f4f90315.png",
  "filename": "tabstrip-after.png",
  "reused": false,
  "markdown": "![tabstrip-after.png](https://raw.githubusercontent.com/.../tabstrip-after-f4f90315.png)"
}
```

Each image is one commit on the `pr-evidence` branch, created from the default branch on first
use and never merged, so evidence stays out of every PR diff. The path is keyed by a content
hash, so re-running the workflow on an unchanged image reuses the existing commit and reports
`"reused": true`. Override the branch or path with `--branch` and `--prefix`.

For each test case with evidence, place its descriptions and successfully uploaded images
directly beneath its checklist item. Do not create an `## Evidence` subsection -- this overrides
the template guidance that supporting evidence is added directly in GitHub only for evidence
supplied through this workflow. Use this structure:

```markdown
- [ ] {Test case}

  {User-supplied description explaining what the images demonstrate}

  {markdown image link returned by upload_evidence.py}
  {Additional markdown image links for this test case}
```

Include only successfully uploaded images. Preserve test cases without evidence as plain
unchecked checklist items. If the user selects "No Evidence" or provides no evidence entries,
leave the draft unchanged.

### Step 5: Check Draft

Check the draft yourself; do not ask the user to approve it. Evidence descriptions from Step 4
count toward the 300 words; when they push the draft past it, shorten it before continuing.
Report the title and the word count with the result in Step 6e, where the user can
ask for changes afterwards.

### Step 6: Create or Update PR

**a) Check if branch is pushed:**

```bash
git ls-remote --heads origin {current_branch}
```

If the branch is not on remote, or is behind the local branch, push it without asking:

```bash
git push -u origin {current_branch}
```

Push explicitly here rather than letting `gh pr create` push: `gh pr create` interactively
prompts to push or fork an unpushed branch, which would stall the workflow on `gh`'s own prompt.

**b) Detect an existing open PR for this branch:**

```bash
gh pr list --head {current_branch} --state open --json number,url,title,baseRefName,headRefName
```

- Empty array -> create (go to c)
- One entry -> ask to update (go to d)
- More than one entry -> ask the user to pick one first, same shape as d's question but with one
  option per PR (`#{number} -> {baseRefName}` as the label, `{title} -- {url}` as the description);
  this is rare on GitHub, where a head branch normally has at most one open PR, but a branch can
  legitimately be proposed against more than one base

**c) Create the pull request:**

```bash
gh pr create \
  --repo {repo} \
  --base {default_branch} \
  --head {current_branch} \
  --title "{pr_title}" \
  --body-file "gdb/{branch_name}.md"
```

`gh pr create` prints the new PR's URL on success. Report it as `Pull request created: {url}`.

**d) Confirm whether to update the existing PR:**

```yaml
header: "Existing PR"
question: "Update PR #{number} with the drafted description from `gdb/{branch_name}.md`?"
options:
  - label: "Yes, update (Recommended)"
    description: "Replace the stale PR description while keeping title `{existing_title}` and base `{baseRefName}`"
  - label: "No, leave unchanged"
    description: "Keep the existing PR description and only return its URL"
```

Do not update the pull request without explicit confirmation. If the user selects **Yes,
update**:

```bash
gh pr edit {number} --repo {repo} --body-file "gdb/{branch_name}.md"
```

This touches only the body. It MUST preserve the existing title, base branch, reviewers, labels,
milestone, and every other PR setting -- do not pass `--title` or `--base` here.

**e) Display the result:**

- Created: `Pull request created: {url}`
- Updated: `Pull request updated: {url}`
- Left unchanged: `Pull request unchanged: {url}`

## Key Notes

- `gh` owns auth end to end -- never read or set a token env var, never call the GitHub REST API
  with raw curl. `upload_evidence.py` shells out to `gh api` for exactly this reason.
- The `gdb/` folder is for local drafts only, shared with the `merge-request` skill. Add `gdb/` to
  `.gitignore` if not already present.
- Issue detection is a hint, not a requirement -- when the branch name carries no recognizable
  issue number, Step 2 is skipped and the summary is drafted purely from the git diff.
- Evidence images are not gists. GitHub has no scriptable attachment endpoint -- the web UI's
  drag-and-drop upload needs a browser session token, and `gh gist create` rejects binary files
  outright ("binary file not supported"). Committing to a branch is what is left.
- On a public repo the `raw.githubusercontent.com` URL is not access-controlled, so do not attach
  evidence containing secrets. On a private repo that URL requires a token, which means the image
  will not render for readers in the PR description at all -- attach evidence there only if the
  reader is expected to open the file in the repo.
- The evidence branch is the only place those images live. Deleting it breaks every embedded
  link in every PR description that used it.
- Existing PR detection considers only open PRs with the exact current head branch, mirroring the
  `merge-request` skill's source-branch match.
- Updating an existing PR replaces only its description and requires explicit user confirmation.
- The PR description uses the same markdown from the draft file without modification.
