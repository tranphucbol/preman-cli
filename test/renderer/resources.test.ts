import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createResourceSampler,
  describeMetrics,
  labelOf,
  type MetricReading,
  type ResourceSampler,
} from "@preman/desktop/main/resources.js";
import type { ProcessReading, ResourceSample } from "@preman/desktop/preload/bridge.js";
import {
  HISTORY_CAPACITY,
  SPARKLINE_VIEW_HEIGHT,
  formatCpu,
  formatMemory,
  loadClass,
  loadTone,
  remember,
  sparklineArea,
  sparklinePoints,
  totalOf,
} from "@preman/desktop/renderer/model/resources.js";
import { toneClass } from "@preman/desktop/renderer/model/response.js";

/**
 * The Resources tab, asserted at the two seams that can be: the sampler in main, whose `read` is an
 * argument precisely so a test can count calls to it, and the pure model the pane draws from.
 *
 * The last third reads three sources as text, in `migration.test.ts`'s manner and for its reason.
 * What is left after the pure part is the absence of things — no `forceMount`, no transition, a
 * `watchResources(false)` in a cleanup — and an absence is exactly what a component test that
 * cannot mount a component will not notice going missing.
 */

const DESKTOP_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../packages/desktop/src");
const SPARKLINE_SOURCE = readFileSync(join(DESKTOP_DIR, "renderer/ui/Sparkline.tsx"), "utf8");
const PANE_SOURCE = readFileSync(join(DESKTOP_DIR, "renderer/panes/SettingsPane.tsx"), "utf8");
const HOSTS_SOURCE = readFileSync(join(DESKTOP_DIR, "main/hosts.ts"), "utf8");
const BLOCK_COMMENT = /\/\*[\s\S]*?\*\//g;
const LINE_COMMENT = /\/\/.*$/gm;
const JSX_COMMENT = /\{\/\*[\s\S]*?\*\/\}/g;
const NOT_FOUND = -1;
/** The name the pane gives the ink tier its uncoloured number cells opt into. */
const QUIET_CELL = "QUIET_CELL_CLASS";

/**
 * `SERVICE_NAME_PREFIX`, spelled rather than imported: `hosts.ts` reaches for `electron` and this
 * suite is the reason `resources.ts` takes the prefix as an argument instead. The case at the
 * bottom of this file is what keeps the two spellings the same.
 */
const ENGINE_PREFIX = "preman-engine-";

/**
 * The core count most cases pass, being the only one under which Chromium's machine-relative
 * percentage and the per-core percentage the pane shows are the same number. Cases about anything
 * other than the conversion say `ONE_CORE` so the arithmetic stays out of their way.
 */
const ONE_CORE = 1;
const TEN_CORES = 10;

const INTERVAL_MS = 1_000;
const A_MINUTE_MS = 60_000;

function code(source: string): string {
  return source.replaceAll(JSX_COMMENT, "").replaceAll(BLOCK_COMMENT, "").replaceAll(LINE_COMMENT, "");
}

/** The slice of a source between two anchors, failing loudly rather than asserting over "". */
function between(source: string, from: string, to: string): string {
  const stripped = code(source);
  const start = stripped.indexOf(from);
  expect(start, from).not.toBe(NOT_FOUND);
  const end = stripped.indexOf(to, start);
  expect(end, to).toBeGreaterThan(start);
  return stripped.slice(start, end);
}

/**
 * `name` and `serviceName` are both here and are both set on a real `Utility`, because which one
 * the labelling reads is the thing these cases exist to pin down. Electron puts the name a host was
 * forked under in `name` and the mojo interface in `serviceName`, so a fake that carries only one
 * of them can agree with code that reads either. This one was verified against a live
 * `getAppMetrics()`; see the note on `MetricReading.name`.
 */
interface MetricOverrides {
  readonly name?: string;
  readonly serviceName?: string;
  readonly cpu?: number;
  readonly memory?: number;
  readonly peak?: number;
}

function metric(pid: number, type: string, over: MetricOverrides = {}): MetricReading {
  return {
    pid,
    type,
    ...(over.name === undefined ? {} : { name: over.name }),
    ...(over.serviceName === undefined ? {} : { serviceName: over.serviceName }),
    cpu: { percentCPUUsage: over.cpu ?? 0 },
    memory: { workingSetSize: over.memory ?? 0, peakWorkingSetSize: over.peak ?? over.memory ?? 0 },
  };
}

