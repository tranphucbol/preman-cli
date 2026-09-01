/**
 * What the app costs, measured by the one process that can see all of it.
 *
 * `app.getAppMetrics()` reports every Chromium process this app owns — main, the window, the GPU
 * process, and one engine host per open workspace — and it is only callable here. The renderer is
 * fenced away from `electron` entirely, and the engine host is the process whose memory a reader
 * most wants to watch, which makes it the worst possible choice of reporter: the interesting
 * reading is the one taken while it is thrashing and the interesting failure is the one taken after
 * it is gone. Main outlives all of them.
 *
 * The sampler holds a timer only between `watch(true)` and `watch(false)`. That is the whole point
 * of the design and not an optimisation — decision 017 found 7-16ms of ambient blocking in the idle
 * app, and `docs/performance.md`'s idle RSS row reads `getAppMetrics` after a three-second settle,
 * so a sampler that never stopped would be a feature that moves its own headline number. See
 * `docs/decisions/040`.
 */
import type { ProcessReading, ResourceSample } from "@preman/desktop/preload/bridge.js";

/**
 * How often a reading is taken, and therefore what a reading is.
 *
 * `percentCPUUsage` is an average over the interval since that process was last sampled, so this
 * number is not a refresh rate — it is the width of the window each percentage describes. One
 * second is short enough to see a spike and long enough that the arithmetic is not noise.
 */
export const SAMPLE_INTERVAL_MS = 1_000;

/**
 * The two names worth translating.
 *
 * `Browser` is Chromium's word for the process that owns the window rather than for a browser, and
 * `Tab` is its word for a renderer; this app has exactly one of each and calls them what a reader
 * would. Everything else keeps Chromium's own name, because a table of another project's internal
 * process types is a table that goes stale silently across an Electron upgrade.
 */
const RENAMED_TYPES: Readonly<Record<string, string>> = { Browser: "Main", Tab: "Window" };

const ENGINE_LABEL_PREFIX = "Engine — ";

/**
 * Rows are ordered by what they are, never by what they currently cost.
 *
 * Sorting by memory would be more informative for one frame and unreadable after that: at one
 * sample a second, a list whose rows swap places is a list nobody can read a trend off. Ties break
 * on pid so two hosts keep a stable order between samples.
 */
const RANK_MAIN = 0;
const RANK_WINDOW = 1;
const RANK_ENGINE = 2;
const RANK_UTILITY = 3;
const RANK_OTHER = 4;

const TYPE_BROWSER = "Browser";
const TYPE_TAB = "Tab";
const TYPE_UTILITY = "Utility";

/**
 * What this module reads off a `ProcessMetric`, declared structurally for the same reason
 * `EnginePort` is in `bridge.ts`: it doubles as the statement of how much of Electron's shape is
 * depended on, and it lets the labelling be unit-tested without loading `electron` at all.
 */
export interface MetricReading {
  readonly pid: number;
  readonly type: string;
  /**
   * The name a `Utility` was forked under, and the one to label by.
   *
   * `utilityProcess.fork`'s `serviceName` option arrives here rather than in `serviceName`, which
   * is not the pairing the option name suggests and is the reason this module reads `name` first.
   * `test/renderer/perf.app.test.ts:209` had already written that down to find the host it kills.
   * `name` is also the friendlier of the two for Chromium's own processes: the network service is
   * `name: "Network Service"` and `serviceName: "network.mojom.NetworkService"`. Absent on
   * `Browser`, which carries neither.
   */
  readonly name?: string;
  /** The mojo interface — `node.mojom.NodeService` for every host this app forks. */
  readonly serviceName?: string;
  /** Machine-relative, not per-core. {@link ResourceSamplerOptions.cores} is the measurement. */
  readonly cpu: { readonly percentCPUUsage: number };
  readonly memory: { readonly workingSetSize: number; readonly peakWorkingSetSize: number };
}

