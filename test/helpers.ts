import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { requireWorkspace, type Workspace } from "@preman/core/workspace/discover.js";

const here = dirname(fileURLToPath(import.meta.url));

export const FIXTURES_DIR = resolve(here, "fixtures");
/** The read-only fixture workspace checked into the repo. */
export const FIXTURE_WS = join(FIXTURES_DIR, "ws");
/** A gRPC-free workspace with no `.postman/`, used by the HTTP suites. */
export const FIXTURE_HTTP_WS = join(FIXTURES_DIR, "http-ws");
export const FIXTURE_PROTO = join(FIXTURE_WS, "src/main/proto/echo/echo.proto");
export const FIXTURE_INCLUDE_DIR = join(FIXTURE_WS, "src/main/proto");
export const DATA_DIR = join(FIXTURES_DIR, "data");

/** Committed certificates; regenerate with `test/fixtures/ssl/generate.sh`. */
export const SSL_DIR = join(FIXTURES_DIR, "ssl");
/** Must match PASSPHRASE in `test/fixtures/ssl/generate.sh`. */
export const CLIENT_KEY_PASSPHRASE = "preman-test";

export function sslPath(name: string): string {
  return join(SSL_DIR, name);
}

export function dataPath(name: string): string {
  return join(DATA_DIR, name);
}

export function fixtureWorkspace(): Workspace {
  return requireWorkspace(FIXTURE_WS);
}

export function requestPath(...segments: string[]): string {
  return join(FIXTURE_WS, "postman/collections/payment", ...segments);
}

export interface ClonedWorkspace {
  root: string;
  workspace: Workspace;
  cleanup: () => void;
}

function cloneWorkspace(source: string): ClonedWorkspace {
  const root = mkdtempSync(join(tmpdir(), "preman-ws-"));
  cpSync(source, root, { recursive: true });
  return {
    root,
    workspace: requireWorkspace(root),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/**
 * Copy the fixture workspace into a temp dir so a test can mutate it.
 * Returns the copy's path plus a cleanup function.
 */
export function cloneFixtureWorkspace(): ClonedWorkspace {
  return cloneWorkspace(FIXTURE_WS);
}

/** The HTTP-only workspace, cloned so a test can mutate it. */
export function cloneFixtureHttpWorkspace(): ClonedWorkspace {
  return cloneWorkspace(FIXTURE_HTTP_WS);
}

/** `<root>/postman/collections/<segments...>`, for reaching into a clone. */
export function collectionPath(root: string, ...segments: string[]): string {
  return join(root, "postman/collections", ...segments);
}

/** `.resources/definition.yaml` of a collection or folder inside a clone. */
export function definitionPath(root: string, ...segments: string[]): string {
  return collectionPath(root, ...segments, ".resources/definition.yaml");
}

/**
 * Longer than every debounce a poke can restart — the watcher's 50ms and the engine host's 400ms
 * `git-status`. A shorter interval starves the timer it is waiting on: each write resets the
 * debounce, so the push never fires and the loop times out having caused the failure it reports.
 */
const POKE_INTERVAL_MS = 1_000;

/**
 * Repeat `poke` until `ready` returns true, or fail at `timeoutMs`.
 *
 * Every watcher assertion needs this. A single write straight after `fs.watch` returns is
 * sometimes never delivered on macOS: the FSEvents stream is registered but not yet streaming,
 * so a change made in that gap falls into it and no event ever arrives. "Touch it once and wait"
 * therefore fails a few runs in a hundred for a reason that has nothing to do with the code under
 * test, while "keep touching it until the watcher notices" asserts the same property and cannot
 * pass if the watcher is genuinely broken — it still fails at the deadline.
 *
 * `poke` may be async, and a poke that writes through the engine must be: an unawaited
 * `send` outlives the loop, and a write that lands after the assertion has moved on is a write
 * attributed to the wrong phase of the test. Awaiting keeps at most one in flight.
 */
export async function pokeUntil(
  poke: () => void | Promise<void>,
  ready: () => boolean,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await poke();
    await new Promise((done) => setTimeout(done, POKE_INTERVAL_MS));
    if (ready()) return;
    if (Date.now() >= deadline) throw new Error("the watcher never reported the change");
  }
}

/** The only token `GET /profile` accepts. */
export const HTTP_TOKEN = "jwt-123";
/** Session cookie name the login route sets, and `/profile` echoes back. */
export const HTTP_COOKIE = "sid";
export const HTTP_COOKIE_VALUE = "session-abc";

/** One request the HTTP test server saw, in the shape the suites assert on. */
export interface ReceivedHttp {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  bodyBuffer: Buffer;
}

export interface HttpTestServer {
  /** `http://127.0.0.1:<port>`, ready to interpolate into a fixture url. */
  origin: string;
  received: ReceivedHttp[];
  close: () => Promise<void>;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((done, fail) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => done(Buffer.concat(chunks)));
    req.on("error", fail);
  });
}

