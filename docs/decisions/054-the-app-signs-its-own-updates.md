# 054: The app signs its own updates

Status: Accepted

## Decision

preman ships its own updater rather than Squirrel.Mac, and authenticates it with an Ed25519
signature preman owns.

`packages/desktop/src/main/update/` is four modules. `manifest.ts` verifies a small signed
document against a public key committed into the bundle; `eligibility.ts` decides whether this
install may be replaced at all; `swap.ts` generates the `/bin/sh` script that performs the
replacement; `updater.ts` is the only one of the four that touches Electron, the network or the
disk. Everything the updater needs — the paths, the version, the store — is an argument, the way
it is for `createDiagnostics` and `createHostRegistry`.

The manifest is fetched from
`https://github.com/<owner>/preman-cli/releases/latest/download/update-manifest.json`. It names the
version, the architecture, and the payload's URL, size and SHA-256. The signature covers the
manifest, not the payload; the SHA-256 is what chains the one signature to the 128MB beside it, and
it is computed streaming, chunk by chunk, during the download.

`electron-builder.yml` gains a `zip` target beside `dmg`. The DMG stays the first install; the ZIP
is the update payload, extracted with `ditto`.

Four guards refuse before anything is offered: not packaged, translocated or running from
`/Volumes/`, the parent directory not writable, or the wrong architecture. A root-owned bundle is
refused with a message pointing at the DMG.

preman never installs by itself. The check is automatic and can be turned off; the download and the
restart are two separate deliberate presses.

## Rationale

