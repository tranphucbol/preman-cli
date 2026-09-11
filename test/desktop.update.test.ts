/**
 * The app replacing itself, in the three pieces that can get it wrong.
 *
 * A keypair is generated inside this file and handed to `verifyManifest`. The committed public key
 * is never exercised against a real signature, deliberately: a test that needed the production
 * private key is a test that cannot run, and one that only asserted "a random signature is
 * rejected" would never take the accepting branch at all.
 *
 * The swap cases run the generated script for real, against two directories in a temporary
 * directory, with a pid that is genuinely alive or genuinely gone. This is the one piece of preman
 * that can leave a user with no installed copy of it, so it is tested by execution rather than by
 * comparing strings — a quoting bug is invisible to `toContain` and total to `/bin/sh`.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { bundlePathFrom, updateEligibility } from "@preman/desktop/main/update/eligibility.js";
import { verifyManifest, type ManifestRejection } from "@preman/desktop/main/update/manifest.js";
import { swapScript } from "@preman/desktop/main/update/swap.js";
import type { UpdateStatus } from "@preman/desktop/preload/bridge.js";

const RUNNING_VERSION = "1.2.3";
const NEWER_VERSION = "1.3.0";
const PEM = { type: "spki", format: "pem" } as const;
const ENCODING = "utf8";
const SHELL = "/bin/sh";
const SCRIPT_FILE = "swap.sh";
const SCRIPT_MODE = 0o755;
const EXECUTABLE_RELATIVE_PATH = "Contents/MacOS/preman";
/** A pid nothing can be running as: `kill -0 0` addresses the process group, not a process. */
const DEAD_PID = 999_999;
/** Long enough for the script to have got past the wait if it were going to. */
const NEVER_EXITS_MS = 1200;
const MANIFEST_URL = "https://example.invalid/update-manifest.json";
const SIGNATURE_URL = `${MANIFEST_URL}.sig`;
const STAGING_PREFIX = ".preman-update-";
const ASSET_URL = "https://example.invalid/preman-1.3.0-arm64-mac.zip";
const NOT_A_ZIP = "this is not a zip archive, and ditto will say so";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const OUR_KEY = publicKey.export(PEM).toString();
const OTHER = generateKeyPairSync("ed25519");

const dirs: string[] = [];

