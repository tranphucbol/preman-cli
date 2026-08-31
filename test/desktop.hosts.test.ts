/**
 * The host registry, driven without Electron.
 *
 * `utilityProcess.fork` is the one thing this module cannot be tested around, so it is mocked and
 * everything else is real: the same `createOutputTail`, the same failure assembly, the same
 * `execArgv` arithmetic. What the fake gives back is an `EventEmitter` with two streams, which is
 * exactly the shape Electron hands over under `stdio: "pipe"` — so a test can make a host say
 * something and then die, which is the sequence the whole plan is about.
 *
 * The alternative was launching a real Electron. `test/renderer/perf.app.test.ts` does that, takes
 * twelve launches to do it, and is gated behind an environment variable for the trouble.
 */
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { tagLine, type LogLevel } from "@preman/desktop/engine/protocol.js";
import type { HostFailure } from "@preman/desktop/preload/bridge.js";

/** What `utilityProcess.fork` was given, and the handle a test drives the child through. */
interface Forked {
  readonly entryFile: string;
  readonly argv: readonly string[];
  readonly options: Electron.ForkOptions;
  readonly child: FakeChild;
}

/**
 * The three members `hosts.ts` uses, and nothing else.
 *
 * An `EventEmitter` rather than a `PassThrough`, because a real stream delivers `data` on the next
 * tick and every assertion here would then be about a timer instead of about the capture.
 */
class FakeStream extends EventEmitter {
  setEncoding = vi.fn();
  say(chunk: string): void {
    this.emit("data", chunk);
  }
  finish(): void {
    this.emit("end");
  }
}

class FakeChild extends EventEmitter {
  readonly stdout = new FakeStream();
  readonly stderr = new FakeStream();
  postMessage = vi.fn();
  kill = vi.fn();
}

const forks: Forked[] = [];

vi.mock("electron", () => ({
  utilityProcess: {
    fork: (entryFile: string, argv: readonly string[], options: Electron.ForkOptions) => {
      const child = new FakeChild();
      forks.push({ entryFile, argv, options, child });
      return child;
    },
  },
  MessageChannelMain: class {
    port1 = {};
    port2 = {};
  },
}));

const { createHostRegistry } = await import("@preman/desktop/main/hosts.js");
const { HOST_OUTPUT_LINES } = await import("@preman/desktop/main/diagnostics.js");

const ENTRY_FILE = "/dist/engine/entry.js";
const A_ROOT = "/tmp/preman-workspace";
const OTHER_ROOT = "/tmp/preman-elsewhere";
const SERVICE_NAME = "preman-engine-preman-workspace";
const INSPECT_ENV_VAR = "PREMAN_INSPECT";
const CRASH_EXIT = 1;
const CLEAN_EXIT = 0;
/** What Node prints to stderr under `--inspect`: real engine output that carries no level. */
const DEBUGGER_BANNER = "Debugger listening on ws://127.0.0.1:53001/abc";
/** Starts like a tag and is not one. Must survive whole rather than be eaten by the parser. */
const NEAR_MISS_TAG = "<preman:trace>not a level";
/** One more than `HOST_RESPAWN_LIMIT`, which is what it takes to reach a `HostFailure`. */
const EXITS_TO_FAILURE = 4;
const A_STACK = "Error: the workspace is on fire";
const REPORT_PATH = "/logs/report-1-000000.json";
const NO_FLAGS = 0;
const ONE_FORK = 1;
const TWO_FORKS = 2;
const OVERFLOW_LINES = 50;
const INSPECT_HOST = "127.0.0.1:0";

interface Harness {
  readonly failures: HostFailure[];
  /** Every line the registry wrote, rendered the way the log file renders it: level, then prose. */
  readonly written: string[];
  /** The level of each line in {@link Harness.written}, at the same index. */
  readonly levels: LogLevel[];
  readonly registry: ReturnType<typeof createHostRegistry>;
}

function harness(reportPath: string | null = REPORT_PATH): Harness {
  const failures: HostFailure[] = [];
  const written: string[] = [];
  const levels: LogLevel[] = [];
  const registry = createHostRegistry({
    entryFile: ENTRY_FILE,
    onFailure: (failure) => failures.push(failure),
    write: (level, line) => {
      levels.push(level);
      written.push(line);
    },
    writeReport: () => reportPath,
  });
  return { failures, written, levels, registry };
}

