# Install

preman comes in two forms that read and write the same files: the `preman` CLI, published to npm,
and the desktop app, published as a macOS DMG on the
[Releases](https://github.com/tranphucbol/preman-cli/releases) page.

## The CLI

Requires Node.js 20 or later.

```sh
npm install -g preman
preman --help
```

`preman` searches upward from the current directory for `.postman/resources.yaml` or a
`postman/collections` directory. Use `-d <path>` to point it at another repository.

## The desktop app

| Platform              | Download                                                                                                        |
| :-------------------- | :-------------------------------------------------------------------------------------------------------------- |
| macOS (Apple silicon) | `preman-<version>-arm64.dmg` on the [latest release](https://github.com/tranphucbol/preman-cli/releases/latest) |

There is no Intel, universal, Windows or Linux build yet
([ADR 030](../decisions/030-ci-asserts-everything-but-the-clock.md)).

### Running the unsigned macOS app

The app is ad-hoc signed rather than notarized, because a Developer ID belongs to whoever ships the
build and not to this repository ([ADR 018](../decisions/018-what-goes-in-the-packaged-bundle.md)).
macOS quarantines anything a browser downloaded, and Gatekeeper reports a quarantined
ad-hoc-signed app as `"preman" is damaged and can't be opened` rather than as merely unsigned — so
drag `preman.app` to `/Applications`, then clear the attribute the download added:

```sh
xattr -dr com.apple.quarantine /Applications/preman.app
```

Nothing inside the app changes; only that attribute is removed.

## Updates

That is the first install only. From then on the app checks for new versions itself — the app
menu's **Check for Updates**, or Settings → Diagnostics → Updates, which also carries the switch
that turns the automatic check off. What it downloads is verified against an Ed25519 signature the
app ships the public half of, rather than by Squirrel.Mac, which cannot update an ad-hoc-signed app
at all ([ADR 054](../decisions/054-the-app-signs-its-own-updates.md)). Nothing installs itself: the
check is automatic, the download and the restart are two separate presses. macOS may ask for Local
Network access again after an update, because the new build is a different signature to it.

The CLI updates the way any npm package does: `npm install -g preman@latest`.

## Building from source

Requires Bun and Node.js 20.19 or later.

```sh
git clone https://github.com/tranphucbol/preman-cli.git
cd preman-cli
bun install
bun run build
cd packages/cli && npm link
```

The built `packages/cli/dist/preman.js` resolves runtime dependencies from `node_modules`; it is
not a standalone file. Keep it with the installed package, or install through npm so those
dependencies are present.

To build and launch the desktop app instead:

```sh
bun run desktop          # build the app and launch it
bun run desktop:package  # build, then wrap it into packages/desktop/release
```
