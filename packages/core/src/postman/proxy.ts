import { EXIT, PremanError } from "@preman/core/errors.js";
import { proxyErrorSchema } from "./model.js";
import type { PostmanSession } from "./session.js";

/**
 * One POST, and every read a migration performs goes through it.
 *
 * `/ws/proxy` is Postman's internal RPC front door: an allowlisted service name, a method and a
 * path. It is the only route that can see `extensibleCollections`, and therefore the only route
 * that can see a gRPC request (ADR 033). It is undocumented, unversioned for
 * consumers and can be revoked, which is why it is confined to this directory and reachable
 * only from `migrateCloudWorkspace`.
 */

const DEFAULT_PROXY_URL = "https://bifrost-https-v4.gw.postman.com/ws/proxy";
const DEFAULT_METHOD = "GET";
const ACCESS_TOKEN_HEADER = "x-access-token";
const TEAM_ID_HEADER = "x-entity-team-id";
const ENTITY_TYPE_HEADER = "x-entity-type";
const CONTENT_TYPE_HEADER = "content-type";
const JSON_CONTENT_TYPE = "application/json";

/**
 * Postman's own service names, which split by noun rather than by layer.
 *
 * `workspaces` lists them, `sync` reads one workspace and one environment, `collection` reads
 * inside a collection. They are not interchangeable: `sync /workspaces` is a 404 and
 * `workspaces /workspace/{id}` is an `invalidPathError`, so each path is bound to exactly one.
 */
export const WORKSPACES_SERVICE = "workspaces";
export const SYNC_SERVICE = "sync";
export const COLLECTION_SERVICE = "collection";

export interface ProxyCall {
  readonly service: string;
  readonly path: string;
  /** Defaults to `GET`; migration never writes, so nothing else is used today. */
  readonly method?: string;
  /**
   * `x-entity-type`, and it is not optional where the item endpoint is concerned.
   *
   * `/v3/collections/{cid}/items/{iid}` answers `BAD_REQUEST` without this header and
   * `RESOURCE_NOT_FOUND` when it disagrees with the item's own `$kind` — the same id is a
   * different resource depending on what you claim it is. It lives on the call rather than on the
   * client because it varies per item (ADR 033).
   */
  readonly entityType?: string;
}

export type ProxyClient = (call: ProxyCall) => Promise<unknown>;

/**
 * The three envelope names the proxy answers with, and what each one means.
 *
 * Worth naming rather than collapsing into "request failed": they are the only diagnosis an
 * undocumented API offers, and they distinguish "Postman revoked this" from "your id is wrong".
 */
const ERROR_ADVICE: Readonly<Record<string, string>> = {
  invalidServiceError: "Postman no longer allows this service through the proxy",
  invalidPathError: "Postman no longer allows this path through the proxy",
  instanceNotFoundError: "the service and path are valid but the id does not exist for this account",
};

function transport(message: string, details: string[]): PremanError {
  return new PremanError(message, { exitCode: EXIT.TRANSPORT, details });
}

/**
 * Bind a session to the proxy, returning the one function every fetch goes through.
 *
 * `url` is a parameter so a test can point the whole client at an in-process server; core never
 * reaches the real host in a test suite.
 */
export function postmanProxy(session: PostmanSession, url: string = DEFAULT_PROXY_URL): ProxyClient {
  const headers: Record<string, string> = {
    [CONTENT_TYPE_HEADER]: JSON_CONTENT_TYPE,
    [ACCESS_TOKEN_HEADER]: session.accessToken,
  };
  // Postman sends the team header only when the account has a team; forging an empty one is a 401.
  if (session.teamId !== undefined) headers[TEAM_ID_HEADER] = session.teamId;

  return async (call: ProxyCall): Promise<unknown> => {
    const body = JSON.stringify({ service: call.service, method: call.method ?? DEFAULT_METHOD, path: call.path });
    const callHeaders = call.entityType === undefined ? headers : { ...headers, [ENTITY_TYPE_HEADER]: call.entityType };
    let response: Response;
    try {
      response = await fetch(url, { method: "POST", headers: callHeaders, body });
    } catch (cause) {
      throw transport(`could not reach the Postman proxy for ${call.service} ${call.path}`, [
        (cause as Error).message,
        "migration needs network access to Postman",
      ]);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (cause) {
      throw transport(`the Postman proxy returned ${response.status} and no JSON for ${call.path}`, [
        (cause as Error).message,
      ]);
    }

    const failure = proxyErrorSchema.safeParse(payload);
    if (failure.success) {
      const { name, code, message } = failure.data.error;
      // `name` is the proxy's own vocabulary, `code` the v3 service's behind it; the schema
      // guarantees one of them, so this cannot fall through to a bare status.
      const label = name ?? code ?? "";
      const advice = ERROR_ADVICE[label];
      throw transport(`the Postman proxy refused ${call.service} ${call.path}: ${label}`, [
        ...(message === undefined ? [] : [message]),
        ...(advice === undefined ? [] : [advice]),
      ]);
    }
    if (!response.ok) {
      throw transport(`the Postman proxy answered ${response.status} for ${call.service} ${call.path}`, [
        "the token may have expired; bring Postman Desktop to the front and try again",
      ]);
    }
    return payload;
  };
}