function temporary(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface ManifestOverrides {
  readonly schema?: unknown;
  readonly version?: string;
  readonly arch?: string;
}

function manifestBody(overrides: ManifestOverrides = {}): Buffer {
  return Buffer.from(
    JSON.stringify({
      schema: overrides.schema ?? 1,
      version: overrides.version ?? NEWER_VERSION,
      arch: overrides.arch ?? "arm64",
      asset: { url: ASSET_URL, sizeBytes: 128, sha256: "a".repeat(64) },
      notesUrl: "https://example.invalid/releases/tag/v1.3.0",
    }),
    ENCODING,
  );
}

function signed(body: Buffer, key = privateKey): Buffer {
  return sign(null, body, key);
}

function rejection(body: Buffer, signature: Buffer, current = RUNNING_VERSION): ManifestRejection | "accepted" {
  const verdict = verifyManifest(body, signature, current, OUR_KEY);
  return verdict.ok ? "accepted" : verdict.reason;
}

describe("what makes an update manifest believable", () => {
  it("givenAValidSignature_whenVerifyManifest_thenTheManifestIsReturned", () => {
    const body = manifestBody();

    const verdict = verifyManifest(body, signed(body), RUNNING_VERSION, OUR_KEY);

    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.manifest.version).toBe(NEWER_VERSION);
    // The one field that chains this document to the 128MB beside it.
    expect(verdict.manifest.asset.sha256).toBe("a".repeat(64));
  });

  it("givenATamperedBody_whenVerifyManifest_thenItIsRejectedAsSignature", () => {
    const body = manifestBody();
    const signature = signed(body);
    const tampered = manifestBody({ version: "9.9.9" });

    expect(rejection(tampered, signature)).toBe("signature");
  });

  it("givenASignatureFromAnotherKey_whenVerifyManifest_thenItIsRejectedAsSignature", () => {
    const body = manifestBody();

    // The whole threat model in one case: somebody who can serve the file cannot sign it.
    expect(rejection(body, signed(body, OTHER.privateKey))).toBe("signature");
  });

  it("givenAnUnknownSchema_whenVerifyManifest_thenItIsRejectedAsSchema", () => {
    const body = manifestBody({ schema: 2 });

    // Ahead of the field checks: a document from a future preman is *expected* to carry fields
    // this build has never heard of, and "malformed" would be the wrong word for that.
    expect(rejection(body, signed(body))).toBe("schema");
  });

  it("givenAnX64Manifest_whenVerifyManifest_thenItIsRejectedAsArchitecture", () => {
    const body = manifestBody({ arch: "x64" });

    expect(rejection(body, signed(body))).toBe("architecture");
  });

  it("givenTheRunningVersion_whenVerifyManifest_thenItIsRejectedAsNotNewer", () => {
    const body = manifestBody({ version: RUNNING_VERSION });

    expect(rejection(body, signed(body))).toBe("notNewer");
  });

  it("givenAnOlderVersion_whenVerifyManifest_thenTheDowngradeIsRejected", () => {
    const body = manifestBody({ version: "1.0.0" });

    // A replayed manifest is the one attack this design accepts. Refusing to go backwards is the
    // cheaper half of the defence it declines to build in full.
    expect(rejection(body, signed(body))).toBe("notNewer");
  });

  it("givenAPrereleaseOfTheRunningVersion_whenVerifyManifest_thenItIsRejectedAsNotNewer", () => {
    const body = manifestBody({ version: "1.3.0-rc.1" });

    // A prerelease sorts below its release, so `1.3.0-rc.1` is not newer than `1.3.0`. It should
    // never be offered anyway - decision 6 publishes no manifest for one - and this is the
    // belt-and-braces half of that.
    expect(rejection(body, signed(body), NEWER_VERSION)).toBe("notNewer");
  });

  it("givenBodyIsNotJson_whenVerifyManifest_thenTheSignatureIsCheckedFirst", () => {
    const body = Buffer.from("{ not json at all", ENCODING);

    // Unsigned garbage is refused as `signature`, not as `malformed`: parsing unauthenticated
    // input and verifying it afterwards puts a parser on the wrong side of the only thing
    // establishing that the bytes came from preman.
    expect(rejection(body, Buffer.alloc(64))).toBe("signature");
    // Signed garbage does reach the parser, which is what proves the order above is the order.
    expect(rejection(body, signed(body))).toBe("malformed");
  });
});

const ELIGIBLE = {
  packaged: true,
  bundlePath: "/Applications/preman.app",
  parentWritable: true,
  arch: "arm64",
  platform: "darwin",
} as const;

describe("whether this copy of preman may replace itself", () => {
  it("givenAnUnpackagedApp_whenUpdateEligibility_thenItIsUnpackaged", () => {
    expect(updateEligibility({ ...ELIGIBLE, packaged: false })).toBe("unpackaged");
  });

  it("givenATranslocatedPath_whenUpdateEligibility_thenItIsTranslocated", () => {
    const bundlePath = "/private/var/folders/ab/T/AppTranslocation/1E2D-4C/d/preman.app";

    // Apple publishes no supported detection API, so the path is the whole signal. It fails
    // closed, because the alternative is moving a bundle we are not running.
    expect(updateEligibility({ ...ELIGIBLE, bundlePath })).toBe("translocated");
  });

  it("givenAPathOnAMountedVolume_whenUpdateEligibility_thenItIsReadOnlyVolume", () => {
    expect(updateEligibility({ ...ELIGIBLE, bundlePath: "/Volumes/preman 1.2.3/preman.app" })).toBe("readOnlyVolume");
  });

  it("givenAnUnwritableParent_whenUpdateEligibility_thenItIsNotWritable", () => {
    // An admin installed it and a standard user is running it. Decision 10 refuses to ask for a
    // password, so this is where that refusal becomes a sentence rather than a failed rename.
    expect(updateEligibility({ ...ELIGIBLE, parentWritable: false })).toBe("notWritable");
  });

  it("givenAnX64Machine_whenUpdateEligibility_thenItIsArchitecture", () => {
    expect(updateEligibility({ ...ELIGIBLE, arch: "x64" })).toBe("architecture");
    expect(updateEligibility({ ...ELIGIBLE, platform: "linux" })).toBe("architecture");
  });

  it("givenAnInstalledArm64App_whenUpdateEligibility_thenItIsEligible", () => {
    expect(updateEligibility(ELIGIBLE)).toBeNull();
  });

  it("givenAnExecutableInsideABundle_whenResolved_thenTheBundleIsThreeLevelsUp", () => {
    expect(bundlePathFrom("/Applications/preman.app/Contents/MacOS/preman")).toBe("/Applications/preman.app");
    // Never a hardcoded path: an executable that is not inside a `.app` resolves to nothing, and
    // `updateEligibility` then refuses it rather than guessing where the bundle might be.
    expect(bundlePathFrom("/usr/local/bin/preman")).toBeNull();
  });
});