function sendJson(
  res: ServerResponse,
  status: number,
  payload: unknown,
  headers: Record<string, string | string[]> = {},
): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(payload));
}

function route(req: IncomingMessage, res: ServerResponse, body: string): void {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const cookies = req.headers.cookie ?? "";

  // The real admin backend deletes the cookie at a legacy path before setting
  // the live one; the jar must keep the second value, not the deletion.
  if (url.pathname === "/login") {
    sendJson(
      res,
      200,
      { reason_code: "SUCCESSFUL", data: { token: HTTP_TOKEN } },
      {
        "set-cookie": [
          `${HTTP_COOKIE}=; Path=/legacy; Max-Age=0`,
          `${HTTP_COOKIE}=${HTTP_COOKIE_VALUE}; Path=/; HttpOnly`,
        ],
      },
    );
    return;
  }
  if (url.pathname === "/profile") {
    if (req.headers.authorization !== `Bearer ${HTTP_TOKEN}`) {
      sendJson(res, 401, { return_code: "UNAUTHENTICATED", message: "bad token" });
      return;
    }
    sendJson(res, 200, {
      return_code: "OK",
      query: Object.fromEntries(url.searchParams),
      cookie: cookies,
      body,
    });
    return;
  }
  if (url.pathname === "/boom") {
    sendJson(res, 401, { return_code: "UNAUTHENTICATED", message: "denied" });
    return;
  }
  if (url.pathname === "/echo") {
    sendJson(res, 200, { method: req.method, query: Object.fromEntries(url.searchParams), body, cookie: cookies });
    return;
  }
  if (url.pathname === "/redirect-echo") {
    res.writeHead(303, { location: "/echo?redirected=true" });
    res.end();
    return;
  }
  if (url.pathname === "/redirect-preserve") {
    res.writeHead(307, { location: "/echo?redirected=true" });
    res.end();
    return;
  }
  if (url.pathname === "/gzip") {
    res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" });
    res.end(gzipSync(Buffer.from(JSON.stringify({ return_code: "OK", squeezed: true }))));
    return;
  }
  if (url.pathname.startsWith("/loop")) {
    res.writeHead(302, { location: `/loop${url.pathname.length}` });
    res.end();
    return;
  }
  sendJson(res, 404, { return_code: "NOT_FOUND", message: `no route for ${url.pathname}` });
}

/** Boot an in-process HTTP server on a random port. Mirrors the gRPC harness in e2e.test.ts. */
export function startHttpServer(): Promise<HttpTestServer> {
  const received: ReceivedHttp[] = [];
  const server: Server = createServer((req, res) => {
    void readBody(req).then((bodyBuffer) => {
      const body = bodyBuffer.toString("utf8");
      received.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body, bodyBuffer });
      route(req, res, body);
    });
  });

  return new Promise((done, fail) => {
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        fail(new Error("http test server did not bind a port"));
        return;
      }
      done({
        origin: `http://127.0.0.1:${address.port}`,
        received,
        close: () => new Promise((closed) => server.close(() => closed())),
      });
    });
  });
}