**Squirrel.Mac cannot update an ad-hoc-signed app, and no flag changes that.** Electron's built-in
`autoUpdater` and `electron-updater`'s darwin path both delegate to Squirrel.Mac, which calls
`SecStaticCodeCheckValidityWithErrors` on the downloaded bundle against a requirement derived from
the currently installed one. Apple's
[TN3127](https://developer.apple.com/documentation/technotes/tn3127-inside-code-signing-requirements)
states the constraint directly: "Ad hoc signed code … has a DR but it's tied to that specific
version of the code." Two ad-hoc builds of the same source have different code directory hashes, so
v2 can never satisfy v1's designated requirement, and unlike Windows there is no
`verifyUpdateCodeSignature: false` escape. Notarization is not a way round it either — Apple only
notarizes what a Developer ID signed. ADR 018 declined to own a signing identity, and that decision
stands; this is what the app can do without one.

**A custom updater is not blocked by macOS.** Apple publishes
[Updating Mac Software](https://developer.apple.com/documentation/security/updating-mac-software),
which recommends staging the new version and replacing it atomically rather than modifying a bundle
in place. That is exactly what `swap.ts` does, and there are shipping precedents at this same
intersection: WatchTower replaced Squirrel.Mac with a detached DMG-swap helper for precisely this
reason, and metacodex and OpenFlow both ship ad-hoc and verify against a key embedded in the app.

**The signature covers the manifest and not the payload**, so version, architecture and eligibility
are all decided before 128MB is fetched. A checksum published beside a zip would be worth nothing —
whoever can alter one can alter the other — but a checksum inside a signed document is the
signature reaching the bytes.

**A prerelease publishes no manifest at all.** Same reasoning `release.yml` already applies to npm's
dist-tag: a release candidate must not become the thing existing installs upgrade to.
`releases/latest/download/…` only ever resolves to a full release, so the URL enforces this by
construction as well as the workflow's `if:`.

**The swap is a shell script, not Node**, because the Node it would need is inside the bundle being
replaced. It waits for the old process to exit — never kills it — then `mv target → target.old`,
`mv staged → target`, tests that `Contents/MacOS/preman` is executable, and renames the backup back
if it is not. The window in which nothing is installed at the target path is two renames wide, and
the rollback closes it. It also removes the staging directory on its way out, on both paths: the
rename takes the bundle _out_ of that directory and leaves it behind, and by then the process that
created it has quit, so nothing else is alive to clean up. `test/desktop.update.test.ts` runs the
generated script for real against two directories in a temporary directory, because this is the one
piece of preman that can leave a user with no installed copy of it and a quoting bug is invisible
to a string comparison — and because reading the script is demonstrably not enough: the leftover
staging directory was found by installing an update, not by review.

**Staging happens beside the target bundle, never in `$TMPDIR` and never in
`~/Library/Caches/<bundle-id>`.** A temporary directory can be on another volume, which would turn
the final rename into a 317MB copy and lose the atomicity the whole design rests on.
[Sparkle#2880](https://github.com/sparkle-project/Sparkle/issues/2880) reports `EPERM` creating an
installation cache under macOS 26's app-bound data protection; staging in a temporary directory was
their fix, and the general lesson — a path the system keys to your code identity is a path that can
be taken away from you — is why the cache directory is ruled out here by name.

**The update state is one discriminated union on one channel**, so the renderer never derives a
phase from two fields that can disagree. `AGENTS.md`'s file-per-subscription rule gives it one
store, and `model/update.ts` holds the sentences so the Settings section and the banner cannot say
two different things about one state.

## Consequences

**The Ed25519 private key becomes preman's distribution root key.** There is no Gatekeeper behind
it and no revocation path. A leak is silent remote code execution on every install. Rotation does
not fix a leak either: an old build only trusts the key compiled into it, so rotating strands every
install that has not already updated. The mitigation is custody, not code — the `release` job runs
in a GitHub Environment, so editing a workflow is not by itself enough to sign something. Changing
`UPDATE_PUBLIC_KEY` is therefore a breaking change to the update path and not a housekeeping
commit.

**macOS will re-prompt for permissions after every update.** TCC keys a grant to the app's
designated requirement, which for ad-hoc code is a hash that changes on every build. preman points
at `localhost` and LAN services constantly, so the Local Network prompt introduced in macOS 15 is
the one users will meet. The Settings section says so before the restart; nothing short of a
Developer ID prevents it.

**On macOS 26 this may cost users their workspace list, and that risk is unspiked.** If app-bound
data protection covers `~/Library/Application Support/preman` the way Sparkle#2880 shows it covering
`~/Library/Caches`, a self-updated build with a new cdhash may be denied its own `state.json`.
`store.ts` now separates an `EACCES` from a parse failure and reports the former, which turns the
silent case into a loud one — the only mitigation available without a stable code identity. If
users report a missing workspace list after upgrading, that log line is what will say so.

**A replayed manifest can pin a user to an old version.** An attacker who can serve a stale but
validly signed manifest performs a freeze attack. Accepted: TUF-grade rollback protection is out of
proportion to a threat model whose CDN is GitHub over TLS. `verifyManifest` does refuse an actual
downgrade, which is the cheaper half of the same defence.

**Non-admin users get no in-app update.** On a machine where an administrator installed preman into
`/Applications`, a standard user cannot write the bundle. The app says so and points at the DMG
rather than running `osascript … with administrator privileges`: a root shell spawned by an app with
no code signature is a worse bargain than an occasional manual install. The limit is stated in prose,
the way ADR 032 stated the partial Linux watcher.

**Every update is the whole payload.** Blockmaps are Squirrel's format and preman does not speak it;
a custom delta scheme would be a second file format and a second thing that can corrupt an installed
app.

**Windows and Linux are unchanged, because there is nothing to change.** `electron-builder.yml`
produces no artifact for either, so `updateEligibility` answers `architecture` on anything that is
not arm64 macOS — which is the honest answer until a second target exists.

**ADR 018 keeps its file and its status.** Its "the app has no updater" consequence no longer holds,
and it now points here for what replaced it. ADR 002 assigned "the updater" to the main process as a
responsibility; this is that responsibility finally built, in the only shape ad-hoc signing allows.

**The banner grows a third tone.** `info` exists for a fact the user has to be told and can act on
where nothing is wrong, which today is exactly one thing. It wears the accent rather than a colour
of its own, because there is no `--color-info` in any of the forty-three palettes and adding one
would be forty-three generated files changed to tint one strip.

> Superseded by ADR 055. The announcement moved out of the banner and into the title bar, and the
> tone had no callers left, so `info` and `InfoIcon` are gone. Everything else in this record —
> the manifest, the key, the eligibility guards, the swap script, and "never without a press" —
> stands unchanged.
