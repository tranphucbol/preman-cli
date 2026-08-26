import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { EXIT, PremanError } from "@preman/core/errors.js";
import { parseResponse } from "./model.js";

/**
 * Getting a token out of a running Postman Desktop, and nothing else.
 *
 * preman never handles a password and never drives a login form (ADR 033). It attaches to
 * Postman's own DevTools port and reads one `localStorage` key off the signed-in window. That is
 * a debugger on another vendor's application, which ADR 033 records as the cost of the only route
 * that can carry gRPC.
 *
 * Read over `DOMStorage`, not `Runtime.evaluate`: the storage domain is a read-only accessor, so
 * nothing is injected into Postman's page and no script of ours ever runs in it. An earlier
 * version watched `Network.requestWillBeSent` for an `x-access-token` header instead, which is
 * even less invasive and does not work — measured against Postman 12.25.1, an idle window sends
 * nothing but New Relic telemetry, so the wait expired on a perfectly healthy sign-in.
 */

/** Chromium writes the debugging port on line 1 and a browser-scoped path on line 2. */
const DEVTOOLS_PORT_FILE = "DevToolsActivePort";
const LOOPBACK = "127.0.0.1";
const TARGET_LIST_PATH = "/json/list";
/** Postman's renderer is served from this host; other targets are its background pages. */
const POSTMAN_PAGE_HOST = "desktop.postman.com";
const PAGE_TARGET_TYPE = "page";

/** Where the signed-in window keeps the token, and where it says which team it is scoped to. */
const ACCESS_TOKEN_KEY = "access_token";
const TEAM_ID_PARAM = "teamId";

const DOM_STORAGE_ENABLE = "DOMStorage.enable";
const GET_DOM_STORAGE_ITEMS = "DOMStorage.getDOMStorageItems";
const ENABLE_MESSAGE_ID = 1;
const READ_MESSAGE_ID = 2;

/**
 * A ceiling on two loopback round trips, not a wait for anything to happen. Postman either has a
 * token in storage or the user is signed out, and both answers arrive immediately.
 */
const HARVEST_TIMEOUT_MS = 10_000;
const SIGN_IN_ADVICE = "open Postman Desktop and sign in, then try again";

/** A token good for one migration. Never written to disk, never logged. */
export interface PostmanSession {
  readonly accessToken: string;
  /** Absent for a personal workspace; Postman sends it only for team-scoped calls. */
  readonly teamId: string | undefined;
}

const targetSchema = z
  .object({
    type: z.string(),
    url: z.string(),
    webSocketDebuggerUrl: z.string().optional(),
  })
  .passthrough();

const targetListSchema = z.array(targetSchema);