/**
 * An engine host as Electron actually reports one: the forked name in `name`, and `serviceName`
 * left at the mojo interface every `utilityProcess` shares. Spelling both is the point — labelling
 * off `serviceName` would name every host `node.mojom.NodeService`, which is what it did.
 */
const NODE_SERVICE = "node.mojom.NodeService";

function host(pid: number, workspace: string, over: MetricOverrides = {}): MetricReading {
  return metric(pid, "Utility", { ...over, name: ENGINE_PREFIX + workspace, serviceName: NODE_SERVICE });
}

/** Electron's own network service, which is a `Utility` too and carries a friendly `name`. */
function networkService(pid: number): MetricReading {
  return metric(pid, "Utility", { name: "Network Service", serviceName: "network.mojom.NetworkService" });
}

function reading(pid: number, cpuPercent: number): ProcessReading {
  return { pid, label: String(pid), cpuPercent, memoryKb: 0, peakMemoryKb: 0 };
}

function sampleOf(processes: readonly ProcessReading[]): ResourceSample {
  return { takenAt: 0, processes };
}

/** Every case below reads the sampler through a counted fake, so the timers have to be ours. */
/**
 * Function properties rather than method signatures, for `stores/overlay.ts`'s reason: both are
 * destructured off the object below, and a method separated from its receiver is what
 * `unbound-method` exists to catch.
 */
interface Watched {
  readonly sampler: ResourceSampler;
  readonly reads: () => number;
  readonly sent: () => readonly ResourceSample[];
}