/**
 * Burn the respawn budget and answer with the host that will not be respawned again.
 *
 * The tail and the report belong to the host that actually failed, not to the three before it: a
 * respawn is a new process with a new stream, and pooling them would attribute one crash's stack
 * to another. So a test that wants either has to say it on *this* child.
 */
function lastHost(): FakeChild {
  for (let attempt = ONE_FORK; attempt < EXITS_TO_FAILURE; attempt++) {
    forks.at(-1)?.child.emit("exit", CRASH_EXIT);
  }
  const child = forks.at(-1)?.child;
  if (child === undefined) throw new Error("no host was forked");
  return child;
}

/** The exit that exhausts the budget, which is the one that produces a `HostFailure`. */
function crashFinally(): void {
  forks.at(-1)?.child.emit("exit", CRASH_EXIT);
}

beforeEach(() => {
  forks.length = 0;
  delete process.env[INSPECT_ENV_VAR];
});

afterEach(() => {
  delete process.env[INSPECT_ENV_VAR];
});

describe("what a host said before it stopped", () => {
  it("givenAHostThatWritesToStderr_whenItFailsAtLaunch_thenTheFailureDetailsCarryTheTail", () => {
    const { failures, registry } = harness();
    registry.prewarm(A_ROOT);
    lastHost().stderr.say(`${A_STACK}\n`);

    crashFinally();

    expect(failures).toHaveLength(ONE_FORK);
    // The tail is `details[]`, beside the exit code that on its own says nothing about why.
    expect(failures.at(0)?.details).toContain(A_STACK);
    expect(failures.at(0)?.details).toContain(`last exit code: ${String(CRASH_EXIT)}`);
  });

  it("givenAHostThatSaidNothing_whenItFails_thenTheDetailsSaySoRatherThanNothing", () => {
    const { failures, registry } = harness();
    registry.prewarm(A_ROOT);
    lastHost();

    crashFinally();

    expect(failures.at(0)?.details).toContain("the engine wrote nothing before it stopped");
  });

  /**
   * The tail belongs to the host that just died. A respawn is a new process with a new stream, so
   * what the first three said is gone by the time the fourth fails — pooling them would put one
   * crash's stack under another's exit code.
   */
  it("givenAnEarlierHostThatSpoke_whenALaterOneFails_thenItsWordsAreNotBorrowed", () => {
    const { failures, registry } = harness();
    registry.prewarm(A_ROOT);
    forks.at(-1)?.child.stderr.say(`${A_STACK}\n`);
    lastHost();

    crashFinally();

    expect(failures.at(0)?.details).not.toContain(A_STACK);
  });

  it("givenMoreOutputThanTheRing_whenTheHostFails_thenOnlyTheTailIsCarried", () => {
    const { failures, registry } = harness();
    registry.prewarm(A_ROOT);
    const child = lastHost();
    const written = HOST_OUTPUT_LINES + OVERFLOW_LINES;
    for (let index = 0; index < written; index++) child.stderr.say(`line ${String(index)}\n`);

    crashFinally();

    const details = failures.at(0)?.details ?? [];
    expect(details).toContain(`line ${String(written - ONE_FORK)}`);
    expect(details).not.toContain("line 0");
  });

  /**
   * Decision 7. `stdio: "pipe"` otherwise silently takes away the output `bun run desktop` shows
   * today, and the forward is the only thing that gives it back — so it is asserted, not assumed.
   */
  it("givenAHostThatWritesToStderr_whenTheLineIsCaptured_thenItIsAlsoForwardedToTheParent", () => {
    const { written, registry } = harness();
    registry.prewarm(A_ROOT);

    forks.at(-1)?.child.stderr.say(`${A_STACK}\n`);

    expect(written.join("\n")).toContain(A_STACK);
  });

  it("givenAForwardedLine_whenItIsWritten_thenItIsPrefixedWithTheServiceName", () => {
    const { written, registry } = harness();
    registry.prewarm(A_ROOT);

    forks.at(-1)?.child.stdout.say(`${A_STACK}\n`);

    // `at(-1)`, not `at(0)`: the spawn line comes first now, and this is about the prefix.
    expect(written.at(-1)).toBe(`${SERVICE_NAME}: ${A_STACK}`);
  });

  it("givenAHostRegistry_whenAHostIsForked_thenBothStreamsArePiped", () => {
    harness().registry.prewarm(A_ROOT);

    expect(forks.at(0)?.options.stdio).toStrictEqual(["ignore", "pipe", "pipe"]);
  });
});

