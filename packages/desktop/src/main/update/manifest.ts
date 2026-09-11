/**
 * The small signed document that says a newer preman exists, and what makes it believable.
 *
 * Pure but for `node:crypto`: no `electron`, no `node:fs`, no network. Everything here is bytes in
 * and a verdict out, which is what lets the whole of it be exercised against a keypair generated
 * inside a test file rather than against a release that has to exist first.
 *
 * The signature covers this document and not the 128MB payload, so version, architecture and
 * eligibility are all decided before anything is fetched. The chain to the payload is
 * {@link UpdateManifest.asset}'s `sha256`: a checksum published beside a zip is worth nothing —
 * whoever can replace one can replace the other — but a checksum inside a signed manifest is the
 * signature reaching the bytes. See `docs/decisions/054`.
 */
import { createPublicKey, verify } from "node:crypto";

/**
 * The public half of preman's distribution root key, compiled into the bundle.
 *
 * Committed rather than fetched, which is the entire point: a key the app downloads is a key an
 * attacker can substitute. The private half lives in a GitHub Environment with required reviewers
 * and signs `update-manifest.json` in `release.yml`. There is no Gatekeeper behind this and no
 * revocation path — `docs/decisions/054` states that cost rather than burying it.
 *
 * Rotating strands every install that has not already updated, because an old build only trusts
 * the key compiled into it. So this constant changing is a breaking change to the update path, not
 * a housekeeping commit.
 */
