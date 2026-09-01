/**
 * One `utilityProcess` per open workspace, spawned lazily and reaped when nothing has
 * wanted it for a while.
 *
 * The main process is not in the request path: it creates a `MessageChannelMain`,
 * hands one end to the engine and the other to the renderer, and then stays out of
 * the way. That is why no message shape from `protocol.ts` is inspected here.
 */
import { basename } from "node:path";
import { MessageChannelMain, utilityProcess, type UtilityProcess, type WebContents } from "electron";
import {
  ENGINE_PORT_MESSAGE,
  markPhase,
  PHASES,
  readTaggedLine,
  WORKSPACE_ROOT_FLAG,
  type LogLevel,
} from "@preman/desktop/engine/protocol.js";
import { createOutputTail, type OutputTail } from "@preman/desktop/main/diagnostics.js";
import { CHANNELS, type HostFailure } from "@preman/desktop/preload/bridge.js";

const HOST_IDLE_MS = 5 * 60_000;
const HOST_RESPAWN_LIMIT = 3;
const CLEAN_EXIT_CODE = 0;
/**
 * Exported because it is the only way back: `getAppMetrics` reports a host as an anonymous
 * `Utility` with this name on it, and stripping the prefix is what turns that row into the
 * workspace it belongs to. `resources.ts` takes it as an argument rather than importing it, so that
 * module can be tested without this one's `electron`.
 */
export const SERVICE_NAME_PREFIX = "preman-engine-";
const SERVICE_NAME_UNSAFE = /[^A-Za-z0-9_-]+/g;
const SERVICE_NAME_REPLACEMENT = "-";
/**
 * `inherit` would put the engine's stderr on the app's own descriptor, where no object in any
 * process can hold a line of it — so a failure could say "last exit code: 1" and nothing about
 * why. Piped, main reads it, keeps the tail, and forwards every line so the terminal still sees it.
 *
 * `stdin` is `ignore`: nothing ever writes to a host, and an open descriptor nobody uses is one
 * more way for a reaped process to fail to close.
 */
const HOST_STDIO: NonNullable<Electron.ForkOptions["stdio"]> = ["ignore", "pipe", "pipe"];
const OUTPUT_ENCODING = "utf8";
const OUTPUT_PREFIX_SEPARATOR = ": ";
/** What the failure says when a host wrote nothing at all before it stopped. */
const NO_OUTPUT_DETAIL = "the engine wrote nothing before it stopped";
const REPORT_DETAIL_PREFIX = "diagnostic report: ";
const NO_REPORT_DETAIL = "no diagnostic report could be written";
const HOST_ERROR_LABEL = "crashed: ";
const HOST_ERROR_AT = " at ";

/**
 * What the registry says about a host's life, so the log has the four restarts in it and not only
 * the failure at the end of them. A respawn is a `warn` and not an `info`: the app recovered, but
 * an engine that stopped once will usually stop again, and the line before the banner is the one
 * that dates the first time.
 */
const SPAWN_LABEL = "engine host started for ";
const RESPAWN_LABEL = "engine host restarted for ";
const RESPAWN_COUNT_PREFIX = " (attempt ";
const RESPAWN_COUNT_SUFFIX = ")";
const EXIT_LABEL = "engine host exited cleanly for ";
const FAILURE_DETAIL_INDENT = "  ";
/** The respawn count a host that has never died carries. */
const FIRST_SPAWN = 0;

/**
 * How an inspector reaches an engine host.
 *
 * `execArgv` is the only way in: a utility process is launched through Chromium's Services API,
 * so `--inspect` on the `electron` binary reaches the main process and nothing else, and the
 * `NODE_OPTIONS` handshake VS Code's Auto Attach depends on never happens either.
 *
 * Port 0, never 9229: that one belongs to the main process, and this app forks one host per open
 * workspace, so a fixed engine port is a collision the second workspace finds. Node prints the
 * chosen URL to stderr, which is captured and forwarded, so it is in the terminal and in the log.
 */
const INSPECT_ENV_VAR = "PREMAN_INSPECT";
const INSPECT_HOST = "127.0.0.1:0";
/** An unreadable debug flag must not stop the app from starting, so an unknown value is no value. */
const INSPECT_ARGS: Readonly<Record<string, readonly string[]>> = {
  "1": [`--inspect=${INSPECT_HOST}`],
  brk: [`--inspect-brk=${INSPECT_HOST}`],
};
const NO_INSPECT_ARGS: readonly string[] = [];
const UNSET = "";

