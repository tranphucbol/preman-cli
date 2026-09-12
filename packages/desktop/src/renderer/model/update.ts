/**
 * The updater's phase, in words.
 *
 * Pure and no React, like everything else in `model/`: the window has two readers of the same
 * union — the Settings section and the chip in the title bar — and a sentence written twice is
 * a sentence that eventually says two different things about one state.
 *
 * Nothing here decides. The phase is main's; this only chooses which words go with it.
 */
import type { Ineligibility, UpdateStatus } from "@preman/desktop/preload/bridge.js";

/**
 * Why an app cannot replace itself, said as something the reader can act on.
 *
 * Each names the fix where there is one. `architecture` and `notWritable` have none from inside
 * the app — decision 10 refuses to ask for an administrator password — so they point at the DMG,
 * which is the honest answer.
 */
export const INELIGIBILITY_REASON: Readonly<Record<Ineligibility, string>> = {
  unpackaged: "This is a development build. Updates apply to the installed app only.",
  translocated: "macOS is running preman from a temporary copy. Move it to Applications and reopen it.",
  readOnlyVolume: "preman is running from a disk image. Drag it to Applications and reopen it.",
  notWritable: "preman cannot write to the folder it is installed in. Install the next version from the DMG.",
  architecture: "There is no published update for this machine. Install from the DMG when one appears.",
};

/**
 * The standing caveat on every update this app installs, shown once the payload is staged.
 *
 * macOS keys a permission grant to the app's designated requirement, which for ad-hoc-signed code
 * is a hash of the code itself — and that changes on every build. preman points at `localhost` and
 * at LAN services constantly, so the Local Network prompt is the one users will meet. Nothing short
 * of a Developer ID prevents it; saying so beforehand is the difference between a dialog someone
 * expects and an app that looks broken. Decision 22 in `docs/plans/031`.
 */
export const LOCAL_NETWORK_CAVEAT =
  "macOS may ask for Local Network access again after the update. It asks because the new build is a different signature to it, not because anything changed about what preman does.";

const BYTES_IN_MB = 1024 * 1024;
const MB_DECIMALS = 0;
const NO_CHIP = null;
const NOTHING_RECEIVED = 0;
const WHOLE = 100;

/** Megabytes, whole. A download this size is not interesting to a tenth of a megabyte. */
export function formatSize(bytes: number): string {
  return `${(bytes / BYTES_IN_MB).toFixed(MB_DECIMALS)} MB`;
}

/**
 * How far the download is, or `null` while the total is unknown.
 *
 * `null` rather than a guess: a response with no `content-length` is drawn as indeterminate, and a
 * progress bar that invents a denominator is a progress bar that jumps backwards.
 */
export function downloadPercent(status: UpdateStatus): number | null {
  if (status.phase !== "downloading" || status.totalBytes <= NOTHING_RECEIVED) return null;
  return Math.min(WHOLE, Math.round((status.receivedBytes / status.totalBytes) * WHOLE));
}

/** One line for the phase, for the Settings row that reports it. */
export function updateHeadline(status: UpdateStatus): string {
  switch (status.phase) {
    case "idle":
      return "Not checked yet";
    case "checking":
      return "Checking…";
    case "current":
      return "Up to date";
    case "unsupported":
      return INELIGIBILITY_REASON[status.reason];
    case "available":
      return `Version ${status.version} is available (${formatSize(status.sizeBytes)})`;
    case "downloading": {
      const percent = downloadPercent(status);
      return percent === null ? `Downloading ${status.version}…` : `Downloading ${status.version}… ${percent}%`;
    }
    case "ready":
      return `Version ${status.version} is ready to install`;
    case "failed":
      return status.message;
  }
}

export interface UpdateChip {
  /** The verb, in a title bar's worth of room: what the press does, or what is already happening. */
  readonly label: string;
  /**
   * Monospace beside the label: the shortest true thing. The version while there is a decision to
   * make about it, and how far the download has got once the decision is made — an id, never a
   * second sentence.
   */
  readonly detail: string;
  /** The whole sentence, for the tooltip. `updateHeadline` already writes it; this does not. */
  readonly title: string;
  /** What the press does, or `null` while a download is in flight and there is nothing to press. */
  readonly action: "download" | "install" | null;
}

/**
 * The chip in the title bar, or nothing.
 *
 * Three phases earn a place in the window's chrome and five do not. `idle`, `checking`, `current`
 * and `unsupported` are answers to a question nobody asked from here — the Settings section is
 * where someone who wants them goes looking. `failed` is not here either: a laptop that could not
 * reach GitHub has nothing for the user to do about it, and a permanent mark in the chrome saying
 * so is worse than a bar that at least went away.
 *
 * `downloading` _is_ here, which is the one thing the move changes rather than relocates. A bar
 * across the window could not show it — the user pressed the button that started it and a strip
 * reporting their own press back at them is noise — but the chip is the button they pressed, and a
 * control that vanishes on the press and reappears two minutes later as a different control is a
 * control that looks broken. It reports itself in place instead.
 */
export function updateChip(status: UpdateStatus): UpdateChip | null {
  if (status.phase === "available") {
    return { label: "Update", detail: status.version, title: updateHeadline(status), action: "download" };
  }
  if (status.phase === "downloading") {
    const percent = downloadPercent(status);
    return {
      label: "Downloading",
      // The version until a denominator exists, because a response with no `content-length` has no
      // percentage to state and an invented one jumps backwards.
      detail: percent === null ? status.version : `${percent}%`,
      title: updateHeadline(status),
      action: null,
    };
  }
  if (status.phase === "ready") {
    // Not "Restart": the one press in this app that quits it says what it quits for.
    return { label: "Restart to update", detail: status.version, title: updateHeadline(status), action: "install" };
  }
  return NO_CHIP;
}
