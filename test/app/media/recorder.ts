/**
 * Recording the app's window into a GIF under `docs/media/`.
 *
 * Frames come from the DevTools screencast rather than a screen grab: it sees the web contents at
 * their own pixel size on any OS, under Xvfb or not, and needs no screen-recording permission.
 * The cost is that it sees only the web contents, so a GIF has no title bar - which is also what
 * makes one recorded on Linux look like one recorded on macOS.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { CDPSession } from "playwright-core";
import type { LaunchedApp } from "../harness.js";
import { concatList, type Frame } from "./timeline.js";

export const MEDIA_DIRECTORY = resolve(import.meta.dirname, "../../../docs/media");
/** A README is read on a phone too; past ~2 MiB a GIF is a page that will not load. */
export const GIF_MAX_BYTES = 2 * 1024 * 1024;
const GIF_WIDTH_PX = 1100;
const GIF_FPS = 12;
const FRAMES_PREFIX = "preman-readme-frames-";
const FRAME_DIGITS = 5;
const CONCAT_FILE = "frames.ffconcat";
const FFMPEG = "ffmpeg";
const FFMPEG_MISSING =
  "ffmpeg is not on PATH. Install it (`brew install ffmpeg`, `apt install ffmpeg`) or run `bun run readme:media`, whose box has it.";
/**
 * Two passes in one graph: a palette built from what changes between frames, then dithered onto.
 * `diff` keeps the palette for the moving part rather than the static chrome around it, and
 * `rectangle` re-encodes only that part, which is most of why a 20-second GIF stays under 2 MiB.
 */
const GIF_FILTER =
  `fps=${GIF_FPS},scale=${GIF_WIDTH_PX}:-1:flags=lanczos,` +
  "split[frames][copy];[copy]palettegen=stats_mode=diff[palette];" +
  "[frames][palette]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle";
const NUDGE_INTERVAL_MS = 50;
const NUDGE_DEADLINE_MS = 3_000;
const MS_PER_SECOND = 1000;
/**
 * Flips a one-pixel element so Chromium paints, and so sends a frame. Without it a still screen
 * sends none, and the recording would end on whatever repainted last rather than on the result.
 */
const NUDGE_SCRIPT = `(() => {
  let dot = document.getElementById("readme-nudge");
  if (!dot) {
    dot = document.createElement("div");
    dot.id = "readme-nudge";
    // Painted, or there is nothing for the opacity to change and so no damage to send.
    dot.style.cssText = "position:fixed;left:0;top:0;width:1px;height:1px;background:#000;pointer-events:none;z-index:2147483647";
    document.body.appendChild(dot);
  }
  dot.style.opacity = dot.style.opacity === "0.01" ? "0.02" : "0.01";
})()`;

interface ScreencastFrameEvent {
  data: string;
  sessionId: number;
  metadata: { timestamp?: number };
}

export interface Recording {
  /** Stops the screencast and writes `docs/media/<name>.gif`. */
  stop(name: string, maxFrameSeconds?: number): Promise<RecordedMedia>;
}

export interface RecordedMedia {
  path: string;
  bytes: number;
  seconds: number;
}

export function requireFfmpeg(): void {
  const probe = spawnSync(FFMPEG, ["-version"], { stdio: "ignore" });
  if (probe.error !== undefined || probe.status !== 0) throw new Error(FFMPEG_MISSING);
}

/**
 * A screencast throttles a window it believes is hidden, and the box's window is never in front
 * of anyone. Both are switched off so a frame arrives whenever the page paints.
 */
async function keepPainting(launched: LaunchedApp): Promise<void> {
  await launched.app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window?.setAlwaysOnTop(true, "floating");
    window?.webContents.setBackgroundThrottling(false);
  });
}

export async function startRecording(launched: LaunchedApp): Promise<Recording> {
  await keepPainting(launched);
  const { page } = launched;
  const directory = mkdtempSync(join(tmpdir(), FRAMES_PREFIX));
  const frames: Frame[] = [];
  let stopped = false;
  const session: CDPSession = await page.context().newCDPSession(page);
  session.on("Page.screencastFrame", (event: ScreencastFrameEvent) => {
    // A frame already in flight when the screencast stopped lands after its directory is gone.
    if (stopped) return;
    const file = `frame-${String(frames.length).padStart(FRAME_DIGITS, "0")}.png`;
    writeFileSync(join(directory, file), Buffer.from(event.data, "base64"));
    frames.push({ file, timestamp: event.metadata.timestamp ?? Date.now() / MS_PER_SECOND });
    void session.send("Page.screencastFrameAck", { sessionId: event.sessionId }).catch(() => undefined);
  });
  await session.send("Page.startScreencast", { format: "png", everyNthFrame: 1 });
  await waitForFreshFrame(launched, frames);

  return {
    async stop(name, maxFrameSeconds) {
      try {
        await waitForFreshFrame(launched, frames);
        const endSeconds = frames[frames.length - 1]?.timestamp ?? 0;
        stopped = true;
        await session.send("Page.stopScreencast");
        await session.detach();
        const list = concatList(frames, endSeconds, maxFrameSeconds);
        writeFileSync(join(directory, CONCAT_FILE), list.script);
        const path = join(MEDIA_DIRECTORY, `${name}.gif`);
        encode(directory, path);
        return { path, bytes: statSync(path).size, seconds: list.seconds };
      } finally {
        stopped = true;
        rmSync(directory, { recursive: true, force: true });
      }
    },
  };
}

/** Nudges until a frame newer than the last one arrives, so the GIF starts and ends on what is shown. */
async function waitForFreshFrame(launched: LaunchedApp, frames: readonly Frame[]): Promise<void> {
  const before = frames.length;
  const deadline = Date.now() + NUDGE_DEADLINE_MS;
  while (frames.length === before) {
    if (Date.now() > deadline) {
      throw new Error("The screencast stopped sending frames. Keep the app's window on screen while it records.");
    }
    await launched.page.evaluate(NUDGE_SCRIPT);
    await launched.page.waitForTimeout(NUDGE_INTERVAL_MS);
  }
}

function encode(directory: string, path: string): void {
  mkdirSync(MEDIA_DIRECTORY, { recursive: true });
  const ffmpeg = spawnSync(
    FFMPEG,
    [
      "-y",
      "-v",
      "error",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      CONCAT_FILE,
      "-filter_complex",
      GIF_FILTER,
      "-loop",
      "0",
      path,
    ],
    { cwd: directory, encoding: "utf8" },
  );
  if (ffmpeg.error !== undefined) throw new Error(FFMPEG_MISSING, { cause: ffmpeg.error });
  if (ffmpeg.status !== 0) throw new Error(`ffmpeg could not write ${path}:\n${ffmpeg.stderr}`);
}
