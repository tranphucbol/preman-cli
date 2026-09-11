/**
 * Write `update-manifest.json` for a release and sign it with preman's distribution key.
 *
 * Run from `release.yml`, once, immediately before `gh release create`. Everything it needs is an
 * environment variable, so the whole of the step is auditable in the workflow file rather than
 * spread between a script and its arguments:
 *
 *   TAG          the pushed tag, `v1.4.0`
 *   VERSION      the same thing without the `v`
 *   REPOSITORY   `owner/name`, which is `$GITHUB_REPOSITORY`
 *   ASSET        the path to the built `*-mac.zip`
 *   OUTPUT       where to write the manifest; the signature goes beside it with `.sig` appended
 *   PREMAN_UPDATE_KEY   the Ed25519 private key, PEM, from the environment's secret
 *
 * `node:crypto` and nothing else. Ed25519 needs no dependency, and a signing step that installed
 * one would be a signing step with a supply chain.
 *
 * The asset URL is derived from the tag rather than read back from the release, because the
 * release does not exist yet — `gh release create` is the next command, and it uploads this file
 * along with the zip. GitHub's download URL for a release asset is a pure function of the tag and
 * the file name, so there is no ordering problem to solve.
 */
import { createHash, createPrivateKey, sign } from "node:crypto";
import { createReadStream, statSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

const SCHEMA = 1;
const ARCH = "arm64";
const JSON_INDENT = 2;
const ENCODING = "utf8";
const SIGNATURE_SUFFIX = ".sig";
/** `crypto.sign`'s algorithm argument for Ed25519: the curve fixes the digest. */
const ED25519 = null;
const MISSING = undefined;

function required(name) {
  const value = process.env[name];
  if (value === MISSING || value === "") {
    console.error(`::error::${name} is not set; the update manifest cannot be written`);
    process.exit(1);
  }
  return value;
}

async function sha256(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

const tag = required("TAG");
const version = required("VERSION");
const repository = required("REPOSITORY");
const assetPath = required("ASSET");
const output = required("OUTPUT");
const key = required("PREMAN_UPDATE_KEY");

const { size } = statSync(assetPath);

const manifest = {
  schema: SCHEMA,
  version,
  arch: ARCH,
  asset: {
    url: `https://github.com/${repository}/releases/download/${tag}/${basename(assetPath)}`,
    sizeBytes: size,
    sha256: await sha256(assetPath),
  },
  notesUrl: `https://github.com/${repository}/releases/tag/${tag}`,
};

// The exact bytes that get signed are the exact bytes that get published. Serialised once and
// reused, never re-stringified: a second `JSON.stringify` with different spacing would produce a
// document the signature does not cover.
const body = Buffer.from(JSON.stringify(manifest, null, JSON_INDENT), ENCODING);
writeFileSync(output, body);
writeFileSync(output + SIGNATURE_SUFFIX, sign(ED25519, body, createPrivateKey(key)));

console.log(`wrote ${output} for ${version} (${String(size)} bytes, sha256 ${manifest.asset.sha256})`);
