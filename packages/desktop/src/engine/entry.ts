/**
 * The `utilityProcess` entry. Everything interesting is in `host.ts`; this file only
 * knows how a port arrives and how a message leaves, which is why `host.ts` can be
 * driven by a test without Electron anywhere near it.
 */
import type { MessagePortMain, ParentPort } from "electron";
import { createEngineHost, type EngineHost } from "@preman/desktop/engine/host.js";
import {
  ENGINE_PORT_MESSAGE,
  EXIT_CODES,
  markPhase,
  PHASES,
  tagLine,
  WORKSPACE_ROOT_FLAG,
  type EngineMessage,
  type EngineRequest,
  type LogLevel,
} from "@preman/desktop/engine/protocol.js";

// The first statement of the module body, for the reason `main/main.ts` gives: this process is
// forked by Electron with an `execArgv` this file does not control, so the flag has to be a call.
// A stack from a bundled engine that names a column of `entry.js` costs the reader the file it
// came from, which is the one thing a crash report is for.
process.setSourceMapsEnabled(true);

const MISSING_ROOT_EXIT = 1;
/** What a request gets when `handle`'s own catch was the thing that threw. */
const HANDLE_FAILED_MESSAGE = "the engine could not answer this request";
const HANDLE_FAILED_DETAILS = ["this is a bug in the engine host", "the log has the stack"];

/**
 * Everything this process says, in one place, on the pipe main is reading.
 *
 * `stdio` is `["ignore", "pipe", "pipe"]` in `hosts.ts`, so this reaches main's capture, main's
 * stderr and main's log file. Nothing here opens a file: one log, one writer.
 *
 * Tagged, because main is that writer and cannot otherwise tell an engine stack trace from Node's
 * own `Debugger listening on ws://…`. Main strips the tag before the line reaches the file.
 */
function say(level: LogLevel, line: string): void {
  process.stderr.write(`${tagLine(level, line)}\n`);
}

/**
 * Observe and die. **Monitor**, not `uncaughtException`: a handler that swallowed would leave a
 * host that is alive, portless and answering nothing, which is a hang wearing a crash's clothes.
 */
process.on("uncaughtExceptionMonitor", (cause) => {
  say("fatal", `uncaught exception in the engine host: ${cause.stack ?? cause.message}`);
});

// `error` rather than `fatal`, for the reason `main/main.ts` gives: the monitor above says the
// `fatal` when Node promotes this to an uncaught exception, and one death deserves one line.
process.on("unhandledRejection", (cause) => {
  say(
    "error",
    `unhandled rejection in the engine host: ${cause instanceof Error ? (cause.stack ?? cause.message) : String(cause)}`,
  );
});

/** `process.parentPort` exists only inside a `utilityProcess`, so it is not on the Node types. */
interface UtilityProcess {
  parentPort: ParentPort;
}

function workspaceRoot(argv: readonly string[]): string | undefined {
  const flag = argv.find((argument) => argument.startsWith(WORKSPACE_ROOT_FLAG));
  return flag?.slice(WORKSPACE_ROOT_FLAG.length);
}

const root = workspaceRoot(process.argv);
if (root === undefined || root.length === 0) {
  say("fatal", `engine host started without ${WORKSPACE_ROOT_FLAG}<dir>`);
  process.exit(MISSING_ROOT_EXIT);
}

// After the root check, not before it: a host that exits for want of a root never started, and a
// timeline with a start and no catalog in it would read as a build that hung.
markPhase(PHASES.engineStart);

const parentPort = (process as unknown as UtilityProcess).parentPort;
/** More than one because a workspace switched back to re-attaches rather than respawns. */
const ports = new Set<MessagePortMain>();

const host: EngineHost = createEngineHost({
  root,
  post: (message: EngineMessage) => {
    for (const port of ports) port.postMessage(message);
  },
  log: say,
});

function attach(port: MessagePortMain): void {
  ports.add(port);
  port.on("message", (event) => {
    const request = event.data as EngineRequest;
    void host
      .handle(request)
      .then((response) => {
        port.postMessage(response);
      })
      // `handle` catches its own failures, so reaching here means the catch threw. Answering
      // anyway is the point: the renderer is holding a promise, and a request that never settles
      // is a spinner nobody can end.
      .catch((cause: unknown) => {
        say(
          "error",
          `the engine host failed to answer: ${cause instanceof Error ? (cause.stack ?? cause.message) : String(cause)}`,
        );
        port.postMessage({
          id: request.id,
          ok: false,
          error: { message: HANDLE_FAILED_MESSAGE, details: [...HANDLE_FAILED_DETAILS], exitCode: EXIT_CODES.CLI },
        });
      });
  });
  port.on("close", () => {
    ports.delete(port);
  });
  port.start();
}

parentPort.on("message", (event) => {
  if (event.data !== ENGINE_PORT_MESSAGE) return;
  for (const port of event.ports) attach(port);
});

process.on("exit", () => {
  host.dispose();
});
