/**
 * Whether this copy of preman is one that may replace itself.
 *
 * Pure: it takes facts rather than reading them, so a translocated path is a string in a test
 * rather than a mounted disk image nobody can produce in CI. `updater.ts` is what asks the
 * operating system; this is what decides.
 *
 * Every guard fails closed. Apple publishes no supported API for detecting translocation — the
 * path is the only signal there is — so the check is a heuristic, and a heuristic that guessed
 * "eligible" would let the app move a bundle it is not running. See `docs/decisions/054`.
 */
import type { Ineligibility } from "@preman/desktop/preload/bridge.js";

/**
 * Where Gatekeeper runs an app it has not been told to trust: a read-only mount under
 * `/private/var/folders/…/AppTranslocation/…` whose path has nothing to do with where the user
 * put the app. Replacing anything relative to it would clobber a bundle we are not running.
 */
const TRANSLOCATION_MARKER = "/AppTranslocation/";
/** A mounted volume, which for this app means the DMG it was dragged out of and never moved from. */
const READ_ONLY_PREFIX = "/Volumes/";
/** The one slice `electron-builder.yml` produces. Everything else is honestly unsupported. */
const SUPPORTED_ARCH = "arm64";
/** The one platform with an artifact at all. `docs/plans/031` says why the others are out of scope. */
const SUPPORTED_PLATFORM = "darwin";
/** What a macOS application bundle is called, and the assertion decision 8 asks for. */
const BUNDLE_SUFFIX = ".app";
/** `Contents/MacOS/preman` — the three levels between the executable and the bundle. */
const EXECUTABLE_DEPTH = 3;
const PATH_SEPARATOR = "/";
const NOT_A_BUNDLE = null;

export interface UpdateFacts {
  /** `app.isPackaged`. A `bun run desktop` has no bundle to swap and must never try. */
  readonly packaged: boolean;
  /** The `.app`, resolved through symlinks. Never a hardcoded `/Applications/preman.app`. */
  readonly bundlePath: string;
  /** Whether the directory holding the bundle can be written. The swap is two renames in it. */
  readonly parentWritable: boolean;
  readonly arch: string;
  readonly platform: string;
}

/**
 * The bundle an executable belongs to, or `null` when it does not belong to one.
 *
 * Split out from {@link updateEligibility} because it is the one part that is arithmetic on a
 * string: main resolves `app.getPath("exe")` through `realpathSync` — under translocation the two
 * differ, and the resolved one is the truth — and hands the result here.
 */
export function bundlePathFrom(executablePath: string): string | null {
  const parts = executablePath.split(PATH_SEPARATOR);
  if (parts.length <= EXECUTABLE_DEPTH) return NOT_A_BUNDLE;
  const bundle = parts.slice(0, parts.length - EXECUTABLE_DEPTH).join(PATH_SEPARATOR);
  return bundle.endsWith(BUNDLE_SUFFIX) ? bundle : NOT_A_BUNDLE;
}

/**
 * Why this app may not update itself, or `null` if it may.
 *
 * Ordered by how fundamental the refusal is, so the reported reason is the one worth acting on: a
 * developer running from source is told that first and not that their architecture is wrong.
 */
export function updateEligibility(facts: UpdateFacts): Ineligibility | null {
  // The `.app` assertion rides with `packaged` rather than earning a reason of its own: both mean
  // "there is no installed application bundle here", and a second word for that would be a second
  // sentence the pane has to write.
  if (!facts.packaged || !facts.bundlePath.endsWith(BUNDLE_SUFFIX)) return "unpackaged";
  if (facts.platform !== SUPPORTED_PLATFORM || facts.arch !== SUPPORTED_ARCH) return "architecture";
  if (facts.bundlePath.includes(TRANSLOCATION_MARKER)) return "translocated";
  if (facts.bundlePath.startsWith(READ_ONLY_PREFIX)) return "readOnlyVolume";
  if (!facts.parentWritable) return "notWritable";
  return null;
}
