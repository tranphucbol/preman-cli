import { z } from "zod";

/**
 * Schemas for the Postman *filesystem* format (`.postman/` + `postman/`).
 *
 * Strategy: be strict about the fields we actually consume, and `passthrough()`
 * everything else so a Postman format bump adds fields without breaking us.
 */

export const resourcesFileSchema = z
  .object({
    workspace: z.object({ id: z.string().optional() }).passthrough().optional(),
    localResources: z
      .object({
        specs: z.array(z.string()).optional(),
        collections: z.array(z.string()).optional(),
        environments: z.array(z.string()).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export const collectionDefinitionSchema = z
  .object({
    $kind: z.literal("collection").optional(),
    name: z.string().optional(),
  })
  .passthrough();

export const folderDefinitionSchema = z
  .object({
    $kind: z.string().optional(),
    name: z.string().optional(),
  })
  .passthrough();

const scriptSchema = z
  .object({
    /** `beforeInvoke` for gRPC, `prerequest` for HTTP, `test`/`afterResponse` post-call. */
    type: z.string(),
    language: z.string().optional(),
    code: z.string().optional(),
  })
  .passthrough();

const requestSchemaRef = z
  .object({
    source: z.string().optional(),
    /** Path to a .proto file, relative to the request file. */
    location: z.string().optional(),
  })
  .passthrough();

export const grpcRequestSchema = z
  .object({
    $kind: z.literal("grpc-request"),
    name: z.string(),
    url: z.string().optional().default(""),
    methodPath: z.string(),
    /** base64 FileDescriptorSet embedded by the Postman client. */
    methodDescriptor: z.string().optional(),
    message: z
      .object({ content: z.string().optional() })
      .passthrough()
      .optional(),
    metadata: z
      .array(z.object({ key: z.string(), value: z.string().optional() }).passthrough())
      .optional(),
    auth: z.unknown().optional(),
    settings: z.record(z.unknown()).optional(),
    schema: requestSchemaRef.optional(),
    scripts: z.array(scriptSchema).optional(),
    order: z.number().optional(),
  })
  .passthrough();

const scalarSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

/**
 * Headers and query params appear in two shapes in real exports: a plain YAML map
 * (`{X-CSRF-Token: abc}`) and a Postman-style array of entries. Both are accepted
 * here; `src/http/headers.ts` normalises them so a bad shape reads as a `CliError`
 * with details rather than a zod dump.
 */
const keyValueSourceSchema = z.union([
  z.record(scalarSchema),
  z.array(
    z
      .object({
        key: z.string(),
        value: scalarSchema.optional(),
        disabled: z.boolean().optional(),
      })
      .passthrough(),
  ),
]);

export const httpRequestSchema = z
  .object({
    $kind: z.literal("http-request"),
    /** Optional on purpose: almost every real file omits it and relies on the filename. */
    name: z.string().optional(),
    description: z.string().optional(),
    url: z.string(),
    method: z.string().optional().default("GET"),
    headers: keyValueSourceSchema.optional(),
    queryParams: keyValueSourceSchema.optional(),
    body: z
      .object({
        /** `json`, `text`, `xml`, ... Only used to pick a default `content-type`. */
        type: z.string().optional(),
        content: z.string().optional(),
      })
      .passthrough()
      .optional(),
    auth: z
      .object({
        type: z.string(),
        credentials: z.record(z.unknown()).optional(),
      })
      .passthrough()
      .optional(),
    settings: z.record(z.unknown()).optional(),
    scripts: z.array(scriptSchema).optional(),
    order: z.number().optional(),
  })
  .passthrough();

/**
 * Recognised but unimplemented. Parsed loosely on purpose: we only need `$kind`
 * and `name` to produce a good "not supported yet" message.
 */
export const otherRequestSchema = z
  .object({
    $kind: z.string(),
    name: z.string().optional(),
    order: z.number().optional(),
  })
  .passthrough();

export const environmentSchema = z
  .object({
    name: z.string().optional(),
    values: z
      .array(
        z
          .object({
            key: z.string(),
            value: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
            enabled: z.boolean().optional(),
            type: z.string().optional(),
          })
          .passthrough(),
      )
      .optional()
      .default([]),
  })
  .passthrough();

export type ResourcesFile = z.infer<typeof resourcesFileSchema>;
export type GrpcRequest = z.infer<typeof grpcRequestSchema>;
export type HttpRequest = z.infer<typeof httpRequestSchema>;
export type KeyValueSource = z.infer<typeof keyValueSourceSchema>;
export type OtherRequest = z.infer<typeof otherRequestSchema>;
export type EnvironmentFile = z.infer<typeof environmentSchema>;
export type RequestScript = z.infer<typeof scriptSchema>;