/** A bundle that launches, as far as the swap script is able to tell. */
function makeBundle(path: string): void {
  mkdirSync(join(path, "Contents", "MacOS"), { recursive: true });
  const executable = join(path, EXECUTABLE_RELATIVE_PATH);
  writeFileSync(executable, "#!/bin/sh\nexit 0\n");
  chmodSync(executable, SCRIPT_MODE);
}

function writeScript(dir: string, text: string): string {
  const path = join(dir, SCRIPT_FILE);
  writeFileSync(path, text);
  chmodSync(path, SCRIPT_MODE);
  return path;
}

interface StagedSwap {
  readonly root: string;
  readonly target: string;
  readonly staged: string;
  readonly staging: string;
}

/** A target and a staged replacement, side by side under a directory with a space in its name. */
function stagedSwap(): StagedSwap {
  // A space in the path on purpose: this is the assertion that quoting works, and it is the one
  // the string comparison below cannot make.
  const root = join(temporary("preman-swap-"), "My Apps");
  mkdirSync(root, { recursive: true });
  const target = join(root, "preman.app");
  const staging = join(root, `${STAGING_PREFIX}test`);
  const staged = join(staging, "preman.app");
  makeBundle(target);
  makeBundle(staged);
  writeFileSync(join(target, "which"), "old", ENCODING);
  writeFileSync(join(staged, "which"), "new", ENCODING);
  return { root, target, staged, staging };
}

/** The three paths the script is a function of, for a case that does not care about the fourth. */
function planFor(swap: StagedSwap, pid: number): Parameters<typeof swapScript>[0] {
  return { pid, bundlePath: swap.target, stagedPath: swap.staged, stagingPath: swap.staging };
}

