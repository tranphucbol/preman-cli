/**
 * A workspace big enough to measure, generated into a temp directory.
 *
 * Generated rather than committed because a thousand YAML files would make every
 * `git status` in this repository slower for one test, and because the number the
 * budget names — 1000 requests — is a parameter, not a fixture.
 *
 * The shape is deliberately the shape of a real workspace: two levels of grouping,
 * request files carrying a message, metadata and two scripts, and an environment
 * beside them. `buildCatalog` parses each file whole, so a stub with three keys in it
 * would measure YAML's fast path and nothing anybody ships.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Deep enough to exercise `parentId`/`depth`, shallow enough to stay a plausible workspace. */
const REQUESTS_PER_FOLDER = 10;
const FOLDERS_PER_COLLECTION = 5;
/** The same gap real workspaces leave, so a generated workspace is reorderable too. */
const ORDER_STEP = 1000;
const ENCODING = "utf8";
const TEMP_PREFIX = "preman-perf-";
const WORKSPACE_ID = "99999999-8888-7777-6666-555555555555";
const ENVIRONMENT_NAME = "PERF";
const COLLECTIONS_DIR = join("postman", "collections");
const ENVIRONMENTS_DIR = join("postman", "environments");
const RESOURCES_DIR = ".resources";
const DEFINITION_FILE = "definition.yaml";
const REQUEST_SUFFIX = ".request.yaml";
const ENVIRONMENT_SUFFIX = ".environment.yaml";
const WORKSPACE_RESOURCES = join(".postman", "resources.yaml");
/** Every other request is HTTP, so the catalog has both protocols to label. */
const HTTP_EVERY = 2;
const PAD = 4;

export interface GeneratedWorkspace {
  root: string;
  /** How many request files were written. */
  requests: number;
  /** Every node `buildCatalog` will emit: the requests plus their folders and collections. */
  nodes: number;
  cleanup: () => void;
}

function pad(value: number): string {
  return String(value).padStart(PAD, "0");
}

function groupDefinition(name: string, order: number): string {
  // `$kind: collection` on folders too: `workspace/collections.ts` derives folder-versus-collection
  // from tree position, so writing `$kind: folder` would invent a convention nothing reads.
  return `$kind: collection\nname: ${name}\norder: ${String(order)}\n`;
}

function grpcRequest(name: string, order: number): string {
  return `$kind: grpc-request
name: ${name}
url: "{{grpc_url}}"
methodPath: perf.v1.PerfService.Measure
message:
  content: |-
    {
      "text": "{{greeting}}",
      "trans_id": "{{trans_id}}",
      "amount": "1"
    }
metadata:
  - key: x-request-id
    value: "{{$guid}}"
settings: {}
schema:
  source: file
  location: ../../../../src/main/proto/perf/perf.proto
scripts:
  - type: beforeInvoke
    language: text/javascript
    code: |-
      pm.environment.set("trans_id", String(Date.now()));
      pm.request.metadata.upsert("x-scripted", "beforeInvoke");
  - type: afterResponse
    language: text/javascript
    code: |-
      pm.test("status is OK", function () {
          pm.expect(pm.response.code).to.equal(0);
      });
order: ${String(order)}
`;
}

function httpRequest(name: string, order: number): string {
  return `$kind: http-request
name: ${name}
method: POST
url: "{{http_url}}/measure"
header:
  - key: content-type
    value: application/json
body:
  mode: raw
  raw: |-
    {
      "text": "{{greeting}}",
      "trans_id": "{{trans_id}}"
    }
scripts:
  - type: prerequest
    language: text/javascript
    code: |-
      pm.environment.set("trans_id", String(Date.now()));
  - type: test
    language: text/javascript
    code: |-
      pm.test("status is 200", function () {
          pm.response.to.have.status(200);
      });
order: ${String(order)}
`;
}

function environment(): string {
  return `name: ${ENVIRONMENT_NAME}
values:
  - key: grpc_url
    value: 127.0.0.1:19099
  - key: http_url
    value: http://127.0.0.1:19099
  - key: greeting
    value: hello
  - key: trans_id
    value: ''
`;
}

function writeText(file: string, text: string): void {
  writeFileSync(file, text, ENCODING);
}

/**
 * Write `requests` requests into a fresh temp workspace and return its root.
 *
 * Counts are derived rather than asked for: a caller cares how many requests the
 * catalog has to parse, not how the tree was arranged to hold them.
 */
export function writeBigWorkspace(requests: number): GeneratedWorkspace {
  const root = mkdtempSync(join(tmpdir(), TEMP_PREFIX));
  const folders = Math.ceil(requests / REQUESTS_PER_FOLDER);
  const collections = Math.ceil(folders / FOLDERS_PER_COLLECTION);

  mkdirSync(join(root, ".postman"), { recursive: true });
  writeText(join(root, WORKSPACE_RESOURCES), `workspace:\n  id: ${WORKSPACE_ID}\nlocalResources:\n  specs: []\n`);

  mkdirSync(join(root, ENVIRONMENTS_DIR), { recursive: true });
  writeText(join(root, ENVIRONMENTS_DIR, `${ENVIRONMENT_NAME}${ENVIRONMENT_SUFFIX}`), environment());

  for (let index = 0; index < collections; index += 1) {
    const name = `Collection ${pad(index)}`;
    const dir = join(root, COLLECTIONS_DIR, name);
    mkdirSync(join(dir, RESOURCES_DIR), { recursive: true });
    writeText(join(dir, RESOURCES_DIR, DEFINITION_FILE), groupDefinition(name, (index + 1) * ORDER_STEP));
  }

  for (let index = 0; index < folders; index += 1) {
    const name = `Folder ${pad(index)}`;
    const collection = `Collection ${pad(Math.floor(index / FOLDERS_PER_COLLECTION))}`;
    const dir = join(root, COLLECTIONS_DIR, collection, name);
    mkdirSync(join(dir, RESOURCES_DIR), { recursive: true });
    writeText(join(dir, RESOURCES_DIR, DEFINITION_FILE), groupDefinition(name, (index + 1) * ORDER_STEP));
  }

  for (let index = 0; index < requests; index += 1) {
    const name = `Request ${pad(index)}`;
    const folder = Math.floor(index / REQUESTS_PER_FOLDER);
    const dir = join(
      root,
      COLLECTIONS_DIR,
      `Collection ${pad(Math.floor(folder / FOLDERS_PER_COLLECTION))}`,
      `Folder ${pad(folder)}`,
    );
    const order = (index + 1) * ORDER_STEP;
    writeText(
      join(dir, `${name}${REQUEST_SUFFIX}`),
      index % HTTP_EVERY === 0 ? grpcRequest(name, order) : httpRequest(name, order),
    );
  }

  return {
    root,
    requests,
    nodes: requests + folders + collections,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
