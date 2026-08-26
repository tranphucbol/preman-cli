import { z, type ZodType, type ZodTypeDef } from "zod";
import { EXIT, PremanError } from "@preman/core/errors.js";

/**
 * Shapes returned by Postman's internal RPC proxy.
 *
 * None of this is documented or versioned for consumers (ADR 033). The schemas therefore
 * `.passthrough()` unknown keys — Postman adds fields constantly — but require every field
 * conversion reads, so a shape change fails at the boundary naming the path that returned it
 * rather than producing plausible-looking YAML.
 */

const ROOT_PATH = "<root>";

/** Turn a zod failure into the error a user can act on: what we asked for, and what was wrong. */
export function parseResponse<T>(schema: ZodType<T, ZodTypeDef, unknown>, value: unknown, source: string): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new PremanError(`Postman returned an unexpected shape for ${source}`, {
    exitCode: EXIT.TRANSPORT,
    details: [
      ...parsed.error.issues.map((issue) => `${issue.path.join(".") || ROOT_PATH}: ${issue.message}`),
      "this is an undocumented Postman API; it may have changed",
    ],
  });
}

/**
 * The proxy's failure envelope. `invalidServiceError` means the service is not allowlisted,
 * `invalidPathError` means the path is not, `instanceNotFoundError` means both are fine and
 * the id is missing — the three are worth quoting verbatim because they are the only
 * diagnosis available for an API with no documentation.
 *
 * There are two failure vocabularies behind the one door. The proxy itself refuses with
 * `error.name`; the v3 collection service behind it refuses with `error.code`, as in
 * `{"requestId":…,"error":{"code":"INVALID_REQUEST","message":"invalid format of parameter
 * 'collectionId'"}}`. Both are accepted so that either one is reported as a refusal rather than
 * as a bare HTTP status.
 */
export const proxyErrorSchema = z
  .object({
    error: z
      .object({
        name: z.string().optional(),
        code: z.string().optional(),
        message: z.string().optional(),
      })
      .passthrough()
      .refine(
        (error) => error.name !== undefined || error.code !== undefined,
        "an error envelope names its failure with either `name` or `code`",
      ),
  })
  .passthrough();

const environmentValueSchema = z
  .object({
    key: z.string(),
    value: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
    enabled: z.boolean().optional(),
    type: z.string().optional(),
  })
  .passthrough();

export const cloudEnvironmentSchema = z
  .object({
    name: z.string(),
    values: z.array(environmentValueSchema).optional().default([]),
  })
  .passthrough();

/**
 * `dependencies` carries far more than this — `apis`, `consumableApis`, `flows`, `globals`,
 * `document` — and preman has no representation for any of it. The two collection arrays are the
 * point: the public API can only see `collections`, and every gRPC request in the driving
 * workspace lives in `extensibleCollections`.
 *
 * Every array is ids, never objects. `?populate=true` is what Postman's own client sends and it
 * does not populate these; measured against Postman 12.25.1, a 26-collection workspace answers
 * with 26 strings. Each one is fetched on its own, which is also why `environments` cannot be
 * read out of this payload.
 */
const dependenciesSchema = z
  .object({
    collections: z.array(z.string()).optional().default([]),
    extensibleCollections: z.array(z.string()).optional().default([]),
    environments: z.array(z.string()).optional().default([]),
  })
  .passthrough();

export const workspaceSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    dependencies: dependenciesSchema.optional().default({}),
  })
  .passthrough();

/**
 * `/workspaces` answers with no `type`, so the personal/team split is derived from `team`, which
 * is `null` on a personal workspace and an id on a team one. It is worth deriving rather than
 * dropping: an account commonly holds two workspaces of the same name, one of each, and the list
 * is how a user tells them apart before passing a name to `--workspace`.
 */
const workspaceSummarySchema = z
  .object({
    id: z.string(),
    name: z.string(),
    type: z.string().optional(),
    team: z.union([z.string(), z.number(), z.null()]).optional(),
  })
  .passthrough();

export const workspaceListSchema = z.array(workspaceSummarySchema);

/** One cloud workspace with its dependency lists populated. */
export type CloudWorkspaceDetail = z.infer<typeof workspaceSchema>;