interface Host {
  process: UtilityProcess;
  respawns: number;
  idleTimer: NodeJS.Timeout | undefined;
  /** The last lines this host said, so its failure can carry them. */
  output: OutputTail;
  serviceName: string;
  /** Where this host's Node diagnostic report went, if it produced one. Never the report. */
  reportFile: string | null;
}

export interface HostRegistryOptions {
  /** The built `engine/entry.js`. Passed in so `main.ts` owns every path decision. */
  entryFile: string;
  /** Where a host failure is reported. The renderer shows an error state, not a spinner. */
  onFailure(failure: HostFailure): void;
  /**
   * Where a line goes. One sink rather than a `process.stderr.write` here, so the registry does
   * not have to know whether anything is keeping a file. The level of a captured line is the
   * engine's, read off its tag; the level of a lifecycle line is this module's.
   */
  write(level: LogLevel, line: string): void;
  /**
   * Persist a Node diagnostic report and answer with its path, or `null` if it could not be kept.
   * The path reaches `details[]`; the report never does.
   */
  writeReport(report: string): string | null;
}

export interface HostRegistry {
  /**
   * Start the host for `root` without handing anybody a port.
   *
   * The engine host is a Node process and the window is a Chromium one, and nothing orders
   * them: forking at launch puts the host's startup alongside Chromium's rather than after
   * it. Idempotent, and safe to call for a workspace that is never opened — an unused host
   * is reaped by {@link HostRegistry.release} like any other.
   */
  prewarm(root: string): void;
  /**
   * Make sure a host for `root` exists and give `contents` a fresh port to it.
   * Idempotent: calling it again for a live host re-attaches rather than respawns.
   */
  open(root: string, contents: WebContents): void;
  /** Nothing wants this workspace right now. Starts the idle countdown. */
  release(root: string): void;
  closeAll(): void;
}

