import type { ProcessReading, ResourceSample } from "@preman/desktop/preload/bridge.js";

import { type Tone, toneClass } from "./response.js";

/**
 * The arithmetic and the wording behind the Resources tab, kept out of the components that draw it.
 *
 * The same split `model/migration.ts` makes, and for the same reason: this is the part worth
 * asserting, and a component under `environment: "node"` cannot be rendered. What is left in
 * `ui/Sparkline.tsx` and the pane is JSX.
 *
 * Nothing here corrects a number. `docs/decisions/040` argues for reporting Chromium's working set
 * as Chromium reports it — a total that disagrees with Activity Monitor is a total nobody trusts —
 * so this file converts units, formats, and remembers, and does not editorialise.
 */

/**
 * How many samples a process's line holds: one minute at one sample a second.
 *
 * A minute because the question this pane answers is "what just happened", and the reason anybody
 * opens it is that something felt slow a moment ago. Longer would need a time axis to be readable,
 * and an axis is a legend, and a legend is a chart.
 */
export const HISTORY_CAPACITY = 60;

/**
 * The floor under the y axis, in percent of one core.
 *
 * The axis scales to the tallest sample in the window rather than to 100, because a process at 0.3%
 * against a fixed 100 is a flat line at the bottom on every row. Left there, though, autoscaling
 * turns an idle process into a mountain range made of rounding — so the ceiling is the taller of
 * the observed peak and this.
 */
export const SPARKLINE_MIN_CEILING_PERCENT = 10;

/**
 * The drawing space. Unitless: the SVG has a fixed `viewBox` and `preserveAspectRatio="none"`, so
 * the points never have to be recomputed when the row changes width and the component never has to
 * measure itself. The width is one unit per sample gap.
 */
export const SPARKLINE_VIEW_WIDTH = HISTORY_CAPACITY - 1;
export const SPARKLINE_VIEW_HEIGHT = 100;

const KB_PER_MB = 1024;
const MEGABYTES_LABEL = " MB";
const PERCENT_LABEL = "%";
/** One decimal on both columns. A second is below the noise floor of a one-second average. */
const DECIMALS = 1;

const POINT_SEPARATOR = " ";
const COORDINATE_SEPARATOR = ",";
const ORIGIN = 0;
const SINGLE_SAMPLE = 1;
const NO_SAMPLES = 0;

/**
 * Where a row's colour comes from: the load bands, in percent of one core.
 *
 * **This is a magnitude scale, not a fault scale**, and that is the whole reason it is safe to
 * colour every row at rest. It is htop's reading of the same number — green is quiet, amber is a
 * real slice of a core, red is a saturated one — and a saturated core during a collection run is
 * the engine doing what it was asked to, not a failure. Colouring it red says how big, not how bad,
 * and the caption under the table says so in words because a colour cannot.
 *
 * These numbers are only meaningful because `main/resources.ts` converts Chromium's machine-relative
 * percentage into a per-core one; read the note on `ResourceSamplerOptions.cores` before touching
 * them. Against the raw figure a saturated core is 25% on four cores and 6% on sixteen, and no fixed
 * threshold is right on both — which is exactly the bug these constants were first written with, and
 * the reason a full core read green on the machine this was built on.
 *
 * The bands are wide on purpose. A one-second average of a percentage that Chromium samples on its
 * own schedule does not support a fine scale, and three bands are what a glance can resolve down a
 * column of five anyway.
 */
const LOAD_WARN_PERCENT = 25;
const LOAD_DANGER_PERCENT = 90;

/** `142.3 MB`. Always megabytes, never scaled to gigabytes: a column of one unit is comparable. */
export function formatMemory(kilobytes: number): string {
  return (kilobytes / KB_PER_MB).toFixed(DECIMALS) + MEGABYTES_LABEL;
}

/** `12.4%`, of one core. Above 100 on a busy process, and deliberately not capped. */
export function formatCpu(percent: number): string {
  return percent.toFixed(DECIMALS) + PERCENT_LABEL;
}

/**
 * The two columns that can honestly be added up, for the line that answers "what does this app
 * cost".
 *
 * Peak is not among them, and its absence is the point: two processes peaked at two different
 * moments, so their sum is a simultaneous high-water mark that never happened. Adding it would put
 * a number in the pane that is larger than anything the app ever actually held.
 */
export interface ResourceTotal {
  readonly cpuPercent: number;
  readonly memoryKb: number;
}