/**
 * Envelope keys the proxy wraps payloads in, unwrapped before validation rather than modelled
 * as a zod union.
 *
 * Accepting both wrapped and bare is not indecision: an undocumented endpoint that gains or
 * loses a wrapper is exactly the change this has to survive. Doing it here rather than in the
 * schema keeps the schemas — and the types they infer — about the payload.
 */
export function unwrapEnvelope(payload: unknown, key: string): unknown {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return payload;
  const record = payload as Record<string, unknown>;
  return key in record ? record[key] : payload;
}

const collectionVariableSchema = z
  .object({
    key: z.string(),
  })
  .passthrough();

const collectionScriptSchema = z
  .object({
    type: z.string(),
  })
  .passthrough();

const collectionAuthSchema = z
  .object({
    type: z.string(),
  })
  .passthrough();

/**
 * A child reference: an id, and what the id is.
 *
 * This is all a parent says about its children. `$kind` is load-bearing rather than informational
 * — it is what the item's own read must claim in `x-entity-type` — and the name is not here at
 * all, which is why the walk in `fetch.ts` cannot avoid a read per item.
 */
export interface CloudItemStub {
  readonly id: string;
  readonly $kind: string;
}

const cloudItemStubSchema = z
  .object({
    id: z.string(),
    $kind: z.string(),
  })
  .passthrough();

/** `/v3/collections/{id}`: a collection, with its children named only by id and kind. */
export const cloudCollectionSchema = z
  .object({
    name: z.string(),
    description: z.string().optional(),
    auth: collectionAuthSchema.optional(),
    scripts: z.array(collectionScriptSchema).optional(),
    variables: z.array(collectionVariableSchema).optional(),
    items: z.array(cloudItemStubSchema).optional().default([]),
  })
  .passthrough();

/**
 * `/v3/collections/{cid}/items/{iid}` — a whole item, checked for the two things the walk needs.
 *
 * `name` is required because it is only here: a parent's `items` array carries ids and kinds, so
 * the tree cannot be labelled without reading every node (ADR 033). `items` is present when the
 * node is a nested collection, and is how the walk descends.
 *
 * Everything else is deliberately not modelled. The payload *is* a preman request, so
 * `convert.ts` checks it against `grpcRequestSchema`/`httpRequestSchema`, the same schemas the
 * runner will use on the file. Validating it twice against two near-identical schemas is how the
 * two drift.
 */
export const itemDetailSchema = z
  .object({
    name: z.string(),
    items: z.array(cloudItemStubSchema).optional().default([]),
  })
  .passthrough();

/** `/v3/collections/{id}` as parsed: named, with its children still only referenced. */
export type CloudCollectionDetail = z.infer<typeof cloudCollectionSchema>;

/** `/v3/collections/{cid}/items/{iid}` as parsed. */
export type CloudItemDetail = z.infer<typeof itemDetailSchema>;

/** A cloud workspace as `preman migrate --list` shows it. */
export interface CloudWorkspace {
  readonly id: string;
  readonly name: string;
  readonly type?: string;
}

/**
 * One node of a fetched Postman tree.
 *
 * `detail` is the raw item response and stays `unknown` on purpose: it is validated in
 * `convert.ts`, at the point that reads it, so the boundary check and the conversion cannot
 * disagree about what a request must contain.
 */
export interface PostmanSourceItem {
  readonly kind: string;
  readonly name: string;
  /** The full item response, for a group as much as for a request. */
  readonly detail?: unknown;
  readonly children: readonly PostmanSourceItem[];
}

export interface PostmanSourceCollection {
  readonly id: string;
  /** The raw `/v3/collections/{id}` response. */
  readonly detail: unknown;
  readonly items: readonly PostmanSourceItem[];
}

/** Everything fetched from one cloud workspace, in the order Postman listed it. */
export interface PostmanWorkspaceSource {
  readonly workspaceId: string;
  readonly name: string;
  readonly collections: readonly PostmanSourceCollection[];
  /** Raw populated environments from `dependencies.environments`. */
  readonly environments: readonly unknown[];
}
