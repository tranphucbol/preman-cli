import { existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import * as protoLoader from "@grpc/proto-loader";
import type { MethodDefinition, PackageDefinition, ServiceDefinition } from "@grpc/proto-loader";
import { PremanError } from "@preman/core/errors.js";

/**
 * Load options are load-bearing for this repo's payloads:
 * - `keepCase`  keeps `source_asset` / `product_code` snake_case as written in the request
 * - `longs`     keeps 64-bit values like `transaction_amount` and 19-digit ids lossless
 * - `enums`     lets `"ACQUIRING_SYSTEM"` / `"PLATFORM_ZPA"` be written as strings
 * - `defaults`  off, so we send exactly the fields the request specifies
 */
export const LOAD_OPTIONS: protoLoader.Options = {
  keepCase: true,
  longs: String,
  enums: String,
  bytes: String,
  defaults: false,
  oneofs: true,
};

export type SchemaSource = "proto-file" | "descriptor";

export interface ResolvedMethod {
  /** Fully-qualified service name, e.g. `pe.aev2.ExchangeService`. */
  serviceName: string;
  /** Method name as declared in the proto, e.g. `Exchange`. */
  methodName: string;
  definition: MethodDefinition<unknown, unknown>;
  source: SchemaSource;
  /** Non-fatal notes to surface to the user (e.g. descriptor fallback used). */
  warnings: string[];
}

export interface ResolveMethodOptions {
  /** Absolute path of the `*.request.yaml`, used to resolve `schema.location`. */
  requestFilePath: string;
  /** `schema.location` from the request, relative to the request file. */
  schemaLocation: string | undefined;
  /** base64 `FileDescriptorSet` embedded in the request. */
  methodDescriptor: string | undefined;
  /** `methodPath`, e.g. `pe.aev2.ExchangeService.Exchange` or `/pe.aev2.ExchangeService/Exchange`. */
  methodPath: string;
  includeDirs: string[];
  /** Forces the descriptor path, skipping the `.proto` file entirely. */
  preferDescriptor?: boolean;
}

/** Accepts both `pkg.Service.Method` and gRPC wire form `/pkg.Service/Method`. */
export function splitMethodPath(methodPath: string): { serviceName: string; methodName: string } {
  const trimmed = methodPath.trim().replace(/^\//, "");

  if (trimmed.includes("/")) {
    const [serviceName, methodName] = trimmed.split("/");
    if (!serviceName || !methodName) {
      throw new PremanError(`cannot parse methodPath "${methodPath}"`);
    }
    return { serviceName, methodName };
  }

  const lastDot = trimmed.lastIndexOf(".");
  if (lastDot <= 0 || lastDot === trimmed.length - 1) {
    throw new PremanError(`cannot parse methodPath "${methodPath}"`, {
      details: ["expected <package>.<Service>.<Method>"],
    });
  }
  return { serviceName: trimmed.slice(0, lastDot), methodName: trimmed.slice(lastDot + 1) };
}

function loadFromProtoFile(protoPath: string, includeDirs: string[]): PackageDefinition {
  try {
    return protoLoader.loadSync(protoPath, { ...LOAD_OPTIONS, includeDirs });
  } catch (cause) {
    throw new PremanError(`failed to load ${protoPath}: ${(cause as Error).message}`, {
      details: ["include dirs tried:", ...includeDirs.map((d) => `  ${d}`)],
    });
  }
}

function loadFromDescriptor(base64: string): PackageDefinition {
  let buffer: Buffer;
  try {
    buffer = Buffer.from(base64, "base64");
  } catch (cause) {
    throw new PremanError(`methodDescriptor is not valid base64: ${(cause as Error).message}`);
  }
  if (buffer.length === 0) throw new PremanError("methodDescriptor decoded to zero bytes");

  try {
    return protoLoader.loadFileDescriptorSetFromBuffer(buffer, LOAD_OPTIONS);
  } catch (cause) {
    throw new PremanError(`failed to load embedded methodDescriptor: ${(cause as Error).message}`);
  }
}

/** Every `pkg.Service.Method` present in a package definition, sorted. */
export function listMethods(pkg: PackageDefinition): string[] {
  const out: string[] = [];
  for (const [name, entry] of Object.entries(pkg)) {
    if (!isServiceDefinition(entry)) continue;
    for (const method of Object.keys(entry)) out.push(`${name}.${method}`);
  }
  return out.sort();
}

/**
 * proto-loader flattens messages and services into one map; services hold MethodDefinitions.
 *
 * Exported because the proto index walks the same map for a different shape, and two
 * copies of "which entries are services" would eventually disagree about whether
 * something is invocable.
 */
export function isServiceDefinition(entry: unknown): entry is ServiceDefinition {
  if (typeof entry !== "object" || entry === null) return false;
  const values = Object.values(entry as Record<string, unknown>);
  if (values.length === 0) return false;
  return values.every((v) => typeof v === "object" && v !== null && typeof (v as { path?: unknown }).path === "string");
}

/**
 * Resolve `methodPath` to an invocable {@link MethodDefinition}.
 *
 * Prefers the `.proto` file on disk (authoritative, always current). Falls back
 * to the base64 `FileDescriptorSet` embedded in the request when the file is
 * missing or unparseable — that descriptor is self-contained, so no protoc is
 * needed, but it is a snapshot taken by the Postman client and may be stale or
 * contain only the single method that was invoked at capture time.
 */
export function resolveMethod(options: ResolveMethodOptions): ResolvedMethod {
  const { serviceName, methodName } = splitMethodPath(options.methodPath);
  const warnings: string[] = [];

  const protoPath = options.schemaLocation
    ? isAbsolute(options.schemaLocation)
      ? options.schemaLocation
      : resolve(dirname(options.requestFilePath), options.schemaLocation)
    : undefined;

  let pkg: PackageDefinition | undefined;
  let source: SchemaSource = "proto-file";

  const useProtoFile = !options.preferDescriptor && protoPath !== undefined && existsSync(protoPath);
  if (useProtoFile) {
    try {
      pkg = loadFromProtoFile(protoPath, options.includeDirs);
    } catch (cause) {
      if (!options.methodDescriptor) throw cause;
      warnings.push(`could not load ${protoPath}, falling back to the embedded descriptor`);
      warnings.push(`  ${(cause as Error).message}`);
    }
  } else if (!options.preferDescriptor && protoPath !== undefined) {
    warnings.push(`schema file not found: ${protoPath}`);
  }

  if (!pkg) {
    if (!options.methodDescriptor) {
      throw new PremanError(`no usable schema for ${options.methodPath}`, {
        details: [
          protoPath ? `schema.location resolved to ${protoPath}` : "request has no schema.location",
          "and the request has no methodDescriptor to fall back to",
        ],
      });
    }
    pkg = loadFromDescriptor(options.methodDescriptor);
    source = "descriptor";
    warnings.push("using the descriptor embedded in the request; it may be stale or partial");
  }

  const service = pkg[serviceName];
  if (!isServiceDefinition(service)) {
    throw new PremanError(`service "${serviceName}" not found in the loaded schema`, {
      details: ["available methods:", ...listMethods(pkg).map((m) => `  ${m}`)],
    });
  }

  const definition = service[methodName] as MethodDefinition<unknown, unknown> | undefined;
  if (!definition) {
    throw new PremanError(`method "${methodName}" not found on ${serviceName}`, {
      details: ["available methods:", ...Object.keys(service).map((m) => `  ${serviceName}.${m}`)],
    });
  }

  if (definition.requestStream || definition.responseStream) {
    throw new PremanError(`${options.methodPath} is a streaming method, which preman does not support yet`, {
      details: [`requestStream=${definition.requestStream} responseStream=${definition.responseStream}`],
    });
  }

  return { serviceName, methodName, definition, source, warnings };
}
