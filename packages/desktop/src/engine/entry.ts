/**
 * The `utilityProcess` entry. Everything interesting is in `host.ts`; this file only
 * knows how a port arrives and how a message leaves, which is why `host.ts` can be
 * driven by a test without Electron anywhere near it.
 */
import type { MessagePortMain, ParentPort } from "electron";
import { createEngineHost, type EngineHost } from "@preman/desktop/engine/host.js";
import {
  ENGINE_PORT_MESSAGE,
  markPhase,
  PHASES,
  WORKSPACE_ROOT_FLAG,
  type EngineMessage,
  type EngineRequest,
} from "@preman/desktop/engine/protocol.js";

const MISSING_ROOT_EXIT = 1;

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
  process.stderr.write(`engine host started without ${WORKSPACE_ROOT_FLAG}<dir>\n`);
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
});

function attach(port: MessagePortMain): void {
  ports.add(port);
  port.on("message", (event) => {
    const request = event.data as EngineRequest;
    void host.handle(request).then((response) => {
      port.postMessage(response);
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
