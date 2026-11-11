#!/usr/bin/env python3
"""Upload an evidence image to a dedicated repo branch and return its raw URL.

GitHub has no scriptable attachment endpoint. The web UI's drag-and-drop upload
needs a browser session token, and gists reject binary files outright
("binary file not supported"), so an image cannot live in one. What is left is
the repo itself: the Contents API commits the file to a branch that is never
merged, and `raw.githubusercontent.com` serves it back with the right
content-type, which is all a markdown image needs.

Everything goes through `gh`, which already owns auth (PAT, keyring, or OAuth
token), so this handles no token of its own.

The evidence branch is created from the default branch on first use and is
never merged, so evidence never appears in a PR's diff. Its history is the only
place these images live: deleting the branch breaks every embedded link in
every PR description that used it.
"""

import argparse
import base64
import hashlib
import json
import os
import subprocess
import sys

DEFAULT_BRANCH_NAME = "pr-evidence"
DEFAULT_PATH_PREFIX = "evidence"
# Enough of the digest to make a collision implausible, short enough to read.
HASH_LENGTH = 8
IMAGE_SUFFIXES = frozenset({".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"})


def run_gh(args: list, check: bool = True) -> tuple[int, str, str]:
    result = subprocess.run(["gh", *args], capture_output=True, text=True)
    if check and result.returncode != 0:
        print(f"Error: gh {' '.join(args)} failed: {result.stderr.strip()}", file=sys.stderr)
        sys.exit(1)
    return result.returncode, result.stdout.strip(), result.stderr.strip()


def gh_json(args: list) -> dict:
    _, out, _ = run_gh(args)
    try:
        return json.loads(out)
    except json.JSONDecodeError:
        print(f"Error: invalid JSON from gh {' '.join(args)}: {out}", file=sys.stderr)
        sys.exit(1)


def resolve_repo(repo: str) -> str:
    if repo:
        return repo
    return gh_json(["repo", "view", "--json", "nameWithOwner"])["nameWithOwner"]


def ensure_branch(repo: str, branch: str) -> None:
    """Create the evidence branch from the default branch when it is missing."""
    code, _, _ = run_gh(["api", f"repos/{repo}/git/ref/heads/{branch}"], check=False)
    if code == 0:
        return

    default_branch = gh_json(["repo", "view", repo, "--json", "defaultBranchRef"])["defaultBranchRef"]["name"]
    head_sha = gh_json(["api", f"repos/{repo}/git/ref/heads/{default_branch}"])["object"]["sha"]
    run_gh(["api", "-X", "POST", f"repos/{repo}/git/refs", "-f", f"ref=refs/heads/{branch}", "-f", f"sha={head_sha}"])


def upload_file(file_path: str, repo: str, branch: str, prefix: str, message: str) -> dict:
    if not os.path.isfile(file_path):
        print(f"Error: file not found: {file_path}", file=sys.stderr)
        sys.exit(1)

    with open(file_path, "rb") as handle:
        blob = handle.read()

    filename = os.path.basename(file_path)
    stem, suffix = os.path.splitext(filename)
    # The digest keys the path by content, so re-running the workflow on an
    # unchanged image reuses its commit instead of needing the existing blob's
    # sha to overwrite it.
    digest = hashlib.sha256(blob).hexdigest()[:HASH_LENGTH]
    path = f"{prefix}/{stem}-{digest}{suffix}" if prefix else f"{stem}-{digest}{suffix}"

    repo = resolve_repo(repo)
    ensure_branch(repo, branch)

    code, out, _ = run_gh(["api", f"repos/{repo}/contents/{path}?ref={branch}"], check=False)
    reused = code == 0
    if reused:
        download_url = json.loads(out)["download_url"]
    else:
        # Send the body through stdin: a base64 image passed as an argument
        # exceeds the OS argument size limit for files of a few hundred KB.
        body = json.dumps(
            {"message": message, "branch": branch, "content": base64.b64encode(blob).decode("ascii")}
        )
        args = ["api", "-X", "PUT", f"repos/{repo}/contents/{path}", "--input", "-"]
        result = subprocess.run(["gh", *args], input=body, capture_output=True, text=True)
        if result.returncode != 0:
            print(f"Error: gh {' '.join(args)} failed: {result.stderr.strip()}", file=sys.stderr)
            sys.exit(1)
        download_url = json.loads(result.stdout)["content"]["download_url"]

    is_image = suffix.lower() in IMAGE_SUFFIXES
    markdown = f"![{filename}]({download_url})" if is_image else f"[{filename}]({download_url})"

    return {
        "repo": repo,
        "branch": branch,
        "path": path,
        "url": download_url,
        "filename": filename,
        "reused": reused,
        "markdown": markdown,
    }


def main():
    parser = argparse.ArgumentParser(description="Upload an evidence file to a dedicated GitHub branch.")
    parser.add_argument("--file", required=True, help="Path to the file to upload")
    parser.add_argument("--repo", default="", help="OWNER/REPO (default: the repo gh resolves here)")
    parser.add_argument("--branch", default=DEFAULT_BRANCH_NAME, help=f"Evidence branch (default: {DEFAULT_BRANCH_NAME})")
    parser.add_argument("--prefix", default=DEFAULT_PATH_PREFIX, help=f"Path prefix (default: {DEFAULT_PATH_PREFIX})")
    parser.add_argument("--message", default="", help="Commit message")
    args = parser.parse_args()

    message = args.message or f"chore: add PR evidence {os.path.basename(args.file)}"
    print(json.dumps(upload_file(args.file, args.repo, args.branch, args.prefix, message), indent=2))


if __name__ == "__main__":
    main()
