### Installing the macOS app

The DMG below is **arm64 only** and ad-hoc signed rather than notarized. macOS quarantines anything a
browser downloaded, and Gatekeeper reports a quarantined ad-hoc-signed app as
`"preman" is damaged and can't be opened` rather than as merely unsigned. The app is not damaged.
Drag `preman.app` to `/Applications`, then clear the attribute the download added:

```sh
xattr -dr com.apple.quarantine /Applications/preman.app
```

Nothing inside the app changes; only that attribute is removed.

The CLI needs none of this:

```sh
npm i -g preman
```

---