describe("a Node diagnostic report", () => {
  it("givenAHostThatCrashes_whenTheErrorEventFires_thenThePathIsLoggedAndNotTheReport", () => {
    const { written, registry } = harness();
    registry.prewarm(A_ROOT);
    const report = "x".repeat(HOST_OUTPUT_LINES);

    forks.at(-1)?.child.emit("error", "FatalError", "OnFatalError", report);

    const lines = written.join("\n");
    expect(lines).toContain(REPORT_PATH);
    expect(lines).not.toContain(report);
  });

  it("givenAHostThatCrashed_whenItLaterFails_thenTheReportPathIsInTheDetails", () => {
    const { failures, registry } = harness();
    registry.prewarm(A_ROOT);
    lastHost().emit("error", "FatalError", "OnFatalError", "{}");

    crashFinally();

    expect(failures.at(0)?.details).toContain(`diagnostic report: ${REPORT_PATH}`);
  });

  /** A report that could not be kept must not put a path to nothing in front of the user. */
  it("givenAReportThatCannotBeWritten_whenTheErrorEventFires_thenNoPathIsClaimed", () => {
    const { written, failures, registry } = harness(null);
    registry.prewarm(A_ROOT);
    lastHost().emit("error", "FatalError", "OnFatalError", "{}");

    crashFinally();

    expect(written.join("\n")).toContain("no diagnostic report could be written");
    expect(failures.at(0)?.details.join("\n")).not.toContain("diagnostic report:");
  });
});

/**
 * Before this, a host could be forked, die and be restarted three times without the log holding a
 * single line about it, and the failure at the end of that reached the banner only. A dismissed
 * banner is not a record.
 */
describe("what the log says about a host's life", () => {
  it("givenAFirstFork_whenAHostStarts_thenItIsAnInfoLine", () => {
    const { written, levels, registry } = harness();

    registry.prewarm(A_ROOT);

    expect(written.at(0)).toBe(`${SERVICE_NAME}: engine host started for ${A_ROOT}`);
    expect(levels.at(0)).toBe("info");
  });

  /** The app recovered, so not an error — but an engine that stopped once usually stops again. */
  it("givenAHostThatDies_whenItIsRespawned_thenTheRestartIsAWarning", () => {
    const { written, levels, registry } = harness();
    registry.prewarm(A_ROOT);

    forks.at(-1)?.child.emit("exit", CRASH_EXIT);

    expect(written.at(-1)).toBe(`${SERVICE_NAME}: engine host restarted for ${A_ROOT} (attempt 1)`);
    expect(levels.at(-1)).toBe("warn");
  });

  it("givenAHostPastItsRespawnLimit_whenItFails_thenTheFailureAndItsDetailsReachTheLog", () => {
    const { written, levels, failures, registry } = harness();
    registry.prewarm(A_ROOT);
    lastHost().stderr.say("something went wrong\n");

    crashFinally();

    const logged = written.join("\n");
    expect(logged).toContain(failures.at(0)?.message);
    expect(logged).toContain("  something went wrong");
    expect(levels.at(-1)).toBe("error");
  });

  it("givenAHostThatStopsCleanly_whenItExits_thenNothingIsRestartedAndTheExitIsInfo", () => {
    const { written, levels, registry } = harness();
    registry.prewarm(A_ROOT);

    forks.at(-1)?.child.emit("exit", CLEAN_EXIT);

    expect(forks).toHaveLength(ONE_FORK);
    expect(written.at(-1)).toBe(`${SERVICE_NAME}: engine host exited cleanly for ${A_ROOT}`);
    expect(levels.at(-1)).toBe("info");
  });

  it("givenACrashingHost_whenTheErrorEventFires_thenTheCrashIsFatal", () => {
    const { levels, registry } = harness();
    registry.prewarm(A_ROOT);

    forks.at(-1)?.child.emit("error", "FatalError", "OnFatalError", "{}");

    expect(levels.at(-1)).toBe("fatal");
  });
});

