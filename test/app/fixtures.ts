import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FIXTURE_HTTP_WS, startHttpServer, type HttpTestServer } from "../helpers.js";

const ENVIRONMENT_FILE = "postman/environments/QC.environment.yaml";
/** The fixture leaves the origin empty; the CLI suites fill it with `--var`, which the app has not. */
const EMPTY_ORIGIN = "key: http_url\n    value: ''";
const ENCODING = "utf8";
const PARENT_PREFIX = "preman-app-ws-";
/** The app titles a workspace after its folder, so this is the name a screenshot shows. */
const DEFAULT_NAME = "admin-api";

export const HTTP_ENVIRONMENT = "QC";

export interface HttpWorkspace {
  root: string;
  server: HttpTestServer;
  dispose: () => Promise<void>;
}

/** A copy of `test/fixtures/http-ws` whose `QC` environment points at a live in-process server. */
export async function httpWorkspace(name = DEFAULT_NAME): Promise<HttpWorkspace> {
  const server = await startHttpServer();
  const parent = mkdtempSync(join(tmpdir(), PARENT_PREFIX));
  const root = join(parent, name);
  cpSync(FIXTURE_HTTP_WS, root, { recursive: true });
  const file = join(root, ENVIRONMENT_FILE);
  const source = readFileSync(file, ENCODING);
  if (!source.includes(EMPTY_ORIGIN)) throw new Error(`${ENVIRONMENT_FILE} no longer has an empty http_url.`);
  writeFileSync(file, source.replace(EMPTY_ORIGIN, `key: http_url\n    value: '${server.origin}'`), ENCODING);
  return {
    root,
    server,
    dispose: async () => {
      await server.close();
      rmSync(parent, { recursive: true, force: true });
    },
  };
}
