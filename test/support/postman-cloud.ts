/**
 * The captured `/ws/proxy` responses, and an in-process proxy that serves them.
 *
 * Sanitised on capture: no `x-access-token`, no real hostnames, no credential values. Shared by
 * the conversion suite, which composes sources out of these pieces, and the fetch suite, which
 * walks them through a real `ProxyClient` — the same shape as the gRPC harness in `e2e.test.ts`,
 * so no test reaches Postman.
 */
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export const CLOUD_DIR = resolve(here, "../fixtures/postman-cloud");
export const POSTMAN_APPDATA_DIR = resolve(here, "../fixtures/postman-appdata");
/** A directory with no `DevToolsActivePort` in it: Postman is not running. */
export const POSTMAN_NOT_RUNNING_DIR = join(POSTMAN_APPDATA_DIR, "not-running");

export const WORKSPACE_ID = "2a52db72-0b3f-45c5-8242-000000000001";
export const ADAPTER_ID = "11111111-1111-4111-8111-111111111111";
export const GRPC_COLLECTION_ID = "22222222-2222-4222-8222-222222222222";
export const ENVIRONMENT_ID = "33333333-3333-4333-8333-333333333333";

/** Which fixture answers for which item id, keyed the way the proxy addresses them. */
const ITEM_FIXTURES: Readonly<Record<string, string>> = {
  "a0000000-0000-4000-8000-000000000001": "item-folder-legacy",
  "a0000000-0000-4000-8000-000000000002": "item-http-login",
  "a0000000-0000-4000-8000-000000000003": "item-websocket",
  "a0000000-0000-4000-8000-000000000004": "item-http-profile",
  "b0000000-0000-4000-8000-000000000001": "item-grpc-exchange",
};

const COLLECTION_FIXTURES: Readonly<Record<string, string>> = {
  [ADAPTER_ID]: "collection-adapter",
  [GRPC_COLLECTION_ID]: "collection-grpc",
};

const ENVIRONMENT_FIXTURES: Readonly<Record<string, string>> = {
  [ENVIRONMENT_ID]: "environment-staging",
};

const WORKSPACES_PATH = "/workspaces";
const WORKSPACE_PREFIX = "/workspace/";
const ENVIRONMENT_PREFIX = "/environment/";
const COLLECTIONS_PREFIX = "/v3/collections/";
const ITEMS_SEGMENT = "/items/";
const LOOPBACK = "127.0.0.1";
const JSON_CONTENT_TYPE = "application/json";
const ENTITY_TYPE_HEADER = "x-entity-type";
const KIND_KEY = "$kind";
const DATA_KEY = "data";
const OK = 200;
const NOT_FOUND = 404;
const BAD_REQUEST = 400;

const WORKSPACES_SERVICE = "workspaces";
const SYNC_SERVICE = "sync";
const COLLECTION_SERVICE = "collection";

/**
 * The refusals this stands in for, in the vocabulary each one really arrives in: the proxy
 * refuses with `error.name`, the v3 collection service behind it with `error.code`.
 *
 * They are enforced rather than ignored because a fake that answers anything is a fake that
 * hides the bug. Both of these got through a laxer version of this file: `sync /workspaces` is a
 * 404 upstream and was served happily here, and an item read with no `x-entity-type` is a
 * `BAD_REQUEST` upstream and was served happily here too.
 */
interface Refusal {
  readonly key: "name" | "code";
  readonly label: string;
  readonly status: number;
}

const INVALID_SERVICE: Refusal = { key: "name", label: "invalidServiceError", status: BAD_REQUEST };
const INVALID_PATH: Refusal = { key: "name", label: "invalidPathError", status: NOT_FOUND };
const NO_ENTITY_TYPE: Refusal = { key: "code", label: "BAD_REQUEST", status: BAD_REQUEST };
const WRONG_ENTITY_TYPE: Refusal = { key: "code", label: "RESOURCE_NOT_FOUND", status: NOT_FOUND };

export function cloudFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(CLOUD_DIR, `${name}.json`), "utf8"));
}

/** What a fixture says it is, which is what `x-entity-type` has to claim to read it. */
function fixtureKind(name: string): string | undefined {
  const payload = cloudFixture(name) as Record<string, Record<string, unknown> | undefined>;
  const kind = payload[DATA_KEY]?.[KIND_KEY];
  return typeof kind === "string" ? kind : undefined;
}