/**
 * The engine writes to a pipe main reads, so main is the only process that can put a level in the
 * file — and it cannot invent one for a line it did not write. The tag is how the engine says it.
 */
describe("the level of a line the engine said", () => {
  it("givenATaggedLine_whenItIsCaptured_thenTheEnginesLevelIsUsedAndTheTagIsStripped", () => {
    const { written, levels, registry } = harness();
    registry.prewarm(A_ROOT);

    forks.at(-1)?.child.stderr.say(`${tagLine("fatal", A_STACK)}\n`);

    expect(written.at(-1)).toBe(`${SERVICE_NAME}: ${A_STACK}`);
    expect(levels.at(-1)).toBe("fatal");
  });

  /** Node's own `Debugger listening on ws://…` has no opinion, and guessing one is not a plan. */
  it("givenAnUntaggedLine_whenItIsCaptured_thenItIsInfo", () => {
    const { written, levels, registry } = harness();
    registry.prewarm(A_ROOT);

    forks.at(-1)?.child.stderr.say(`${DEBUGGER_BANNER}\n`);

    expect(written.at(-1)).toBe(`${SERVICE_NAME}: ${DEBUGGER_BANNER}`);
    expect(levels.at(-1)).toBe("info");
  });

  /** A near miss is somebody else's text. Eating it would lose output to a lookalike. */
  it("givenALineThatOnlyLooksTagged_whenItIsCaptured_thenItIsKeptWhole", () => {
    const { written, levels, registry } = harness();
    registry.prewarm(A_ROOT);

    forks.at(-1)?.child.stderr.say(`${NEAR_MISS_TAG}\n`);

    expect(written.at(-1)).toBe(`${SERVICE_NAME}: ${NEAR_MISS_TAG}`);
    expect(levels.at(-1)).toBe("info");
  });
});

describe("attaching an inspector to an engine host", () => {
  it("givenNoInspectEnvVar_whenAHostIsForked_thenExecArgvIsEmpty", () => {
    harness().registry.prewarm(A_ROOT);

    expect(forks.at(0)?.options.execArgv).toHaveLength(NO_FLAGS);
  });

  it("givenTheInspectEnvVarSetToOne_whenAHostIsForked_thenTheInspectorIsOnAnEphemeralPort", () => {
    process.env[INSPECT_ENV_VAR] = "1";
    harness().registry.prewarm(A_ROOT);

    expect(forks.at(0)?.options.execArgv).toStrictEqual([`--inspect=${INSPECT_HOST}`]);
  });

  it("givenTheInspectEnvVarSetToBrk_whenAHostIsForked_thenTheBreakFlagIsUsed", () => {
    process.env[INSPECT_ENV_VAR] = "brk";
    harness().registry.prewarm(A_ROOT);

    expect(forks.at(0)?.options.execArgv).toStrictEqual([`--inspect-brk=${INSPECT_HOST}`]);
  });

  /** An unreadable debug flag must not stop the app from starting. */
  it("givenAnUnrecognisedInspectValue_whenAHostIsForked_thenNoFlagIsPassedAndNothingThrows", () => {
    process.env[INSPECT_ENV_VAR] = "yes please";

    expect(() => {
      harness().registry.prewarm(A_ROOT);
    }).not.toThrow();
    expect(forks.at(0)?.options.execArgv).toHaveLength(NO_FLAGS);
  });

  /**
   * 9229 belongs to the main process, and this app forks one host per open workspace — so a fixed
   * engine port is a collision the second workspace finds.
   */
  it("givenTwoWorkspaces_whenBothHostsAreForked_thenNeitherAsksForAFixedPort", () => {
    process.env[INSPECT_ENV_VAR] = "1";
    const { registry } = harness();

    registry.prewarm(A_ROOT);
    registry.prewarm(OTHER_ROOT);

    expect(forks).toHaveLength(TWO_FORKS);
    for (const fork of forks) expect(fork.options.execArgv).toStrictEqual([`--inspect=${INSPECT_HOST}`]);
  });
});
