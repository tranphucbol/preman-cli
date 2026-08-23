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
import { ENGINE_PORT_MESSAGE, WORKSPACE_ROOT_FLAG } from "@preman/desktop/engine/protocol.js";
import { CHANNELS, type HostFailure } from "@preman/desktop/preload/bridge.js";

const HOST_IDLE_MS = 5 * 60_000;
const HOST_RESPAWN_LIMIT = 3;
const CLEAN_EXIT_CODE = 0;
const SERVICE_NAME_PREFIX = "preman-engine-";
const SERVICE_NAME_UNSAFE = /[^A-Za-z0-9_-]+/g;
const SERVICE_NAME_REPLACEMENT = "-";

interface Host {
  process: UtilityProcess;
  respawns: number;
  idleTimer: NodeJS.Timeout | undefined;
}

export interface HostRegistryOptions {
  /** The built `engine/entry.js`. Passed in so `main.ts` owns every path decision. */
  entryFile: string;
  /** Where a host failure is reported. The renderer shows an error state, not a spinner. */
  onFailure(failure: HostFailure): void;
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
  }

  function spawn(root: string, respawns: number): Host {
    const child = utilityProcess.fork(options.entryFile, [`${WORKSPACE_ROOT_FLAG}${root}`], {
      // Named after the workspace so a runaway engine is identifiable in Activity
      // Monitor, where every utility process is otherwise just "Node.js".
      serviceName: SERVICE_NAME_PREFIX + basename(root).replace(SERVICE_NAME_UNSAFE, SERVICE_NAME_REPLACEMENT),
      stdio: "inherit",
    });
    const host: Host = { process: child, respawns, idleTimer: undefined };

    child.once("exit", (code) => {
      if (hosts.get(root) !== host) return;
      clearIdle(host);
      hosts.delete(root);
      if (code === CLEAN_EXIT_CODE) return;
      if (host.respawns >= HOST_RESPAWN_LIMIT) {
        options.onFailure({
          root,
          message: `the engine for ${root} stopped ${String(HOST_RESPAWN_LIMIT + 1)} times`,
          details: [`last exit code: ${String(code)}`, "check the workspace, then reopen it"],
        });
        return;
      }
      // Respawn without a port: the renderer asks for one when it next needs the host,
      // and a respawn loop that also floods the renderer with ports is worse than one.
      hosts.set(root, spawn(root, host.respawns + 1));
    });

    return host;
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
