#!/usr/bin/env bash
# The release body, printed to stdout: the macOS install note, what changed, and the compare link.
#
# `gh release create --generate-notes` is deliberately not used. It lists a pull request only when
# that pull request's *merge commit* is in the tagged range, which makes it silently empty for two
# things this repository does: tagging a commit whose history holds the branch commits rather than
# the merge (v0.2.0 shipped with no changelog for exactly this reason), and pushing straight to
# main, which no generator attributes to a pull request because there isn't one. Walking the
# commits and asking GitHub which pull request contains each one answers both, and a direct commit
# still gets a line instead of vanishing.
#
# Usage: release-notes.sh <tag> [owner/repo]. Needs `gh` authenticated and the full git history.
set -euo pipefail

tag=${1:?usage: release-notes.sh <tag> [owner/repo]}
repo=${2:-$(gh repo view --json nameWithOwner --jq .nameWithOwner)}
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

# The tag before this one, prereleases included, because that is the boundary a reader compares
# against: `v0.1.0`'s changelog starts where `v0.1.0-rc.1` ended.
previous=$(git describe --tags --abbrev=0 --match 'v*' "$tag^" 2>/dev/null || true)
range=$tag
[ -n "$previous" ] && range="$previous..$tag"

cat "$here/release-notes-macos.md"
printf '\n---\n\n## What'\''s Changed\n'

entries=0
seen=""
# Merges are skipped: the pull request they close is already one entry, and "Merge pull request #8"
# is not a description of anything.
while read -r sha; do
  [ -n "$sha" ] || continue
  pull=$(gh api "repos/$repo/commits/$sha/pulls" --jq '.[0] // empty | "\(.number)\t\(.title)\t\(.user.login)"' 2>/dev/null || true)

  if [ -n "$pull" ]; then
    number=${pull%%$'\t'*}
    without_number=${pull#*$'\t'}
    title=${without_number%%$'\t'*}
    login=${without_number##*$'\t'}
    # Several commits of one branch resolve to one pull request; the reader wants it once.
    case " $seen " in *" $number "*) continue ;; esac
    seen="$seen $number"
    printf '* %s by @%s in https://github.com/%s/pull/%s\n' "$title" "$login" "$repo" "$number"
  else
    login=$(gh api "repos/$repo/commits/$sha" --jq '.author.login // empty' 2>/dev/null || true)
    subject=$(git log -1 --format=%s "$sha")
    if [ -n "$login" ]; then
      printf '* %s by @%s in https://github.com/%s/commit/%s\n' "$subject" "$login" "$repo" "$sha"
    else
      printf '* %s in https://github.com/%s/commit/%s\n' "$subject" "$repo" "$sha"
    fi
  fi
  entries=$((entries + 1))
done <<EOF
$(git rev-list --reverse --no-merges "$range")
EOF

if [ -n "$previous" ]; then
  printf '\n**Full Changelog**: https://github.com/%s/compare/%s...%s\n' "$repo" "$previous" "$tag"
else
  printf '\n**Full Changelog**: https://github.com/%s/commits/%s\n' "$repo" "$tag"
fi

# A release whose changelog would be empty is a wrong tag, not a quiet release: the artifacts are
# about to be built from a commit that adds nothing to the last one.
if [ "$entries" -eq 0 ]; then
  echo "::error::no commits between ${previous:-the start of history} and $tag" >&2
  exit 1
fi
