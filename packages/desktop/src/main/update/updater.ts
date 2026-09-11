/**
 * The only module in `update/` that touches Electron, the network or the disk.
 *
 * Everything it decides is decided somewhere else: `manifest.ts` says whether a document is
 * believable, `eligibility.ts` says whether this install may be replaced, `swap.ts` says how. What
 * is left here is sequence and I/O, and every dependency is an argument, so `main.ts` keeps owning
 * the paths the way it does for `createDiagnostics` and `createHostRegistry`.
 *
 * preman never installs an update by itself. The check is automatic and can be turned off; the
 * download and the restart are two separate deliberate clicks. A swap that fails takes the app with
 * it, and nobody should discover that on a machine they walked away from. See
 * `docs/decisions/054`.
 */
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { accessSync, chmodSync, constants, createWriteStream, readdirSync, rmSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { dirname, join } from "node:path";
import { net } from "electron";

import type { LogLevel } from "@preman/desktop/engine/protocol.js";
import type { UpdateStatus } from "@preman/desktop/preload/bridge.js";
import { updateEligibility } from "@preman/desktop/main/update/eligibility.js";
import { verifyManifest, type UpdateManifest } from "@preman/desktop/main/update/manifest.js";
import { swapScript } from "@preman/desktop/main/update/swap.js";

/** Where the payload lands. One name, so a second download overwrites the first rather than filling `$TMPDIR`. */
const ASSET_FILE = "preman-update.zip";
const SCRIPT_FILE = "preman-swap.sh";
/**
 * The staging directory's name, made unique per attempt.
 *
 * A dot prefix so Finder does not show a half-extracted app beside the real one in `/Applications`
 * for the ten seconds it exists.
 */
const STAGING_PREFIX = ".preman-update-";
/** Once a day. A release is not an event that happens hourly, and nor should the request be. */
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
/**
 * How long after the window has loaded the first check waits.
 *
 * It has to stay off the first-paint path decision 022 keeps synchronous, and off the quarter
 * second after it that `main.ts` spends overlapping the engine's start with Chromium's.
 */
const FIRST_CHECK_DELAY_MS = 10_000;
/**
 * How often a download reports progress, at most.
 *
 * A frame per chunk would flood the window for the same reason `engine/frames.ts` exists on the
 * other channel: 128MB arrives in tens of thousands of pieces and a progress bar redraws usefully
 * about ten times a second.
 */
const PROGRESS_INTERVAL_MS = 100;

/** The signature sits beside the manifest under the same release, one suffix apart. */
const SIGNATURE_SUFFIX = ".sig";
/**
 * `ditto`, never `unzip`. electron-builder's `zip` target writes the archive with `ditto`, and
 * `unzip` flattens the framework symlinks inside `Contents/Frameworks` — which produces a
 * directory that looks like an app and cannot launch.
 */
const EXTRACTOR = "ditto";
const EXTRACT_ARGS = ["-x", "-k"] as const;
const BUNDLE_SUFFIX = ".app";
const SHELL = "/bin/sh";
const SCRIPT_MODE = 0o755;
const HEX = "hex";
const CONTENT_LENGTH = "content-length";
const UNKNOWN_LENGTH = 0;
const DECIMAL = 10;
const NO_MANIFEST = null;
const NO_STAGED_BUNDLE = null;
const OK_EXIT = 0;

/** What a failure says when the cause carried no sentence of its own. */
const UNEXPECTED_FAILURE = "The update could not be fetched.";
/** The headline for anything that failed authenticity rather than transport. */
const UNVERIFIED_UPDATE = "This update could not be verified.";
const UNPACKABLE_UPDATE = "This update could not be unpacked.";

export interface Updater {
  /** The current phase, for a caller that has to answer synchronously. */
  readonly state: () => UpdateStatus;
  /**
   * Ask GitHub. `manual` differs from `automatic` in exactly one way — it reports "you are on the
   * newest version" rather than staying quiet — because a pressed button that says nothing reads
   * as a broken button.
   */
  check(trigger: "automatic" | "manual"): Promise<void>;
  download(): Promise<void>;
  /**
   * Hand the swap to a detached `/bin/sh` and answer whether it was handed over.
   *
   * Quitting is the caller's, because app lifecycle is `main.ts`'s and always has been — and
   * because a function that both spawns and quits could not be asked "did that work?".
   */
  install(): boolean;
  skip(version: string): void;
  /** Arm or disarm the periodic check. Idempotent; called again whenever the preference moves. */
  schedule(enabled: boolean): void;
  /** Drop the timers and any staged bundle. The window is gone and nobody is waiting for either. */
  stop(): void;
}

export interface UpdaterOptions {
  readonly currentVersion: string;
  readonly manifestUrl: string;
  /** `app.getPath("temp")`. Never `~/Library/Caches/<bundle-id>` — Sparkle#2880. */
  readonly tempDir: string;
  readonly packaged: boolean;
  /** The `.app` this process is running out of, already resolved through symlinks by `main.ts`. */
  readonly bundlePath: string;
  readonly arch: string;
  readonly platform: string;
  readonly write: (level: LogLevel, line: string) => void;
  readonly onState: (state: UpdateStatus) => void;
  readonly readSkipped: () => string | null;
  readonly writeSkipped: (version: string | null) => void;
  /** Record that a check happened, so a restart every ten minutes is not a check every ten minutes. */
  readonly markChecked: () => void;
  /** `process.pid`, passed in so the generated script is a function of its arguments. */
  readonly pid: number;
  /**
   * The trust anchor, defaulted to the committed one by `manifest.ts`. Present for the same reason
   * `verifyManifest`'s own parameter is — a suite has to be able to sign something — and nothing
   * in `src/` passes it.
   */
  readonly publicKey?: string;
}

/** Whether the directory holding the bundle takes the two renames the swap is made of. */
function writable(directory: string): boolean {
  try {
    accessSync(directory, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function sentence(cause: unknown): string {
  return cause instanceof Error ? cause.message : UNEXPECTED_FAILURE;
}

export function createUpdater(options: UpdaterOptions): Updater {
  let status: UpdateStatus = { phase: "idle" };
  let offered: UpdateManifest | null = NO_MANIFEST;
  let stagedBundle: string | null = NO_STAGED_BUNDLE;
  let stagingDir: string | null = NO_STAGED_BUNDLE;
  let busy = false;
  let firstCheck: ReturnType<typeof setTimeout> | undefined;
  let repeat: ReturnType<typeof setInterval> | undefined;

  function report(next: UpdateStatus): void {
    status = next;
    options.onState(next);
  }

  /**
   * Throw away whatever was extracted.
   *
   * Called on every terminal state but `ready`: a 317MB directory left in `/Applications` because
   * a download failed is its own bug report, and the next attempt stages afresh anyway.
   */
  function discardStaging(): void {
    if (stagingDir !== NO_STAGED_BUNDLE) rmSync(stagingDir, { recursive: true, force: true });
    stagingDir = NO_STAGED_BUNDLE;
    stagedBundle = NO_STAGED_BUNDLE;
  }

  function fail(message: string, details: readonly string[]): void {
    discardStaging();
    report({ phase: "failed", message, details });
  }

  async function fetchBytes(url: string): Promise<Uint8Array> {
    // `net.fetch` and not the global one: it routes through Chromium's network stack, so it
    // honours the system proxy and the machine's own certificate trust. Node's `fetch` does not.
    const response = await net.fetch(url);
    if (!response.ok) throw new Error(`${url} answered ${String(response.status)}`);
    return new Uint8Array(await response.arrayBuffer());
  }

  /** The four guards, asked of the machine as it is now rather than as it was at launch. */
  function ineligibility(): ReturnType<typeof updateEligibility> {
    return updateEligibility({
      packaged: options.packaged,
      bundlePath: options.bundlePath,
      parentWritable: writable(dirname(options.bundlePath)),
      arch: options.arch,
      platform: options.platform,
    });
  }

  async function check(trigger: "automatic" | "manual"): Promise<void> {
    if (busy) return;
    busy = true;
    report({ phase: "checking" });
    try {
      const [body, signature] = await Promise.all([
        fetchBytes(options.manifestUrl),
        fetchBytes(options.manifestUrl + SIGNATURE_SUFFIX),
      ]);
      options.markChecked();

      const verdict = verifyManifest(body, signature, options.currentVersion, options.publicKey);
      if (!verdict.ok) {
        // Already on the newest build, which is the ordinary answer and not a failure.
        if (verdict.reason === "notNewer") {
          report({ phase: "current" });
          return;
        }
        // A signature that does not verify is the one outcome worth an `error`: it means either a
        // release was published wrong or something between here and GitHub rewrote the answer.
        // Decision 035 forbids logging workspace traffic; an update check is not that, and 054
        // says so rather than leaving the next reader to infer it.
        options.write(
          verdict.reason === "signature" ? "error" : "warn",
          `the update manifest was rejected as ${verdict.reason}: ${verdict.detail}`,
        );
        report({ phase: "failed", message: UNVERIFIED_UPDATE, details: [verdict.detail] });
        return;
      }

      const manifest = verdict.manifest;
      // A skipped version is not news, and a manual check does not un-skip it: the way back is the
      // next release, or the Settings pane, which always names the version it found.
      if (manifest.version === options.readSkipped()) {
        report({ phase: "current" });
        return;
      }

      const refusal = ineligibility();
      if (refusal !== null) {
        // Reported rather than swallowed. A user who dragged the app to their Desktop, or who is
        // still running it out of the DMG, deserves to be told that is why nothing is offered.
        report({ phase: "unsupported", reason: refusal });
        return;
      }

      offered = manifest;
      report({
        phase: "available",
        version: manifest.version,
        notesUrl: manifest.notesUrl,
        sizeBytes: manifest.asset.sizeBytes,
      });
    } catch (cause) {
      // `warn` and not `error`: a laptop on a train cannot reach GitHub, and that is not a defect.
      options.write("warn", `the update check did not complete: ${sentence(cause)}`);
      // The guards are asked after the manifest normally, so that an install which cannot update
      // is not nagged about it while there is nothing to install anyway. When the fetch itself
      // failed there is no such thing to weigh, and the local fact is the better answer: it is
      // certain, it is permanent, and it is the one the reader can act on. "Could not be fetched"
      // sends someone running from a disk image to go and look at their network.
      const refusal = ineligibility();
      if (refusal !== null) {
        report({ phase: "unsupported", reason: refusal });
        return;
      }
      // A background check that could not reach the network says nothing to the window. A pressed
      // button has to answer, because a control that does nothing reads as a broken control.
      report(
        trigger === "manual"
          ? { phase: "failed", message: UNEXPECTED_FAILURE, details: [sentence(cause)] }
          : { phase: "idle" },
      );
    } finally {
      busy = false;
    }
  }

  /**
   * Stream the payload to disk, hashing it as it arrives.
   *
   * Chunk by chunk into one `createHash`, so there is no second pass over 128MB and no point at
   * which the whole archive is a `Buffer` in the main process — decision 016's budgets are about
   * this process, and a 128MB allocation in it would be visible in the Resources tab.
   */
  async function fetchAsset(manifest: UpdateManifest, assetPath: string): Promise<string> {
    const response = await net.fetch(manifest.asset.url);
    if (!response.ok) throw new Error(`${manifest.asset.url} answered ${String(response.status)}`);
    const body = response.body;
    if (body === null) throw new Error("the update download carried no body");

    const declared = response.headers.get(CONTENT_LENGTH);
    const totalBytes = declared === null ? manifest.asset.sizeBytes : Number.parseInt(declared, DECIMAL);
    const hash = createHash("sha256");
    const file = createWriteStream(assetPath);
    // Narrowed on the way in: Electron types the body as a stream of `any`, and every use of a
    // chunk below - the hash, the byte count, the write - would otherwise be unchecked.
    const reader = (body as ReadableStream<Uint8Array>).getReader();
    let receivedBytes = UNKNOWN_LENGTH;
    let lastFrame = UNKNOWN_LENGTH;

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        hash.update(value);
        receivedBytes += value.byteLength;
        if (!file.write(value)) await once(file, "drain");
        const now = Date.now();
        if (now - lastFrame >= PROGRESS_INTERVAL_MS) {
          lastFrame = now;
          report({ phase: "downloading", version: manifest.version, receivedBytes, totalBytes });
        }
      }
    } finally {
      file.end();
    }
    await once(file, "finish");
    return hash.digest(HEX);
  }

  /** `ditto` as a promise. A child process, so 128MB of inflation is not on the main thread. */
  function extract(zipPath: string, into: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(EXTRACTOR, [...EXTRACT_ARGS, zipPath, into], { stdio: "ignore" });
      child.on("error", reject);
      child.on("exit", (code) => {
        if (code === OK_EXIT) resolve();
        else reject(new Error(`${EXTRACTOR} exited with ${String(code)}`));
      });
    });
  }

  async function download(): Promise<void> {
    const manifest = offered;
    if (manifest === NO_MANIFEST || busy) return;
    busy = true;
    const assetPath = join(options.tempDir, ASSET_FILE);
    try {
      report({
        phase: "downloading",
        version: manifest.version,
        receivedBytes: UNKNOWN_LENGTH,
        totalBytes: manifest.asset.sizeBytes,
      });
      const digest = await fetchAsset(manifest, assetPath);
      if (digest !== manifest.asset.sha256) {
        rmSync(assetPath, { force: true });
        options.write("error", "the update payload did not match the hash the signed manifest names");
        fail(UNVERIFIED_UPDATE, ["The download did not match the signed manifest."]);
        return;
      }

      // Beside the target bundle, not in `$TMPDIR`: a temporary directory can be on another
      // volume, which would make the final `mv` a copy of 317MB rather than a rename. Same-volume
      // renames are the whole reason the swap is atomic.
      discardStaging();
      stagingDir = join(dirname(options.bundlePath), STAGING_PREFIX + randomUUID());
      try {
        await extract(assetPath, stagingDir);
      } catch (cause) {
        // Not "could not be fetched": the bytes arrived and matched the hash the signed manifest
        // names, so the network did its job and saying otherwise sends the reader to debug it.
        // What is wrong is the archive, which is the publisher's mistake and not theirs.
        options.write("error", `the update could not be unpacked: ${sentence(cause)}`);
        fail(UNPACKABLE_UPDATE, [sentence(cause)]);
        return;
      } finally {
        rmSync(assetPath, { force: true });
      }

      const found = readdirSync(stagingDir).find((entry) => entry.endsWith(BUNDLE_SUFFIX));
      if (found === undefined) {
        fail(UNPACKABLE_UPDATE, ["The archive held no application bundle."]);
        return;
      }
      stagedBundle = join(stagingDir, found);
      report({ phase: "ready", version: manifest.version });
    } catch (cause) {
      rmSync(assetPath, { force: true });
      options.write("error", `the update download failed: ${sentence(cause)}`);
      fail(UNEXPECTED_FAILURE, [sentence(cause)]);
    } finally {
      busy = false;
    }
  }

  return {
    state: () => status,
    check,
    download,

    /**
     * Write the script, detach it, and quit.
     *
     * `detached` with `stdio: "ignore"` and an `unref()` is what lets `/bin/sh` outlive the
     * process that spawned it — which it must, because the first thing it does is wait for that
     * process to be gone.
     */
    install() {
      if (stagedBundle === NO_STAGED_BUNDLE || stagingDir === NO_STAGED_BUNDLE) return false;
      const scriptPath = join(options.tempDir, SCRIPT_FILE);
      writeFileSync(
        scriptPath,
        swapScript({
          pid: options.pid,
          bundlePath: options.bundlePath,
          stagedPath: stagedBundle,
          // Handed over so the script can remove it: the rename moves the bundle out and leaves
          // the directory, and by then this process is gone and cannot clean up after itself.
          stagingPath: stagingDir,
        }),
      );
      chmodSync(scriptPath, SCRIPT_MODE);
      const child = spawn(SHELL, [scriptPath], { detached: true, stdio: "ignore" });
      child.unref();
      options.write("info", "handing over to the update swap script");
      // The staging directory is now the installed app's to become, so it must survive `stop()`.
      stagingDir = NO_STAGED_BUNDLE;
      return true;
    },

    skip(version) {
      options.writeSkipped(version);
      offered = NO_MANIFEST;
      discardStaging();
      report({ phase: "current" });
    },

    schedule(enabled) {
      clearTimeout(firstCheck);
      clearInterval(repeat);
      firstCheck = undefined;
      repeat = undefined;
      if (!enabled) return;
      firstCheck = setTimeout(() => {
        void check("automatic");
        repeat = setInterval(() => {
          void check("automatic");
        }, CHECK_INTERVAL_MS);
      }, FIRST_CHECK_DELAY_MS);
    },

    stop() {
      clearTimeout(firstCheck);
      clearInterval(repeat);
      firstCheck = undefined;
      repeat = undefined;
      // A staged bundle that nobody chose to install is 317MB beside the app. `ready` survives a
      // closed window on macOS, but not a quit, and the directory must not.
      discardStaging();
    },
  };
}
