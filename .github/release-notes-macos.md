### Installing the macOS app

The DMG below is **arm64 only** and ad-hoc signed rather than notarized. macOS quarantines anything a
browser downloaded, and Gatekeeper reports a quarantined ad-hoc-signed app as
`"preman" is damaged and can't be opened` rather than as merely unsigned. The app is not damaged.
Drag `preman.app` to `/Applications`, then clear the attribute the download added:

```sh
xattr -dr com.apple.quarantine /Applications/preman.app
```

Nothing inside the app changes; only that attribute is removed.

**This is for the first install only.** From then on preman checks for new versions itself and
offers to install them — Settings → Diagnostics → Updates, or the app menu's Check for Updates.
An update it downloads is verified against a signature preman ships the public half of, and it
never carries a quarantine attribute, so there is no `xattr` step the second time. macOS may ask
for Local Network access again afterwards: the new build is a different signature to the system,
and nothing about what preman does has changed.

The CLI needs none of this:

```sh
npm i -g preman
```

---