export function createHostRegistry(options: HostRegistryOptions): HostRegistry {
  const hosts = new Map<string, Host>();

  function transfer(host: Host, root: string, contents: WebContents): void {
    const channel = new MessageChannelMain();
    host.process.postMessage(ENGINE_PORT_MESSAGE, [channel.port1]);
    contents.postMessage(CHANNELS.enginePort, { root }, [channel.port2]);
    // Still no message shape inspected here: this is a name from the same module as
    // `ENGINE_PORT_MESSAGE`, marking the moment the handshake left this process.
    markPhase(PHASES.mainPortPosted);
  }

  /**
   * Read one of a host's streams a line at a time: keep it, and say it again on this process's
   * own stderr with the host's name in front.
   *
   * Both streams are guarded rather than asserted. Electron's typings make them nullable because
   * they are null under any `stdio` but `pipe`, and a non-null assertion here would be this module
   * promising something `HOST_STDIO` is the only thing enforcing.
   */
  function capture(host: Host, stream: NodeJS.ReadableStream | null): void {
    if (stream === null) return;
    stream.setEncoding(OUTPUT_ENCODING);
    stream.on("data", (chunk: string) => {
      for (const line of host.output.push(chunk)) forward(host, line);
    });
    // A process that died mid-write left its last line without a newline, and that is the line.
    stream.on("end", () => {
      for (const line of host.output.flush()) forward(host, line);
    });
  }

  /**
   * A line the host said, at the level the host meant, with the host's name in front.
   *
   * The tag is read off here rather than left in the file: it exists to cross the pipe, and a
   * reader of `preman.log` should see the level in the level column like every other line.
   */
  function forward(host: Host, line: string): void {
    const tagged = readTaggedLine(line);
    options.write(tagged.level, `${host.serviceName}${OUTPUT_PREFIX_SEPARATOR}${tagged.message}`);
  }

  /** A line about a host rather than from it, so the log can tell the two apart. */
  function say(host: Host, level: LogLevel, line: string): void {
    options.write(level, `${host.serviceName}${OUTPUT_PREFIX_SEPARATOR}${line}`);
  }

  function spawn(root: string, respawns: number): Host {
    // Named after the workspace so a runaway engine is identifiable in Activity Monitor, where
    // every utility process is otherwise just "Node.js" — and so a forwarded line says which host
    // said it without this module inventing an id.
    const serviceName = SERVICE_NAME_PREFIX + basename(root).replace(SERVICE_NAME_UNSAFE, SERVICE_NAME_REPLACEMENT);
    const child = utilityProcess.fork(options.entryFile, [`${WORKSPACE_ROOT_FLAG}${root}`], {
      serviceName,
      stdio: HOST_STDIO,
      execArgv: [...(INSPECT_ARGS[process.env[INSPECT_ENV_VAR] ?? UNSET] ?? NO_INSPECT_ARGS)],
    });
    const host: Host = {
      process: child,
      respawns,
      idleTimer: undefined,
      output: createOutputTail(),
      serviceName,
      reportFile: null,
    };
    capture(host, child.stdout);
    capture(host, child.stderr);
    if (respawns === FIRST_SPAWN) say(host, "info", `${SPAWN_LABEL}${root}`);
    else say(host, "warn", `${RESPAWN_LABEL}${root}${RESPAWN_COUNT_PREFIX}${String(respawns)}${RESPAWN_COUNT_SUFFIX}`);

    // `@experimental` in Electron 43's own typings, and the only thing that depends on it is the
    // report. If it goes in a major, the exit code, the captured tail and `child-process-gone`'s
    // reason all stay; replace this, not the rest.
    child.on("error", (type: string, location: string, report: string) => {
      host.reportFile = options.writeReport(report);
      // `fatal` on both, and said rather than forwarded: a Node diagnostic report is written by a
      // process on its way out, so this is the registry's account of a death, not the host's voice.
      say(host, "fatal", `${HOST_ERROR_LABEL}${type}${HOST_ERROR_AT}${location}`);
      say(host, "fatal", host.reportFile === null ? NO_REPORT_DETAIL : `${REPORT_DETAIL_PREFIX}${host.reportFile}`);
    });

    child.once("exit", (code) => {
      if (hosts.get(root) !== host) return;
      clearIdle(host);
      hosts.delete(root);
      if (code === CLEAN_EXIT_CODE) {
        say(host, "info", `${EXIT_LABEL}${root}`);
        return;
      }
      if (host.respawns >= HOST_RESPAWN_LIMIT) {
        const failure: HostFailure = {
          root,
          message: `the engine for ${root} stopped ${String(HOST_RESPAWN_LIMIT + 1)} times`,
          details: [
            `last exit code: ${String(code)}`,
            ...(host.reportFile === null ? [] : [`${REPORT_DETAIL_PREFIX}${host.reportFile}`]),
            "check the workspace, then reopen it",
            ...tail(host),
          ],
        };
        // The banner is dismissible and the window may not even be there to show it, so the same
        // account goes to the file. Details are indented rather than joined: the tail is in them,
        // and one 200-line log line is a line nobody reads.
        say(host, "error", failure.message);
        for (const detail of failure.details) say(host, "error", `${FAILURE_DETAIL_INDENT}${detail}`);
        options.onFailure(failure);
        return;
      }
      // Respawn without a port: the renderer asks for one when it next needs the host,
      // and a respawn loop that also floods the renderer with ports is worse than one.
      hosts.set(root, spawn(root, host.respawns + 1));
    });

    return host;
  }

  /**
   * What the host said, as further `details[]`.
   *
   * The tail belongs to the host that just died, not to the four before it: a respawned host is a
   * new process with a new stream, and pooling them would attribute one crash's stack to another.
   */
  function tail(host: Host): string[] {
    const lines = host.output.lines();
    return lines.length === 0 ? [NO_OUTPUT_DETAIL] : lines;
  }

  function clearIdle(host: Host): void {
    if (host.idleTimer === undefined) return;
    clearTimeout(host.idleTimer);
    host.idleTimer = undefined;
  }

  function ensure(root: string): Host {
    const existing = hosts.get(root);
    if (existing !== undefined) return existing;
    const host = spawn(root, 0);
    hosts.set(root, host);
    return host;
  }

  return {
    prewarm(root) {
      clearIdle(ensure(root));
    },
    open(root, contents) {
      const host = ensure(root);
      clearIdle(host);
      transfer(host, root, contents);
    },
    release(root) {
      const host = hosts.get(root);
      if (host === undefined) return;
      clearIdle(host);
      host.idleTimer = setTimeout(() => {
        hosts.delete(root);
        host.process.kill();
      }, HOST_IDLE_MS);
      // A reaped host must not keep the app alive at quit time.
      host.idleTimer.unref();
    },
    closeAll() {
      for (const [root, host] of hosts) {
        clearIdle(host);
        hosts.delete(root);
        host.process.kill();
      }
    },
  };
}