export function totalOf(processes: readonly ProcessReading[]): ResourceTotal {
  return processes.reduce<ResourceTotal>(
    (sum, process) => ({
      cpuPercent: sum.cpuPercent + process.cpuPercent,
      memoryKb: sum.memoryKb + process.memoryKb,
    }),
    { cpuPercent: ORIGIN, memoryKb: ORIGIN },
  );
}

/**
 * Fold one sample into the per-process history.
 *
 * Keyed by pid and not by label, because a label is not unique — two workspaces open on directories
 * of the same name are two rows called the same thing. The other half of that choice is the
 * eviction: a pid absent from this sample loses its history outright, so a host that
 * `HOST_IDLE_MS` reaped and a later open re-forked starts its own line rather than continuing a
 * stranger's. Without it this map grows for as long as the pane is open.
 */
export function remember(
  history: ReadonlyMap<number, readonly number[]>,
  sample: ResourceSample,
): Map<number, readonly number[]> {
  const next = new Map<number, readonly number[]>();
  for (const process of sample.processes) {
    const previous = history.get(process.pid) ?? [];
    const series = [...previous, process.cpuPercent];
    next.set(process.pid, series.slice(Math.max(NO_SAMPLES, series.length - HISTORY_CAPACITY)));
  }
  return next;
}

/**
 * A series as `polyline` points, oldest on the left.
 *
 * The line grows rightwards from the left edge while the window fills, which is why `x` is the
 * index rather than a position scaled to the series length: a line that stretched to fit would
 * redraw its whole shape on every sample and show a trend that was an artefact of the stretching.
 *
 * A series of one is drawn as a flat tick rather than as nothing. One reading has no trend, but a
 * blank cell in the first second after opening the pane reads as a cell that failed.
 */
export function sparklinePoints(series: readonly number[]): string {
  if (series.length === NO_SAMPLES) return "";
  const ceiling = Math.max(SPARKLINE_MIN_CEILING_PERCENT, ...series);
  const plotted = series.length === SINGLE_SAMPLE ? [...series, ...series] : series;
  return plotted
    .map((percent, index) => {
      const y = SPARKLINE_VIEW_HEIGHT - (percent / ceiling) * SPARKLINE_VIEW_HEIGHT;
      return `${String(index)}${COORDINATE_SEPARATOR}${String(y)}`;
    })
    .join(POINT_SEPARATOR);
}

/**
 * The same shape closed to the baseline, as `polygon` points, for the wash under the line.
 *
 * Derived from {@link sparklinePoints} rather than computed again so the two can never disagree
 * about the ceiling: a fill that used its own scale would sit above or below its own stroke. It is
 * two extra points — the bottom-right corner and the bottom-left — and the fill is drawn in
 * `currentColor` at a low opacity, so it takes the row's load tone with it and needs no token of
 * its own in any of the forty-three themes.
 */
export function sparklineArea(series: readonly number[]): string {
  const points = sparklinePoints(series);
  if (points === "") return "";
  const lastX = points.split(POINT_SEPARATOR).length - SINGLE_SAMPLE;
  const floor = String(SPARKLINE_VIEW_HEIGHT);
  const bottomRight = `${String(lastX)}${COORDINATE_SEPARATOR}${floor}`;
  const bottomLeft = `${String(ORIGIN)}${COORDINATE_SEPARATOR}${floor}`;
  return [points, bottomRight, bottomLeft].join(POINT_SEPARATOR);
}

/**
 * Which band a CPU reading falls in. See {@link LOAD_WARN_PERCENT} for why three, and why a red
 * row is a claim about size rather than about health.
 *
 * `percentCPUUsage` is a percentage of one core and is not capped at 100, so the top band is open.
 */
export function loadTone(cpuPercent: number): Tone {
  // Per-core, so the top band is open: two cores is 200%. `main/resources.ts` did the conversion.
  if (cpuPercent >= LOAD_DANGER_PERCENT) return "danger";
  if (cpuPercent >= LOAD_WARN_PERCENT) return "warn";
  return "ok";
}

/**
 * The band as a class, for the one column and the one line that wear it.
 *
 * Goes through `toneClass` in `model/response.ts` rather than declaring a second map: that file's
 * own docblock says three copies of the palette is three places for it to drift out from under the
 * contrast audit, and this is the fourth reader it was written for.
 */
export function loadClass(cpuPercent: number): string {
  return toneClass(loadTone(cpuPercent));
}