function watched(metrics: readonly MetricReading[] = [metric(1, "Browser")]): Watched {
  let reads = 0;
  const sent: ResourceSample[] = [];
  const sampler = createResourceSampler({
    read: () => {
      reads += 1;
      return metrics;
    },
    send: (sample) => sent.push(sample),
    enginePrefix: ENGINE_PREFIX,
    cores: ONE_CORE,
    intervalMs: INTERVAL_MS,
  });
  return { sampler, reads: () => reads, sent: () => sent };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("labelOf", () => {
  it("givenAnEngineHost_whenLabelled_thenItNamesTheWorkspaceRatherThanTheMojoInterface", () => {
    expect(labelOf(host(9, "payments"), ENGINE_PREFIX)).toBe("Engine — payments");
  });

  it("givenAnEngineHost_whenLabelled_thenTheForkedNameIsReadRatherThanTheServiceName", () => {
    // The regression this file exists for. Every host shares one `serviceName`, so labelling off
    // it named all of them `node.mojom.NodeService` and the pane shipped saying so.
    expect(labelOf(host(9, "payments"), ENGINE_PREFIX)).not.toContain(NODE_SERVICE);
  });

  it("givenChromiumsOwnWordsForOurTwoProcesses_whenLabelled_thenTheyReadAsWhatTheyAre", () => {
    // `Browser` is Chromium's word for the process owning the window, and `Tab` for a renderer.
    expect(labelOf(metric(1, "Browser"), ENGINE_PREFIX)).toBe("Main");
    expect(labelOf(metric(2, "Tab"), ENGINE_PREFIX)).toBe("Window");
  });

  it("givenAUtilityThatIsNotOurs_whenLabelled_thenChromiumsOwnNameSurvives", () => {
    // Inventing a friendly name for it would be inventing a claim about a process this app did not
    // fork and does not control. Chromium already has one, and it is `name`.
    expect(labelOf(networkService(4), ENGINE_PREFIX)).toBe("Network Service");
  });

  it("givenAUtilityWithNoFriendlyName_whenLabelled_thenTheMojoInterfaceIsBetterThanTheBareType", () => {
    // Not every `Utility` carries `name`. `serviceName` at least says which one it is.
    const bare = metric(5, "Utility", { serviceName: "audio.mojom.AudioService" });

    expect(labelOf(bare, ENGINE_PREFIX)).toBe("audio.mojom.AudioService");
  });

  it("givenAProcessTypeThisAppHasNeverSeen_whenLabelled_thenTheTypeIsShownRatherThanNothing", () => {
    // The list of types is Electron's and grows across upgrades. An unknown one is a row, not a gap.
    expect(labelOf(metric(7, "Zygote"), ENGINE_PREFIX)).toBe("Zygote");
  });
});

describe("describeMetrics", () => {
  it("givenMetricsInAnyOrder_whenDescribed_thenRowsAreOrderedByWhatTheyAreNotByWhatTheyCost", () => {
    // The expensive process is last here on purpose: at one sample a second, a list that sorts by
    // cost is a list whose rows swap places while being read.
    const metrics = [
      networkService(4),
      metric(3, "GPU"),
      metric(2, "Tab"),
      host(9, "payments", { cpu: 90 }),
      metric(1, "Browser"),
    ];

    expect(describeMetrics(metrics, ENGINE_PREFIX, ONE_CORE).map((row) => row.label)).toEqual([
      "Main",
      "Window",
      "Engine — payments",
      "Network Service",
      "GPU",
    ]);
  });

  it("givenTwoWorkspacesOpen_whenDescribed_thenTheHostsKeepAStableOrderBetweenSamples", () => {
    const first = host(21, "beta");
    const second = host(12, "alpha");

    // Ties break on pid, not on name and not on the order Chromium happened to answer in.
    expect(describeMetrics([first, second], ENGINE_PREFIX, ONE_CORE).map((row) => row.pid)).toEqual([12, 21]);
    expect(describeMetrics([second, first], ENGINE_PREFIX, ONE_CORE).map((row) => row.pid)).toEqual([12, 21]);
  });

  it("givenAReading_whenDescribed_thenTheWorkingSetIsCarriedAcrossUncorrected", () => {
    // Decision 040: the pane says what Chromium says and explains it in prose. A pane that
    // subtracted an estimate of the shared framework would disagree with Activity Monitor and be
    // unfalsifiable about why.
    const engine = host(9, "ws", { cpu: 12.5, memory: 83_000, peak: 91_000 });

    expect(describeMetrics([engine], ENGINE_PREFIX, ONE_CORE)).toEqual([
      { pid: 9, label: "Engine — ws", cpuPercent: 12.5, memoryKb: 83_000, peakMemoryKb: 91_000 },
    ]);
  });

  it("givenNoMetricsAtAll_whenDescribed_thenItIsAnEmptyListRatherThanAThrow", () => {
    expect(describeMetrics([], ENGINE_PREFIX, ONE_CORE)).toEqual([]);
  });

  it("givenASaturatedCoreOnATenCoreMachine_whenDescribed_thenItArrivesAsOneHundredPercentOfACore", () => {
    // Ground truth, measured against `cumulativeCPUUsage`: a process pinning exactly one core for
    // three wall seconds spends 3.0 CPU-seconds and Chromium reports 9.999 on ten cores, because it
    // divides by the processor count. Without this multiplication the pane's bands mean a different
    // load on every machine, and a full core reads green on anything with eight or more.
    const spinning = [metric(1, "Tab", { cpu: 100 / TEN_CORES })];

    expect(describeMetrics(spinning, ENGINE_PREFIX, TEN_CORES)[0]?.cpuPercent).toBeCloseTo(100);
  });

  it("givenAProcessOnTwoCores_whenDescribed_thenItReadsAboveOneHundredTheWayActivityMonitorDoes", () => {
    const busy = [metric(1, "Tab", { cpu: 200 / TEN_CORES })];

    expect(describeMetrics(busy, ENGINE_PREFIX, TEN_CORES)[0]?.cpuPercent).toBeCloseTo(200);
  });

  it("givenMemory_whenDescribed_thenTheCoreCountTouchesOnlyTheCpuColumn", () => {
    // The conversion is a CPU fact. A working set is not divided by anything to begin with.
    const one = describeMetrics([metric(1, "Tab", { memory: 4_096, peak: 8_192 })], ENGINE_PREFIX, ONE_CORE);
    const ten = describeMetrics([metric(1, "Tab", { memory: 4_096, peak: 8_192 })], ENGINE_PREFIX, TEN_CORES);

    expect(ten[0]?.memoryKb).toBe(one[0]?.memoryKb);
    expect(ten[0]?.peakMemoryKb).toBe(one[0]?.peakMemoryKb);
  });

  it("givenMetrics_whenDescribed_thenTheAnswerIsNotTheArrayItWasGiven", () => {
    // `getAppMetrics()` hands back Electron's own array; sorting it in place would be sorting
    // somebody else's object.
    const metrics = [metric(2, "Tab"), metric(1, "Browser")];

    describeMetrics(metrics, ENGINE_PREFIX, ONE_CORE);

    expect(metrics.map((each) => each.pid)).toEqual([2, 1]);
  });
});

describe("createResourceSampler", () => {
  it("givenTheTabWasNeverOpened_whenAMinutePasses_thenNothingIsReadAtAll", () => {
    // This is `docs/performance.md`'s "resource sampling, Resources tab shut" row, and the whole
    // defence of the idle RSS row beside it. Not few reads. None.
    vi.useFakeTimers();
    const { sampler, reads } = watched();

    vi.advanceTimersByTime(A_MINUTE_MS);

    expect(reads()).toBe(0);
    sampler.stop();
  });

  it("givenWatchingStops_whenAMinutePasses_thenNoFurtherSampleArrives", () => {
    vi.useFakeTimers();
    const { sampler, sent } = watched();
    sampler.watch(true);
    vi.advanceTimersByTime(INTERVAL_MS * 2);
    const before = sent().length;

    sampler.watch(false);
    vi.advanceTimersByTime(A_MINUTE_MS);

    expect(before).toBe(2);
    expect(sent()).toHaveLength(before);
  });

  it("givenWatchingStarts_whenTheFirstIntervalElapses_thenTheFirstReadWasDiscarded", () => {
    // `percentCPUUsage` averages over the gap since that process was last read, so the reading
    // taken at the moment the tab opens describes however long the app has been running. Two reads
    // for one sample is the priming; the sample the pane draws is one second wide.
    vi.useFakeTimers();
    const { sampler, reads, sent } = watched();

    sampler.watch(true);
    expect(reads()).toBe(1);
    expect(sent()).toHaveLength(0);

    vi.advanceTimersByTime(INTERVAL_MS);
    expect(reads()).toBe(2);
    expect(sent()).toHaveLength(1);
  });

  it("givenWatchArrivesTwice_whenTimePasses_thenOneIntervalRunsRatherThanTwo", () => {
    // A remount under React 19's strict double-invoke, or a tab left and re-entered fast enough.
    // Stacked intervals would double the sampling rate and halve the meaning of every percentage.
    vi.useFakeTimers();
    const { sampler, sent } = watched();

    sampler.watch(true);
    sampler.watch(true);
    vi.advanceTimersByTime(INTERVAL_MS * 3);

    expect(sent()).toHaveLength(3);
    sampler.stop();
  });

  it("givenStoppingTwiceOrWithoutStarting_whenAsked_thenItIsNotAnError", () => {
    // The window closing is a stop nobody sent, and it can land after the tab's own cleanup.
    vi.useFakeTimers();
    const { sampler } = watched();

    expect(() => {
      sampler.watch(false);
      sampler.stop();
      sampler.stop();
    }).not.toThrow();
  });

  it("givenWatchingResumes_whenTheTabIsReopened_thenSamplingStartsAgain", () => {
    vi.useFakeTimers();
    const { sampler, sent } = watched();

    sampler.watch(true);
    sampler.watch(false);
    sampler.watch(true);
    vi.advanceTimersByTime(INTERVAL_MS);

    expect(sent()).toHaveLength(1);
    sampler.stop();
  });

  it("givenASample_whenSent_thenItCarriesTheRowsAndTheMomentItWasTaken", () => {
    vi.useFakeTimers();
    const { sampler, sent } = watched([metric(1, "Browser", { memory: 1_024 })]);

    sampler.watch(true);
    vi.advanceTimersByTime(INTERVAL_MS);

    const sample = sent()[0];
    expect(sample?.processes).toEqual([{ pid: 1, label: "Main", cpuPercent: 0, memoryKb: 1_024, peakMemoryKb: 1_024 }]);
    expect(sample?.takenAt).toBeTypeOf("number");
    sampler.stop();
  });
});

describe("formatMemory and formatCpu", () => {
  it("givenKilobytes_whenFormatted_thenItIsMegabytesToOneDecimal", () => {
    expect(formatMemory(1_024)).toBe("1.0 MB");
    expect(formatMemory(145_715)).toBe("142.3 MB");
  });

  it("givenAWholeGigabyte_whenFormatted_thenItStaysInMegabytes", () => {
    // Never scaled to GB: a column in one unit is a column that can be compared down its length.
    expect(formatMemory(1_048_576)).toBe("1024.0 MB");
  });

  it("givenABusyProcess_whenFormatted_thenCpuIsNotCappedAtOneHundred", () => {
    // A percentage of one core. Capping it would hide the case the pane exists to show.
    expect(formatCpu(137.5)).toBe("137.5%");
  });

  it("givenAnIdleProcess_whenFormatted_thenItReadsAsZeroRatherThanBlank", () => {
    expect(formatCpu(0)).toBe("0.0%");
  });
});

describe("totalOf", () => {
  it("givenSeveralProcesses_whenTotalled_thenCpuAndMemoryAddUp", () => {
    const processes: readonly ProcessReading[] = [
      { pid: 1, label: "Main", cpuPercent: 1.5, memoryKb: 1_000, peakMemoryKb: 4_000 },
      { pid: 2, label: "Window", cpuPercent: 2.5, memoryKb: 2_000, peakMemoryKb: 9_000 },
    ];

    expect(totalOf(processes)).toEqual({ cpuPercent: 4, memoryKb: 3_000 });
  });

  it("givenSeveralProcesses_whenTotalled_thenThePeaksAreNotSummedIntoAMomentThatNeverHappened", () => {
    // Two processes peaked at two different times. Their sum is a simultaneous high-water mark the
    // app never held, so the pane draws an em dash in that cell instead.
    expect(Object.keys(totalOf([reading(1, 0)]))).toEqual(["cpuPercent", "memoryKb"]);
    expect(between(PANE_SOURCE, "<tfoot>", "</tfoot>")).toContain("{NO_TOTAL}");
  });

  it("givenNoProcesses_whenTotalled_thenItIsZeroRatherThanUndefined", () => {
    expect(totalOf([])).toEqual({ cpuPercent: 0, memoryKb: 0 });
  });
});

describe("remember", () => {
  it("givenASample_whenRemembered_thenEachProcessKeepsItsOwnLine", () => {
    const history = remember(new Map(), sampleOf([reading(1, 10), reading(2, 20)]));

    expect(history.get(1)).toEqual([10]);
    expect(history.get(2)).toEqual([20]);
  });

  it("givenMoreSamplesThanAMinuteHolds_whenRemembered_thenTheOldestIsDropped", () => {
    let history: ReadonlyMap<number, readonly number[]> = new Map();
    for (let each = 0; each <= HISTORY_CAPACITY; each += 1) {
      history = remember(history, sampleOf([reading(1, each)]));
    }

    const series = history.get(1);
    expect(series).toHaveLength(HISTORY_CAPACITY);
    // The very first reading is gone and the newest is last: the line reads left to right in time.
    expect(series?.[0]).toBe(1);
    expect(series?.at(-1)).toBe(HISTORY_CAPACITY);
  });

  it("givenAProcessThatWentAway_whenRemembered_thenItsHistoryGoesWithIt", () => {
    // Without this the map grows for as long as the pane is open, one entry per host ever forked.
    const first = remember(new Map(), sampleOf([reading(1, 10), reading(9, 50)]));

    const second = remember(first, sampleOf([reading(1, 11)]));

    expect(second.get(1)).toEqual([10, 11]);
    expect(second.has(9)).toBe(false);
  });

  it("givenAHostReapedAndForkedAgain_whenRemembered_thenTheNewLineDoesNotContinueTheOldOne", () => {
    // `HOST_IDLE_MS` reaps an idle host; opening that workspace again forks a new one. Keying on
    // pid and evicting on absence is what stops the second host inheriting the first's minute.
    const before = remember(new Map(), sampleOf([reading(9, 40)]));
    const gap = remember(before, sampleOf([reading(1, 0)]));

    const after = remember(gap, sampleOf([reading(1, 0), reading(9, 5)]));

    expect(after.get(9)).toEqual([5]);
  });

  it("givenAHistory_whenRemembered_thenTheMapItWasGivenIsUntouched", () => {
    // The store swaps the reference; a mutated map would leave Zustand's subscribers unnotified.
    const first = remember(new Map(), sampleOf([reading(1, 10)]));

    remember(first, sampleOf([reading(1, 11)]));

    expect(first.get(1)).toEqual([10]);
  });
});

describe("sparklinePoints", () => {
  it("givenNoSamplesYet_whenPlotted_thenThereIsNoLine", () => {
    expect(sparklinePoints([])).toBe("");
  });

  it("givenOneSample_whenPlotted_thenAFlatTickIsDrawnRatherThanNothing", () => {
    // One reading has no trend, but an empty cell in the first second reads as a cell that broke.
    expect(sparklinePoints([5])).toBe("0,50 1,50");
  });

  it("givenAnIdleProcess_whenPlotted_thenTheAxisFloorKeepsTheLineAtTheBottom", () => {
    // Scaling to the observed peak alone would turn 0.3% of rounding noise into a mountain range.
    const points = sparklinePoints([0.3, 0.1, 0.3]);

    expect(points).toBe("0,97 1,99 2,97");
  });

  it("givenASpike_whenPlotted_thenThePeakTouchesTheTopOfTheCell", () => {
    const points = sparklinePoints([1, 50]);

    expect(points.endsWith(",0")).toBe(true);
  });

  it("givenAPartiallyFilledWindow_whenPlotted_thenXIsTheSampleIndexSoTheLineGrowsRightwards", () => {
    // Not scaled to the series length: a line that stretched to fit would redraw its whole shape
    // every second and show a trend that was an artefact of the stretching.
    expect(sparklinePoints([10, 10, 10])).toBe("0,0 1,0 2,0");
  });

  it("givenAnySeries_whenPlotted_thenNoPointLeavesTheViewBox", () => {
    const points = sparklinePoints([0, 0.4, 12, 250, 3]);

    for (const point of points.split(" ")) {
      const y = Number(point.split(",")[1]);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(SPARKLINE_VIEW_HEIGHT);
    }
  });
});

describe("sparklineArea", () => {
  it("givenNoSamplesYet_whenFilled_thenThereIsNoWashEither", () => {
    expect(sparklineArea([])).toBe("");
  });

  it("givenALine_whenFilled_thenTheWashIsThatLineClosedToTheBaseline", () => {
    // Derived from `sparklinePoints`, not computed again: a fill on its own scale would sit above
    // or below its own stroke, and the two would drift the day the ceiling rule changes.
    const points = sparklinePoints([10, 10, 10]);

    expect(sparklineArea([10, 10, 10])).toBe(`${points} 2,100 0,100`);
  });

  it("givenAOneSampleFlatTick_whenFilled_thenTheWashClosesUnderBothOfItsPoints", () => {
    // The tick is two points wide, so the baseline has to reach the second one or the wash is a
    // triangle under a flat line.
    expect(sparklineArea([5])).toBe("0,50 1,50 1,100 0,100");
  });

  it("givenAnySeries_whenFilled_thenNoPointLeavesTheViewBox", () => {
    for (const point of sparklineArea([0, 0.4, 12, 250, 3]).split(" ")) {
      const y = Number(point.split(",")[1]);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(SPARKLINE_VIEW_HEIGHT);
    }
  });
});

describe("loadTone", () => {
  it("givenAQuietProcess_whenBanded_thenItReadsOkRatherThanNeutral", () => {
    // Every row is coloured at rest on purpose: this is a magnitude scale, and green is the honest
    // thing to say about a process using none of a core.
    expect(loadTone(0)).toBe("ok");
    expect(loadTone(24.9)).toBe("ok");
  });

  it("givenAQuarterOfACore_whenBanded_thenItReadsWarn", () => {
    expect(loadTone(25)).toBe("warn");
    expect(loadTone(89.9)).toBe("warn");
  });

  it("givenASaturatedCore_whenBanded_thenItReadsDanger", () => {
    // Danger is a claim about size, not about health. The legend under the table says so, because
    // a red row read as "broken" during a collection run is a bug report about working correctly.
    expect(loadTone(90)).toBe("danger");
    expect(loadTone(100)).toBe("danger");
  });

  it("givenAProcessOnMoreThanOneCore_whenBanded_thenTheTopBandIsOpenRatherThanWrapping", () => {
    // The figure the pane holds is per-core, so two cores is 200%. Nothing caps it.
    expect(loadTone(340)).toBe("danger");
  });

  it("givenTheBands_whenReadAsRawChromiumPercentages_thenTheyWouldBeWrongOnEveryMultiCoreMachine", () => {
    // The bug this calibration was shipped with, kept as a case. A saturated core reports 10 on a
    // ten-core machine, and 10 is deep in the green band — so `main/resources.ts` has to convert
    // before this function ever sees the number, and 100 is what a saturated core must arrive as.
    const rawForOneSaturatedCore = 100 / TEN_CORES;

    expect(loadTone(rawForOneSaturatedCore)).toBe("ok");
    expect(loadTone(rawForOneSaturatedCore * TEN_CORES)).toBe("danger");
  });

  it("givenABand_whenTurnedIntoAClass_thenItGoesThroughTheOnePaletteMap", () => {
    // `model/response.ts` owns tone-to-class because three copies is three places for the palette
    // to drift out from under the contrast audit. This is the fourth reader, not a fourth map.
    expect(loadClass(0)).toBe(toneClass("ok"));
    expect(loadClass(40)).toBe(toneClass("warn"));
    expect(loadClass(95)).toBe(toneClass("danger"));
  });

  it("givenAnyBand_whenTurnedIntoAClass_thenItIsATokenAndNeverAColour", () => {
    // The renderer may not name a hex: `appearance/apply.ts` owns every value, which is the whole
    // reason a theme can be data. A band that resolved to a colour here would escape all 43.
    for (const percent of [0, 20, 90, 400]) {
      expect(loadClass(percent)).toMatch(/^text-[a-z]+$/);
    }
  });
});

describe("what the tab and the line commit to", () => {
  it("givenTheSparklineColour_whenDrawn_thenBothTheStrokeAndTheWashInheritIt", () => {
    // One class on the `svg` has to colour the pair. A literal fill on either would be a colour
    // the theme does not know about, and a wash that disagreed with its own stroke.
    const svg = code(SPARKLINE_SOURCE);

    expect(svg).toContain('stroke="currentColor"');
    expect(svg).toContain('fill="currentColor"');
    expect(svg).not.toMatch(/(fill|stroke)="#/);
  });

  it("givenTheSparkline_whenGivenABand_thenItHoldsNoColourOfItsOwnForThatBandToFightWith", () => {
    // `cn` is a plain join with no `tailwind-merge`, so a default colour here would ride along with
    // the caller's and let the stylesheet's declaration order decide which one wins. It did.
    expect(code(SPARKLINE_SOURCE)).not.toMatch(/className=\{cn\("[^"]*text-/);
  });

  it("givenTheSharedNumberCellClass_whenACellOverridesTheColour_thenTheSharedOneCarriesNone", () => {
    // The same trap as the line above, one file over, and it was live: the cell held `text-ink-faint`
    // and the caller added a band, so both reached the element and only the generated stylesheet's
    // declaration order decided which won. It happened to pick the band. Reorder the tokens in
    // `app.css` and every CPU figure in the table silently goes grey, with nothing failing.
    const shared = between(code(PANE_SOURCE), "const NUMBER_CELL_CLASS", ";");

    expect(shared).not.toContain("text-ink");
    expect(shared).not.toMatch(/text-(ok|warn|danger|glyph)/);
    // And every cell built from it names a tier, so nothing inherits a colour by accident.
    for (const cell of code(PANE_SOURCE).match(/cn\(NUMBER_CELL_CLASS[^)]*\)/g) ?? []) {
      expect(cell).toMatch(/QUIET_CELL_CLASS|"text-ink"|tone/);
    }
  });

  it("givenAResourceRow_whenDrawn_thenTheLineAndItsNumberWearOneBandReadOnce", () => {
    // Two `loadClass` calls would be two chances for the wash and the figure beside it to disagree.
    const row = between(PANE_SOURCE, "const tone = loadClass(", "</tr>");

    expect(row).toContain("<Sparkline series={series} className={tone} />");
    expect(row).toContain("cn(NUMBER_CELL_CLASS, tone)");
    expect(row.match(/loadClass\(/g)).toHaveLength(1);
  });

  it("givenTheMemoryColumns_whenDrawn_thenTheyStayQuietBecauseTheyHaveNoCeilingToBandAgainst", () => {
    // A process is not at 60% of a working set. Colouring a column that cannot mean anything by it
    // is how the column that does mean something stops being read.
    const row = between(PANE_SOURCE, "const tone = loadClass(", "</tr>");
    // Match each cell together with the className that paints it, rather than scanning forward for
    // the next `)}`: that found the *following* cell's attribute the moment one of them wrapped.
    const memoryCells = row.match(/<td className=\{[^}]*\}>\s*\{formatMemory\(reading\.\w+\)\}/g) ?? [];

    expect(memoryCells).toHaveLength(2);
    for (const cell of memoryCells) {
      expect(cell).not.toContain("tone");
      expect(cell).toContain(QUIET_CELL);
    }
  });

  it("givenColourOnTheTable_whenShown_thenTheLegendSaysWhatItMeans", () => {
    // Colour nobody explained is decoration, and this colour is specifically the kind that gets
    // misread as an alarm.
    const legend = between(PANE_SOURCE, "const LOAD_LEGEND", ";");

    expect(legend).toContain("not by health");
  });

  it("givenTheTotalRow_whenDrawn_thenItIsNotBandedBecauseASumIsNotAPerCoreReading", () => {
    // Five quiet processes add up to a figure no per-core band describes.
    const total = between(PANE_SOURCE, "{TOTAL_LABEL}", "</tfoot>");

    expect(total).toContain("formatCpu(total.cpuPercent)");
    expect(total).not.toContain("loadClass");
  });

  it("givenTheSparkline_whenDrawn_thenItStretchesWithoutRecomputingAndWithoutDistortingItsStroke", () => {
    const svg = code(SPARKLINE_SOURCE);

    expect(svg).toContain('preserveAspectRatio="none"');
    expect(svg).toContain('vectorEffect="non-scaling-stroke"');
  });

  it("givenTheSparkline_whenRedrawn_thenNothingInterpolates", () => {
    // Decision 17's budgets are blocking-time medians. A repaint a second is affordable; a
    // transition on it is per-frame work on a property that is not opacity or transform.
    const svg = code(SPARKLINE_SOURCE);

    expect(svg).not.toContain("transition");
    expect(svg).not.toContain("duration-");
    expect(svg).not.toContain("animate");
  });

  it("givenTheSparkline_whenReadAloud_thenItClaimsNothingTheNumberBesideItAlreadySays", () => {
    // There is no honest ARIA role for "the shape of the last minute", and the CPU column is the
    // same fact in text on the same row.
    expect(code(SPARKLINE_SOURCE)).toContain('aria-hidden="true"');
  });

  it("givenTheResourcesTab_whenLeft_thenRadixUnmountsItBecauseNothingForcesItMounted", () => {
    // The unmount *is* the gate. `forceMount` anywhere in this pane would leave the sampler running
    // behind the Appearance tab, which is the one thing decision 040 promises it does not do.
    expect(code(PANE_SOURCE)).not.toContain("forceMount");
  });

  it("givenTheResourcesTab_whenUnmounted_thenItStopsTheSamplerAndForgetsTheMinuteItDrew", () => {
    const gate = between(PANE_SOURCE, "window.preman.onResourceSample(apply)", "}, [apply, forget]);");

    expect(gate).toContain("window.preman.watchResources(true)");
    expect(gate).toContain("window.preman.watchResources(false)");
    expect(gate).toContain("unsubscribe()");
    expect(gate).toContain("forget()");
  });

  it("givenTheEngineHostPrefix_whenSpelledInThisSuite_thenItIsStillWhatHostsForksUnder", () => {
    // The prefix is passed into `resources.ts` rather than imported, which is what makes it
    // testable without `electron` — and what would let the two spellings drift apart silently.
    expect(code(HOSTS_SOURCE)).toContain(`SERVICE_NAME_PREFIX = "${ENGINE_PREFIX}"`);
  });
});