/** One `/ws/proxy` body, so a suite can assert which calls were made and in what order. */
export interface ProxyRequest {
  service: string;
  method: string;
  path: string;
  token: string | undefined;
  entityType: string | undefined;
}

export interface ProxyTestServer {
  url: string;
  requests: ProxyRequest[];
  close: () => Promise<void>;
}

/** Either the fixture that answers, or the refusal the real proxy would send instead. */
type Resolution = { readonly fixture: string } | { readonly refusal: Refusal };

function named(fixture: string | undefined): Resolution {
  return fixture === undefined ? { refusal: INVALID_PATH } : { fixture };
}

/**
 * An item read, which is the one place `x-entity-type` is load-bearing.
 *
 * The header has to name the item's own `$kind`, so the fixture is its own expectation: no
 * second table to fall out of step with the payloads.
 */
function itemFixture(itemId: string, entityType: string | undefined): Resolution {
  const resolved = named(ITEM_FIXTURES[itemId]);
  if ("refusal" in resolved) return resolved;
  if (entityType === undefined) return { refusal: NO_ENTITY_TYPE };
  return entityType === fixtureKind(resolved.fixture) ? resolved : { refusal: WRONG_ENTITY_TYPE };
}

/** The fixture inside `/v3/collections/…`, whose one prefix addresses two shapes. */
function collectionFixture(path: string, entityType: string | undefined): Resolution {
  const rest = path.slice(COLLECTIONS_PREFIX.length);
  const at = rest.indexOf(ITEMS_SEGMENT);
  if (at < 0) return named(COLLECTION_FIXTURES[rest]);
  return itemFixture(rest.slice(at + ITEMS_SEGMENT.length), entityType);
}

/** What the proxy answers for one call, service and entity-type mismatches included. */
function fixtureFor(service: string, path: string, entityType: string | undefined): Resolution {
  if (path === WORKSPACES_PATH) {
    return service === WORKSPACES_SERVICE ? { fixture: "workspaces" } : { refusal: INVALID_SERVICE };
  }
  if (path.startsWith(WORKSPACE_PREFIX)) {
    return service === SYNC_SERVICE ? { fixture: "workspace" } : { refusal: INVALID_SERVICE };
  }
  if (path.startsWith(ENVIRONMENT_PREFIX)) {
    if (service !== SYNC_SERVICE) return { refusal: INVALID_SERVICE };
    return named(ENVIRONMENT_FIXTURES[path.slice(ENVIRONMENT_PREFIX.length)]);
  }
  if (path.startsWith(COLLECTIONS_PREFIX)) {
    return service === COLLECTION_SERVICE ? collectionFixture(path, entityType) : { refusal: INVALID_SERVICE };
  }
  return { refusal: INVALID_PATH };
}

export interface ProxyServerOptions {
  /** Return this error envelope for every call, to exercise the transport failure path. */
  readonly errorName?: string;
}

/** Boot a local stand-in for `bifrost-https-v4.gw.postman.com/ws/proxy`. */
export function startProxyServer(options: ProxyServerOptions = {}): Promise<ProxyTestServer> {
  const requests: ProxyRequest[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const call = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        service: string;
        method: string;
        path: string;
      };
      const entityType = req.headers[ENTITY_TYPE_HEADER] as string | undefined;
      requests.push({ ...call, token: req.headers["x-access-token"] as string | undefined, entityType });

      const send = (status: number, payload: unknown): void => {
        res.writeHead(status, { "content-type": JSON_CONTENT_TYPE });
        res.end(JSON.stringify(payload));
      };

      if (options.errorName !== undefined) {
        send(OK, { error: { name: options.errorName, message: "refused by the fixture" } });
        return;
      }
      const resolved = fixtureFor(call.service, call.path, entityType);
      if ("refusal" in resolved) {
        const { key, label, status } = resolved.refusal;
        send(status, {
          error: { [key]: label, message: `${call.service} may not read ${call.path}` },
        });
        return;
      }
      send(OK, cloudFixture(resolved.fixture));
    });
  });

  return new Promise((done, fail) => {
    server.once("error", fail);
    server.listen(0, LOOPBACK, () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        fail(new Error("proxy test server did not bind a port"));
        return;
      }
      done({
        url: `http://${LOOPBACK}:${address.port}/ws/proxy`,
        requests,
        close: () => new Promise((closed) => server.close(() => closed())),
      });
    });
  });
}