export interface ResourceSamplerOptions {
  /** `() => app.getAppMetrics()`. Injected so this module never imports `electron`. */
  readonly read: () => readonly MetricReading[];
  /** Where a sample goes. Main owns the window handle, so it owns the guard on a dead one. */
  readonly send: (sample: ResourceSample) => void;
  /**
   * `SERVICE_NAME_PREFIX` from `hosts.ts`, passed in rather than imported: that module reaches for
   * `electron` and this one is tested without it.
   */
  readonly enginePrefix: string;
  /**
   * `os.cpus().length`, and the pane is wrong without it.
   *
   * **`percentCPUUsage` is a percentage of the whole machine, not of one core**, whatever the name
   * suggests and whatever Electron's own documentation implies by omission. Measured against
   * `cumulativeCPUUsage`, which is CPU-seconds and therefore ground truth: a process pinning
   * exactly one core for three wall seconds spends 3.0 CPU-seconds and reports `9.999` on a
   * ten-core machine. Chromium divides by the processor count.
   *
   * Left alone, that makes every threshold machine-dependent — a saturated core is 25% on four
   * cores and 6% on sixteen — so a band that means "pegged" on a laptop means "idle" on a
   * workstation, and no fixed number can be right on both. Multiplying by the count converts it to
   * percent of one core, which is what Activity Monitor and `top` report, so the column can be
   * cross-checked against the tool the reader already trusts and the bands mean one thing
   * everywhere. It is injected for the same reason `read` is: so the conversion is testable.
   */
  readonly cores: number;
  /** Overridden only by the tests. The app takes {@link SAMPLE_INTERVAL_MS}. */
  readonly intervalMs?: number;
}

export interface ResourceSampler {
  /**
   * Start or stop sampling. Idempotent in both directions: the renderer's tab can remount without
   * stacking intervals, and a `false` that arrives twice is not an error.
   */
  watch(watching: boolean): void;
  /** For the window going away, which is a stop nobody sent. */
  stop(): void;
}

/**
 * What to call the process, given its type and — for a host — the name `hosts.ts` forked it under.
 *
 * Exported for its own test. A `Utility` whose forked name does not carry the prefix belongs to
 * Electron rather than to this app, and is named whatever Chromium called it — `name` for
 * preference, because that is the human half of the pair.
 */
export function labelOf(metric: MetricReading, enginePrefix: string): string {
  if (isEngineHost(metric, enginePrefix)) {
    return ENGINE_LABEL_PREFIX + (metric.name ?? "").slice(enginePrefix.length);
  }
  return RENAMED_TYPES[metric.type] ?? metric.name ?? metric.serviceName ?? metric.type;
}

/** A `Utility` this app forked, as opposed to one Electron did. See {@link MetricReading.name}. */
function isEngineHost(metric: MetricReading, enginePrefix: string): boolean {
  return metric.type === TYPE_UTILITY && metric.name?.startsWith(enginePrefix) === true;
}

function rankOf(metric: MetricReading, enginePrefix: string): number {
  if (metric.type === TYPE_BROWSER) return RANK_MAIN;
  if (metric.type === TYPE_TAB) return RANK_WINDOW;
  if (metric.type !== TYPE_UTILITY) return RANK_OTHER;
  return isEngineHost(metric, enginePrefix) ? RANK_ENGINE : RANK_UTILITY;
}

/**
 * One `getAppMetrics()` answer, turned into rows a pane can draw.
 *
 * Pure, and exported for its own test. Memory is copied across untouched — the working set is
 * Chromium's, uncorrected for the framework it counts once per process, because a pane whose total
 * disagrees with Activity Monitor is a pane nobody trusts for the readings it got right.
 *
 * CPU is the one number that is converted, and it has to be. See {@link ResourceSamplerOptions.cores}.
 */
export function describeMetrics(
  metrics: readonly MetricReading[],
  enginePrefix: string,
  cores: number,
): readonly ProcessReading[] {
  return [...metrics]
    .sort((left, right) => rankOf(left, enginePrefix) - rankOf(right, enginePrefix) || left.pid - right.pid)
    .map((metric) => ({
      pid: metric.pid,
      label: labelOf(metric, enginePrefix),
      cpuPercent: metric.cpu.percentCPUUsage * cores,
      memoryKb: metric.memory.workingSetSize,
      peakMemoryKb: metric.memory.peakWorkingSetSize,
    }));
}

export function createResourceSampler(options: ResourceSamplerOptions): ResourceSampler {
  const intervalMs = options.intervalMs ?? SAMPLE_INTERVAL_MS;
  let timer: NodeJS.Timeout | null = null;

  function sample(): void {
    options.send({
      takenAt: Date.now(),
      processes: describeMetrics(options.read(), options.enginePrefix, options.cores),
    });
  }

  function stop(): void {
    if (timer === null) return;
    clearInterval(timer);
    timer = null;
  }

  return {
    watch(watching) {
      if (!watching) {
        stop();
        return;
      }
      if (timer !== null) return;
      // Taken and thrown away. Every percentage is an average since that process was last read, so
      // the first reading after a gap is an average over the gap — on a cold launch that is 029's
      // four seconds of loading faker and grpc-js, smeared across however long the window has been
      // open, presented as a live figure. Priming makes the first delivered sample one second wide.
      options.read();
      timer = setInterval(sample, intervalMs);
    },
    stop,
  };
}