/** `DOMStorage.getDOMStorageItems` answers with `entries: [[key, value], …]`. */
const storageReplySchema = z
  .object({
    id: z.number(),
    result: z
      .object({
        entries: z.array(z.array(z.string())),
      })
      .passthrough()
      .optional(),
    error: z
      .object({
        message: z.string(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

function usage(message: string, details: string[]): PremanError {
  return new PremanError(message, { exitCode: EXIT.CLI, details });
}

/** The debugging port Postman is listening on, or an error saying how to make one exist. */
function readDebugPort(postmanAppData: string): number {
  const file = join(postmanAppData, DEVTOOLS_PORT_FILE);
  if (!existsSync(file)) {
    throw usage("Postman Desktop does not appear to be running", [`no ${file}`, SIGN_IN_ADVICE]);
  }
  const first = readFileSync(file, "utf8").split("\n", 1)[0]?.trim() ?? "";
  const port = Number.parseInt(first, 10);
  if (!Number.isInteger(port) || port <= 0) {
    throw usage(`could not read a debugging port from ${file}`, [`line 1 was "${first}"`, SIGN_IN_ADVICE]);
  }
  return port;
}

async function readTargetList(port: number): Promise<unknown> {
  const url = `http://${LOOPBACK}:${port}${TARGET_LIST_PATH}`;
  let response: Response;
  try {
    response = await fetch(url);
  } catch (cause) {
    throw new PremanError(`could not reach Postman Desktop on port ${port}`, {
      exitCode: EXIT.TRANSPORT,
      details: [(cause as Error).message, SIGN_IN_ADVICE],
    });
  }
  if (!response.ok) {
    throw new PremanError(`Postman Desktop answered ${response.status} on ${TARGET_LIST_PATH}`, {
      exitCode: EXIT.TRANSPORT,
      details: [SIGN_IN_ADVICE],
    });
  }
  return response.json();
}

/** Postman's main window: the one page target, and the URL that names its team. */
interface WindowTarget {
  readonly debuggerUrl: string;
  readonly pageUrl: string;
}

/** The main window. Postman's other targets are workers, which have no storage of their own. */
function pickWindowTarget(targets: unknown, port: number): WindowTarget {
  const list = parseResponse(targetListSchema, targets, TARGET_LIST_PATH);
  for (const target of list) {
    if (target.type !== PAGE_TARGET_TYPE) continue;
    if (!target.url.includes(POSTMAN_PAGE_HOST)) continue;
    if (target.webSocketDebuggerUrl !== undefined) {
      return { debuggerUrl: target.webSocketDebuggerUrl, pageUrl: target.url };
    }
  }
  throw usage(`Postman Desktop is listening on port ${port} but its main window was not found`, [
    `no ${PAGE_TARGET_TYPE} target served from ${POSTMAN_PAGE_HOST}`,
    SIGN_IN_ADVICE,
  ]);
}

/**
 * The team the window is signed in to, from its own URL.
 *
 * Postman puts `userId`, `teamId` and `region` in the renderer's query string, so the team is
 * known without asking for it. A personal account has no team, and the header is then omitted.
 */
function teamIdFrom(pageUrl: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(pageUrl);
  } catch {
    // A window URL we cannot parse is not fatal: the team header is optional.
    return undefined;
  }
  const teamId = parsed.searchParams.get(TEAM_ID_PARAM);
  return teamId === null || teamId.length === 0 ? undefined : teamId;
}

/** The `[key, value]` pairs come back in storage order, so the key is looked up rather than indexed. */
function entryValue(entries: readonly string[][], key: string): string | undefined {
  for (const entry of entries) {
    if (entry[0] === key) return entry[1];
  }
  return undefined;
}

/**
 * Ask the window for its `localStorage`, and read one key out of the answer.
 *
 * Two commands, both reads: `DOMStorage.enable` then `DOMStorage.getDOMStorageItems`. Nothing is
 * injected, nothing is evaluated, no navigation is triggered. The token belongs to the signed-in
 * user and is used to read that user's own data.
 */
function readStoredToken(target: WindowTarget): Promise<PostmanSession> {
  if (typeof WebSocket === "undefined") {
    throw usage("this Node build has no WebSocket", [
      "migration attaches to Postman Desktop over a WebSocket; Node 22 or newer provides one",
    ]);
  }

  const origin = new URL(target.pageUrl).origin;

  return new Promise<PostmanSession>((done, fail) => {
    const socket = new WebSocket(target.debuggerUrl);

    function stop(): void {
      clearTimeout(timer);
      socket.close();
    }
    function succeed(session: PostmanSession): void {
      stop();
      done(session);
    }
    function abandon(error: PremanError): void {
      stop();
      fail(error);
    }

    const timer = setTimeout(() => {
      abandon(
        usage("Postman Desktop did not answer in time", [
          `waited ${HARVEST_TIMEOUT_MS}ms for its ${ACCESS_TOKEN_KEY}`,
          SIGN_IN_ADVICE,
        ]),
      );
    }, HARVEST_TIMEOUT_MS);

    socket.addEventListener("error", () => {
      abandon(
        new PremanError(`could not attach to Postman Desktop at ${target.debuggerUrl}`, {
          exitCode: EXIT.TRANSPORT,
          details: [SIGN_IN_ADVICE],
        }),
      );
    });

    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ id: ENABLE_MESSAGE_ID, method: DOM_STORAGE_ENABLE, params: {} }));
      socket.send(
        JSON.stringify({
          id: READ_MESSAGE_ID,
          method: GET_DOM_STORAGE_ITEMS,
          params: { storageId: { securityOrigin: origin, isLocalStorage: true } },
        }),
      );
    });

    socket.addEventListener("message", (event: MessageEvent) => {
      if (typeof event.data !== "string") return;
      let frame: unknown;
      try {
        frame = JSON.parse(event.data);
      } catch {
        // CDP interleaves events with replies; an unreadable frame is not ours to fail on.
        return;
      }
      const parsed = storageReplySchema.safeParse(frame);
      if (!parsed.success || parsed.data.id !== READ_MESSAGE_ID) return;

      const failure = parsed.data.error;
      if (failure !== undefined) {
        abandon(
          usage(`Postman Desktop refused to read its own storage: ${failure.message}`, [
            `asked for ${origin} localStorage over ${GET_DOM_STORAGE_ITEMS}`,
            SIGN_IN_ADVICE,
          ]),
        );
        return;
      }

      const accessToken = entryValue(parsed.data.result?.entries ?? [], ACCESS_TOKEN_KEY);
      if (accessToken === undefined || accessToken.length === 0) {
        abandon(
          usage("Postman Desktop is running but nobody is signed in", [
            `no ${ACCESS_TOKEN_KEY} in the window's storage`,
            SIGN_IN_ADVICE,
          ]),
        );
        return;
      }
      succeed({ accessToken, teamId: teamIdFrom(target.pageUrl) });
    });
  });
}

/**
 * Read one access token out of a running, signed-in Postman Desktop.
 *
 * `postmanAppData` is a parameter rather than a `homedir()` call inside, the injection pattern
 * `createWorkspace` uses, so a test can point the failure paths at a fixture directory.
 */
export async function harvestToken(postmanAppData: string): Promise<PostmanSession> {
  const port = readDebugPort(postmanAppData);
  return readStoredToken(pickWindowTarget(await readTargetList(port), port));
}