describe("the swap, and its rollback", () => {
  it("givenAPathWithASpace_whenSwapScript_thenEveryPathIsQuoted", () => {
    const text = swapScript({
      pid: DEAD_PID,
      bundlePath: "/My Apps/preman.app",
      stagedPath: "/My Apps/.staging/new.app",
      stagingPath: "/My Apps/.staging",
    });

    // Nowhere does a bare path reach `sh` as two words. The rollback runs unattended with nobody
    // reading its stderr, so a quoting bug is a bundle silently not put back.
    expect(text).not.toMatch(/(?<!')\/My Apps/);
    expect(text).toContain("'/My Apps/preman.app'");
    expect(text).toContain("'/My Apps/.staging/new.app'");
    expect(text).toContain("'/My Apps/.staging'");
    expect(text).toContain(String.raw`'/My Apps/preman.app.old'`);
  });

  it("givenAStagedBundle_whenTheSwapScriptRuns_thenTheTargetIsReplaced", () => {
    const swap = stagedSwap();
    const { root, target } = swap;

    const run = spawnSync(SHELL, [writeScript(root, swapScript(planFor(swap, DEAD_PID)))]);

    expect(run.status).toBe(0);
    expect(readdirSync(target)).toContain("which");
    expect(readFileSync(join(target, "which"), ENCODING)).toBe("new");
    // The backup is gone only once the new bundle has been proved launchable.
    expect(existsSync(`${target}.old`)).toBe(false);
  });

  /*
   * Found by installing an update for real rather than by reading the script. The rename takes the
   * bundle *out* of the staging directory, so the directory itself survives it - and nothing else
   * is left alive to remove it, because the process that created it has quit. Every update would
   * have deposited another empty `.preman-update-<uuid>` beside the installed app, forever.
   */
  it("givenASuccessfulSwap_whenTheScriptFinishes_thenTheStagingDirectoryIsGone", () => {
    const swap = stagedSwap();

    spawnSync(SHELL, [writeScript(swap.root, swapScript(planFor(swap, DEAD_PID)))]);

    expect(existsSync(swap.staging)).toBe(false);
    expect(readdirSync(swap.root).filter((entry) => entry.startsWith(STAGING_PREFIX))).toEqual([]);
  });

  it("givenAStagedBundleWithNoExecutable_whenTheSwapScriptRuns_thenTheOriginalIsRestored", () => {
    const swap = stagedSwap();
    const { root, target, staged } = swap;
    rmSync(join(staged, EXECUTABLE_RELATIVE_PATH));

    const run = spawnSync(SHELL, [writeScript(root, swapScript(planFor(swap, DEAD_PID)))]);

    // The whole point of the two renames. A user whose update was corrupt still has preman.
    expect(run.status).toBe(1);
    expect(readFileSync(join(target, "which"), ENCODING)).toBe("old");
    expect(existsSync(`${target}.old`)).toBe(false);
    // The rollback cleans up after itself too, or a refused update is 317MB nobody asked for.
    expect(existsSync(swap.staging)).toBe(false);
  });

  it("givenAStaleDotOldDirectory_whenTheSwapScriptRuns_thenItIsReplaced", () => {
    const swap = stagedSwap();
    const { root, target } = swap;
    mkdirSync(`${target}.old`, { recursive: true });
    writeFileSync(join(`${target}.old`, "which"), "stale", ENCODING);

    const run = spawnSync(SHELL, [writeScript(root, swapScript(planFor(swap, DEAD_PID)))]);

    // A leftover from a run that died between the two renames must not make the second attempt
    // behave differently from the first, and `mv` onto an existing directory does not replace it.
    expect(run.status).toBe(0);
    expect(readFileSync(join(target, "which"), ENCODING)).toBe("new");
  });

  it("givenAProcessThatNeverExits_whenTheSwapScriptRuns_thenNothingIsTouched", async () => {
    const swap = stagedSwap();
    const { root, target, staged } = swap;
    // This test runner, which is emphatically still alive. The script never signals it: after
    // thirty seconds it gives up rather than killing anything, and the installed app is left
    // exactly as it was.
    const child = spawn(SHELL, [writeScript(root, swapScript(planFor(swap, process.pid)))]);

    await new Promise((resolve) => setTimeout(resolve, NEVER_EXITS_MS));

    expect(readFileSync(join(target, "which"), ENCODING)).toBe("old");
    expect(existsSync(staged)).toBe(true);
    expect(existsSync(`${target}.old`)).toBe(false);
    child.kill();
  });
});

/**
 * What `net.fetch` will answer, keyed by URL. Rewritten per test rather than reset, because a
 * route left over from the previous case is a test that passes for the wrong reason.
 */
let routes = new Map<string, Uint8Array>();

vi.mock("electron", () => ({
  net: {
    fetch: (url: string) => {
      const bytes = routes.get(url);
      if (bytes === undefined) return Promise.reject(new Error(`nothing is published at ${url}`));
      let sent = false;
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: () => String(bytes.byteLength) },
        arrayBuffer: () => Promise.resolve(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)),
        body: {
          getReader: () => ({
            read: () => {
              if (sent) return Promise.resolve({ done: true, value: undefined });
              sent = true;
              return Promise.resolve({ done: false, value: bytes });
            },
          }),
        },
      });
    },
  },
}));

// Imported after the mock, for the reason `desktop.hosts.test.ts` gives: `vi.mock` is hoisted, but
// a static import of a module that reaches `electron` at load would still be evaluated first.
const { createUpdater } = await import("@preman/desktop/main/update/updater.js");