export const UPDATE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAvX34Yx+ZWU3OBa32XAusbw9kGup4tRqqCoBDGC+LJu4=
-----END PUBLIC KEY-----
`;

/** The one shape this build knows how to read. A manifest that says anything else is refused. */
export const MANIFEST_SCHEMA = 1;
/** The one slice released today. `eligibility.ts` refuses the running app on the same grounds. */
const MANIFEST_ARCH = "arm64";

/**
 * What a release publishes beside its DMG.
 *
 * Deliberately small and deliberately boring. Anything that had to be interpreted — release notes
 * as markdown, a minimum supported version expressed as a range — would be logic running on input
 * that has only just been authenticated, and the point of this document is to be cheap to trust.
 */
export interface UpdateManifest {
  readonly schema: typeof MANIFEST_SCHEMA;
  readonly version: string;
  readonly arch: typeof MANIFEST_ARCH;
  readonly asset: {
    readonly url: string;
    readonly sizeBytes: number;
    /** Lowercase hex. What the download is checked against, chunk by chunk, as it arrives. */
    readonly sha256: string;
  };
  readonly notesUrl: string;
}

/**
 * Why a manifest was refused. Named rather than collapsed into one boolean, because each is a
 * different sentence: a bad signature is worth an `error` in the log, and being on the newest
 * version already is not worth saying at all.
 */
export const REJECTIONS = ["signature", "schema", "malformed", "architecture", "notNewer"] as const;
export type ManifestRejection = (typeof REJECTIONS)[number];

export type ManifestVerdict =
  | { readonly ok: true; readonly manifest: UpdateManifest }
  | { readonly ok: false; readonly reason: ManifestRejection; readonly detail: string };

/** The same shape `release.yml` validates a tag against, so the two cannot disagree about semver. */
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.]+))?$/;
/** Sixty-four lowercase hex digits, which is the only thing a SHA-256 can be. */
const SHA256 = /^[0-9a-f]{64}$/;
/** The payload is fetched over TLS from GitHub, and a manifest that says otherwise is not ours. */
const ASSET_URL_PREFIX = "https://";

const NO_PRERELEASE = undefined;
const SAME = 0;
const NEWER = 1;
const OLDER = -1;
const EMPTY_BYTES = 0;
const DECIMAL = 10;
/** `crypto.verify`'s algorithm argument for Ed25519, which carries its digest in the curve. */
const ED25519 = null;

const MAJOR = 1;
const MINOR = 2;
const PATCH = 3;
const PRERELEASE = 4;

/**
 * Semver, to the extent this project's tags use it.
 *
 * Local rather than a dependency, and not because a dependency would be heavy: `vite.shared.ts`
 * externalises builtins and the engine's runtime packages only, so anything imported here is
 * inlined into `main.js` and parsed on every cold start. Eight lines of arithmetic against a shape
 * `release.yml` already refuses to deviate from is the cheaper half of that trade.
 *
 * One rule beyond the numbers: a prerelease sorts below the release it is a candidate for, so
 * `1.2.0-rc.1` never displaces `1.2.0`. Nothing compares two prereleases by their identifiers,
 * because decision 6 means a prerelease publishes no manifest and can never be the offered side.
 */
export function compareVersions(left: string, right: string): number {
  const a = SEMVER.exec(left);
  const b = SEMVER.exec(right);
  if (a === null || b === null) return SAME;

  for (const part of [MAJOR, MINOR, PATCH]) {
    const difference = Number.parseInt(a[part] ?? "", DECIMAL) - Number.parseInt(b[part] ?? "", DECIMAL);
    if (difference !== SAME) return difference > SAME ? NEWER : OLDER;
  }

  const leftPre = a[PRERELEASE];
  const rightPre = b[PRERELEASE];
  if (leftPre === rightPre) return SAME;
  if (leftPre === NO_PRERELEASE) return NEWER;
  if (rightPre === NO_PRERELEASE) return OLDER;
  return leftPre < rightPre ? OLDER : NEWER;
}

function reject(reason: ManifestRejection, detail: string): ManifestVerdict {
  return { ok: false, reason, detail };
}

/**
 * Whether the parsed document is the shape this build reads, field by field.
 *
 * Hand-written rather than zod, for the reason {@link compareVersions} is hand-written: zod is
 * most of what `@preman/core/api/migrate.js` weighs and `main.ts` keeps it behind a dynamic import
 * precisely so a cold start does not parse it. A five-field document does not justify reversing
 * that.
 */
function looksLikeManifest(raw: unknown): raw is UpdateManifest {
  if (typeof raw !== "object" || raw === null) return false;
  const candidate = raw as Partial<UpdateManifest>;
  if (typeof candidate.version !== "string" || !SEMVER.test(candidate.version)) return false;
  if (typeof candidate.notesUrl !== "string") return false;
  const asset: unknown = candidate.asset;
  if (typeof asset !== "object" || asset === null) return false;
  const { url, sizeBytes, sha256 } = asset as Partial<UpdateManifest["asset"]>;
  if (typeof url !== "string" || !url.startsWith(ASSET_URL_PREFIX)) return false;
  if (typeof sizeBytes !== "number" || !Number.isInteger(sizeBytes) || sizeBytes <= EMPTY_BYTES) return false;
  return typeof sha256 === "string" && SHA256.test(sha256);
}

/**
 * Is this manifest ours, well formed, for this machine, and newer than what is running?
 *
 * The signature is checked **before** the body is parsed. Parsing unauthenticated input and then
 * verifying it is the wrong order: it puts a JSON parser, and everything a parse failure branches
 * into, on the far side of the only thing establishing that the bytes came from preman.
 */
export function verifyManifest(
  body: Uint8Array,
  signature: Uint8Array,
  currentVersion: string,
  /**
   * The trust anchor, defaulted to the committed one. A parameter only so that the suite can
   * generate its own keypair: a test that needed the production private key would be a test that
   * cannot run, and one that asserted only "this random signature is rejected" would never
   * exercise the accepting path at all. Nothing in `src/` ever passes it.
   */
  publicKeyPem: string | undefined = UPDATE_PUBLIC_KEY,
): ManifestVerdict {
  try {
    // `null` is how `node:crypto` spells Ed25519: the curve fixes the digest, so there is no
    // algorithm left to name. A malformed key or signature throws rather than answering false,
    // which is why the whole call is inside the `try` and not only the boolean.
    if (!verify(ED25519, body, createPublicKey(publicKeyPem), signature)) {
      return reject("signature", "the update manifest was not signed by preman");
    }
  } catch (cause) {
    return reject("signature", cause instanceof Error ? cause.message : "the signature could not be checked");
  }

  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(body).toString("utf8")) as unknown;
  } catch {
    return reject("malformed", "the update manifest is not JSON");
  }

  // Ahead of the field checks: a document from a future preman is expected to have fields this
  // build has never heard of, and "malformed" would be the wrong word for it.
  const schema: unknown = (raw as { schema?: unknown } | null)?.schema;
  if (schema !== MANIFEST_SCHEMA) {
    return reject("schema", `this build reads update manifests of schema ${String(MANIFEST_SCHEMA)}`);
  }
  const arch: unknown = (raw as { arch?: unknown }).arch;
  if (arch !== MANIFEST_ARCH) return reject("architecture", `the published update is for ${String(arch)}`);

  if (!looksLikeManifest(raw)) return reject("malformed", "the update manifest is missing a field it needs");

  const manifest: UpdateManifest = { ...raw, schema: MANIFEST_SCHEMA, arch: MANIFEST_ARCH };
  // Equal and lower both. A downgrade is refused rather than ignored: a replayed manifest is the
  // one attack this design accepts, and refusing to go backwards is the cheaper half of the
  // defence it declines to build in full.
  if (compareVersions(manifest.version, currentVersion) !== NEWER) {
    return reject("notNewer", `${manifest.version} is not newer than ${currentVersion}`);
  }

  return { ok: true, manifest };
}
