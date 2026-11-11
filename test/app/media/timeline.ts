/**
 * Turning screencast frames into an ffmpeg concat list. Pure, so the timing is tested without
 * ffmpeg or a window.
 *
 * Chromium sends a frame only when something repaints, so the frames arrive at uneven times and a
 * still screen sends none. Each frame therefore lasts until the next one arrives, which is what
 * the window showed; a fixed rate would play a two-second pause as one frame.
 */

/** One PNG written by the screencast, and when Chromium painted it, in seconds. */
export interface Frame {
  file: string;
  timestamp: number;
}

export interface ConcatList {
  /** An `ffconcat` script naming every frame and how long it shows. */
  script: string;
  /** What the GIF will last. */
  seconds: number;
}

const HEADER = "ffconcat version 1.0";
/** ffmpeg drops the last frame of a concat list too short to land on its output clock. */
const MIN_LAST_FRAME_SECONDS = 0.1;
const DURATION_DIGITS = 3;

/**
 * @param endSeconds when the recording stopped; the last frame holds until then.
 * @param maxFrameSeconds the longest any one frame may show, so a scene waiting on the network
 *   does not spend its length on a still screen.
 */
export function concatList(frames: readonly Frame[], endSeconds: number, maxFrameSeconds = Infinity): ConcatList {
  const first = frames[0];
  if (first === undefined) throw new Error("The screencast sent no frames; there is nothing to encode.");
  const lines = [HEADER];
  let seconds = 0;
  frames.forEach((frame, index) => {
    const next = frames[index + 1];
    const until = next === undefined ? Math.max(endSeconds, frame.timestamp + MIN_LAST_FRAME_SECONDS) : next.timestamp;
    const duration = Math.min(Math.max(until - frame.timestamp, 0), maxFrameSeconds);
    seconds += duration;
    lines.push(`file '${quoted(frame.file)}'`, `duration ${duration.toFixed(DURATION_DIGITS)}`);
  });
  // The concat demuxer ignores the last entry's duration unless the file is listed once more.
  const last = frames[frames.length - 1] ?? first;
  lines.push(`file '${quoted(last.file)}'`);
  return { script: `${lines.join("\n")}\n`, seconds };
}

/** The concat format's own escaping: a quote closes, escapes, and reopens the string. */
function quoted(file: string): string {
  return file.replaceAll("'", `'\\''`);
}