/** A signed manifest naming a payload, published at the three URLs the updater asks for. */
function publish(payload: Uint8Array, sha256: string): Uint8Array {
  const body = Buffer.from(
    JSON.stringify({
      schema: 1,
      version: NEWER_VERSION,
      arch: "arm64",
      asset: { url: ASSET_URL, sizeBytes: payload.byteLength, sha256 },
      notesUrl: "https://example.invalid/releases/tag/v1.3.0",
    }),
    ENCODING,
  );
  routes = new Map<string, Uint8Array>([
    [MANIFEST_URL, body],
    [SIGNATURE_URL, signed(body)],
    [ASSET_URL, payload],
  ]);
  return body;
}

interface Attempt {
  readonly updater: ReturnType<typeof createUpdater>;
  readonly states: UpdateStatus[];
  readonly root: string;
  readonly bundlePath: string;
  readonly tempDir: string;
}

function attempt(): Attempt {
  const root = temporary("preman-updater-");
  const bundlePath = join(root, "preman.app");
  makeBundle(bundlePath);
  const tempDir = temporary("preman-updater-tmp-");
  const states: UpdateStatus[] = [];
  const updater = createUpdater({
    currentVersion: RUNNING_VERSION,
    manifestUrl: MANIFEST_URL,
    tempDir,
    packaged: true,
    bundlePath,
    arch: "arm64",
    platform: "darwin",
    pid: DEAD_PID,
    // The suite's own key, not the committed one: the private half of the committed key is not in
    // this repository, and a test that needed it is a test that cannot run.
    publicKey: OUR_KEY,
    write: () => undefined,
    onState: (state) => states.push(state),
    readSkipped: () => null,
    writeSkipped: () => undefined,
    markChecked: () => undefined,
  });
  return { updater, states, root, bundlePath, tempDir };
}

describe("downloading the payload the manifest names", () => {
  it("givenAMismatchedSha256_whenDownloading_thenThePayloadIsDeletedAndItFails", async () => {
    const payload = Buffer.from(NOT_A_ZIP, ENCODING);
    publish(payload, "b".repeat(64));
    const run = attempt();

    await run.updater.check("manual");
    await run.updater.download();

    // A checksum inside a signed manifest is the signature reaching the bytes. Failing it means
    // the payload is not what preman published, whatever the URL said.
    expect(run.states.at(-1)).toEqual({
      phase: "failed",
      message: "This update could not be verified.",
      details: ["The download did not match the signed manifest."],
    });
    expect(readdirSync(run.tempDir)).toEqual([]);
  });

  it("givenAFailedDownload_whenItSettles_thenTheStagingDirectoryIsRemoved", async () => {
    const payload = Buffer.from(NOT_A_ZIP, ENCODING);
    publish(payload, createHash("sha256").update(payload).digest("hex"));
    const run = attempt();

    await run.updater.check("manual");
    // The hash matches, so extraction is reached - and `ditto` refuses something that is not a
    // zip, which is the failure this case is about.
    await run.updater.download();

    expect(run.states.at(-1)?.phase).toBe("failed");
    // A 317MB directory left beside the app because a download failed is its own bug report.
    expect(readdirSync(run.root).filter((entry) => entry.startsWith(STAGING_PREFIX))).toEqual([]);
    expect(readdirSync(run.tempDir)).toEqual([]);
  });

  /*
   * The case above asserted only the phase, which is how the wrong sentence survived review: a
   * payload that arrived intact and matched the signed hash was reported as one that could not be
   * fetched. Found by pointing a real build at a real GitHub asset that was not a zip, and worth
   * the exactness here - "could not be fetched" sends the reader to debug a network that worked.
   */
  it("givenAnArchiveDittoRefuses_whenDownloading_thenItIsReportedAsUnpackableNotUnfetchable", async () => {
    const payload = Buffer.from(NOT_A_ZIP, ENCODING);
    publish(payload, createHash("sha256").update(payload).digest("hex"));
    const run = attempt();

    await run.updater.check("manual");
    await run.updater.download();

    expect(run.states.at(-1)).toEqual({
      phase: "failed",
      message: "This update could not be unpacked.",
      details: ["ditto exited with 1"],
    });
  });
});
