/**
 * The proto index: every unary method a workspace declares, and a request template
 * for any of them.
 *
 * This exists because finding out which of a workspace's protos declares
 * `acquiring_refund.v1.RefundService.CreateRefund` is otherwise a grep, and writing
 * the request for it is otherwise reading a `.proto` by hand. Both are the jobs a
 * schema is supposed to do for you.
 *
 * The specs come from `.postman/resources.yaml`, are loaded through the same
 * `@grpc/proto-loader` and the same {@link LOAD_OPTIONS} a run uses, and are cached by
 * mtime: a real workspace declares dozens of them, and reloading all of them to answer
 * a keystroke in a picker is the kind of cost that makes a feature feel broken.
 */
import { statSync } from "node:fs";
import type { MessageTypeDefinition, PackageDefinition } from "@grpc/proto-loader";
import * as protoLoader from "@grpc/proto-loader";
import { EXIT, PremanError } from "@preman/core/errors.js";
import { isServiceDefinition, LOAD_OPTIONS, splitMethodPath } from "@preman/core/grpc/schema.js";
import { requireWorkspace } from "@preman/core/workspace/discover.js";
import { loadResources } from "@preman/core/workspace/resources.js";

/** proto-loader tags every entry in the flat map with what it is. */
const MESSAGE_FORMAT = "Protocol Buffer 3 DescriptorProto";
const ENUM_FORMAT = "Protocol Buffer 3 EnumDescriptorProto";

const NAME_SEPARATOR = ".";
const REPEATED_LABEL = "LABEL_REPEATED";
const MESSAGE_TYPE = "TYPE_MESSAGE";
const ENUM_TYPE = "TYPE_ENUM";
const STRING_TYPE = "TYPE_STRING";
/** The number every proto3 enum's first value must carry, and the one a skeleton emits. */
const ENUM_ZERO = 0;
/** What `JSON.stringify` indents a skeleton by, matching the request files people write by hand. */
const SKELETON_INDENT = 2;

/**
 * The zero value of every scalar field type, as this engine puts it on the wire.
 *
 * The 64-bit widths are strings because {@link LOAD_OPTIONS} sets `longs: String`, which
 * is what keeps a 19-digit id lossless. A skeleton that emitted `0` for an `int64` would
 * be handing back a template that does not match the requests in the workspace.
 */
const SCALAR_ZERO: Record<string, unknown> = {
  TYPE_STRING: "",
  TYPE_BYTES: "",
  TYPE_BOOL: false,
  TYPE_DOUBLE: 0,
  TYPE_FLOAT: 0,
  TYPE_INT32: 0,
  TYPE_UINT32: 0,
  TYPE_SINT32: 0,
  TYPE_FIXED32: 0,
  TYPE_SFIXED32: 0,
  TYPE_INT64: "0",
  TYPE_UINT64: "0",
  TYPE_SINT64: "0",
  TYPE_FIXED64: "0",
  TYPE_SFIXED64: "0",
};

/**
 * The parts of `DescriptorProto` proto-loader hands back on `MessageTypeDefinition.type`,
 * which it declares as a bare `object`.
 *
 * Two things here are worth knowing before reading the walk below. `label` and `type`
 * arrive as their enum *names* — `LABEL_REPEATED`, `TYPE_STRING` — not as numbers. And
 * `typeName` is written exactly as the `.proto` wrote it, so it is usually relative
 * (`Inner`) and only sometimes qualified (`google.protobuf.Timestamp`); resolving it
 * needs protobuf's own scoping rules, which is what {@link resolveReference} implements.
 */
interface FieldDescriptor {
  name?: string | null;
  label?: string | null;
  type?: string | null;
  typeName?: string | null;
}

interface MessageDescriptor {
  name?: string | null;
  field?: FieldDescriptor[] | null;
  nestedType?: MessageDescriptor[] | null;
  /** `mapEntry` marks the synthetic message a `map<k, v>` field compiles into. */
  options?: { mapEntry?: boolean | null } | null;
}

interface EnumDescriptor {
  name?: string | null;
  value?: { name?: string | null; number?: number | null }[] | null;
}

export interface ProtoMethod {
  /** `pkg.Service.Method` — the form a request file's `methodPath` takes. */
  methodPath: string;
  serviceName: string;
  methodName: string;
  /** Absolute path of the spec that declared it. */
  spec: string;
  /** Fully-qualified message names, for a picker that wants to say what goes in and out. */
  requestType: string;
  responseType: string;
  /**
   * A streaming method. Offered rather than hidden, and refused on send, exactly as the
   * tree lists a websocket request it will not run: a method that is missing from a
   * picker looks like a broken index.
   */
  streaming: boolean;
}

export interface ProtoIndex {
  /** Every method every loadable spec declares, sorted by `methodPath`. */
  methods: readonly ProtoMethod[];
  /** A spec that would not load. Never silent: a missing method has to have a reason. */
  warnings: readonly string[];
}

/** One spec's loaded state, kept until the file's mtime moves. */
interface CachedSpec {
  mtimeMs: number;
  /** `undefined` when the spec failed to load; `warning` then says why. */
  pkg: PackageDefinition | undefined;
  methods: ProtoMethod[];
  warning: string | undefined;
}

/** Stands in for a spec that could not be stat'd, so the next call retries rather than caching. */
const MISSING_MTIME = 0;

function parseSpec(spec: string, mtimeMs: number, includeDirs: string[]): CachedSpec {
  try {
    const pkg = protoLoader.loadSync(spec, { ...LOAD_OPTIONS, includeDirs });
    return { mtimeMs, pkg, methods: methodsIn(pkg, spec), warning: undefined };
  } catch (cause) {
    // One unloadable spec must not cost the other twenty-five their methods, so the
    // failure is reported beside the index rather than thrown through it.
    return { mtimeMs, pkg: undefined, methods: [], warning: `cannot load ${spec}: ${(cause as Error).message}` };
  }
}

function messageOf(entry: unknown): MessageDescriptor | undefined {
  if (typeof entry !== "object" || entry === null) return undefined;
  const candidate = entry as { format?: unknown; type?: unknown };
  if (candidate.format !== MESSAGE_FORMAT) return undefined;
  return candidate.type as MessageDescriptor;
}

function enumOf(entry: unknown): EnumDescriptor | undefined {
  if (typeof entry !== "object" || entry === null) return undefined;
  const candidate = entry as { format?: unknown; type?: unknown };
  if (candidate.format !== ENUM_FORMAT) return undefined;
  return candidate.type as EnumDescriptor;
}

/**
 * The fully-qualified name of a message proto-loader handed back bare.
 *
 * `MethodDefinition.requestType` carries the descriptor but not its place in the
 * namespace, and the descriptor object is not identical to the one under the flat map's
 * own key, so the name has to be recovered by matching. A unique last segment settles
 * it; a name that repeats across packages is broken by preferring the service's own.
 */
function qualify(pkg: PackageDefinition, type: MessageTypeDefinition, serviceName: string): string {
  const bare = (type.type as MessageDescriptor).name ?? "";
  const candidates = Object.keys(pkg).filter((key) => messageOf(pkg[key]) !== undefined && lastSegment(key) === bare);
  if (candidates.length <= 1) return candidates[0] ?? bare;

  const scope = `${packageOf(serviceName)}${NAME_SEPARATOR}`;
  return candidates.find((key) => key.startsWith(scope)) ?? candidates[0]!;
}

function lastSegment(name: string): string {
  const cut = name.lastIndexOf(NAME_SEPARATOR);
  return cut < 0 ? name : name.slice(cut + 1);
}

function packageOf(qualified: string): string {
  const cut = qualified.lastIndexOf(NAME_SEPARATOR);
  return cut < 0 ? "" : qualified.slice(0, cut);
}

/**
 * Resolve a field's `typeName` the way protoc does: innermost scope outwards.
 *
 * A nested type declared inside the enclosing message wins first, because that is the
 * closest scope and because it is where a `map<k, v>` field's synthetic entry lives.
 * After that, every enclosing scope is tried from the longest prefix down to the root,
 * which is what makes a bare `Inner` in `a.b.Outer` find `a.b.Inner`.
 */
function resolveReference(
  pkg: PackageDefinition,
  enclosing: MessageDescriptor,
  enclosingName: string,
  typeName: string,
): { name: string; message?: MessageDescriptor; enumeration?: EnumDescriptor } | undefined {
  const nested = (enclosing.nestedType ?? []).find((candidate) => candidate.name === typeName);
  if (nested !== undefined) {
    return { name: `${enclosingName}${NAME_SEPARATOR}${typeName}`, message: nested };
  }

  for (let scope: string | undefined = enclosingName; scope !== undefined; scope = parentScope(scope)) {
    const name = scope.length === 0 ? typeName : `${scope}${NAME_SEPARATOR}${typeName}`;
    const entry = pkg[name];
    const message = messageOf(entry);
    if (message !== undefined) return { name, message };
    const enumeration = enumOf(entry);
    if (enumeration !== undefined) return { name, enumeration };
  }
  return undefined;
}

/** The next scope out, ending at the root; `undefined` once the root has been tried. */
function parentScope(scope: string): string | undefined {
  if (scope.length === 0) return undefined;
  const cut = scope.lastIndexOf(NAME_SEPARATOR);
  return cut < 0 ? "" : scope.slice(0, cut);
}

function isMapEntry(message: MessageDescriptor): boolean {
  return message.options?.mapEntry === true;
}

/** A proto3 enum's zero value, which is the only value a skeleton can honestly choose. */
function zeroEnumValue(enumeration: EnumDescriptor): string {
  const values = enumeration.value ?? [];
  const zero = values.find((value) => value.number === ENUM_ZERO) ?? values[0];
  return zero?.name ?? "";
}

interface SkeletonContext {
  pkg: PackageDefinition;
  /** Keys a `{{token}}` can be written for, i.e. what the next run would resolve. */
  tokens: ReadonlySet<string>;
  /** Fully-qualified message names on the path here, so a recursive type terminates. */
  visiting: Set<string>;
}

/**
 * One field's value in a skeleton.
 *
 * A repeated field gets exactly one element rather than an empty array. "Zero values"
 * would be `[]`, which tells a reader nothing about the shape they are supposed to fill
 * in — and the shape is the entire reason to generate a template instead of writing
 * `{}`. A map gets `{}`, because its keys are data rather than schema and an invented
 * example key would read as a required one.
 */
function fieldValue(
  context: SkeletonContext,
  enclosing: MessageDescriptor,
  enclosingName: string,
  field: FieldDescriptor,
): unknown {
  const one = singleValue(context, enclosing, enclosingName, field);
  // A map compiles to a repeated entry message, so the map check has to come first or
  // every map would be emitted as a one-element array of `{key, value}`.
  if (one === MAP_FIELD) return {};
  return field.label === REPEATED_LABEL ? [one] : one;
}

/** Distinguishes "this is a map" from any value a map could legitimately hold. */
const MAP_FIELD = Symbol("map-field");

function singleValue(
  context: SkeletonContext,
  enclosing: MessageDescriptor,
  enclosingName: string,
  field: FieldDescriptor,
): unknown {
  const type = field.type ?? "";
  const name = field.name ?? "";

  if (type === STRING_TYPE && context.tokens.has(name)) return `{{${name}}}`;
  if (type !== MESSAGE_TYPE && type !== ENUM_TYPE) return SCALAR_ZERO[type] ?? null;

  const reference = resolveReference(context.pkg, enclosing, enclosingName, field.typeName ?? "");
  // An unresolvable reference is an import this index could not follow. `null` is the
  // one value that is obviously a hole rather than a plausible default.
  if (reference === undefined) return null;
  if (reference.enumeration !== undefined) return zeroEnumValue(reference.enumeration);

  const message = reference.message!;
  if (isMapEntry(message)) return MAP_FIELD;
  return messageValue(context, message, reference.name);
}

function messageValue(context: SkeletonContext, message: MessageDescriptor, name: string): unknown {
  // A message that contains itself would otherwise recurse forever. An empty object says
  // "this nests again here" without pretending to know how deep the caller wants it.
  if (context.visiting.has(name)) return {};
  context.visiting.add(name);
  try {
    const out: Record<string, unknown> = {};
    for (const field of message.field ?? []) {
      // `keepCase` is on for every load in this engine, so the declared name is the wire name.
      out[field.name ?? ""] = fieldValue(context, message, name, field);
    }
    return out;
  } finally {
    context.visiting.delete(name);
  }
}

/**
 * Every unary and streaming method one loaded spec declares.
 *
 * Streaming methods are included with `streaming: true` rather than filtered out; the
 * refusal belongs to the send, not to the list.
 */
function methodsIn(pkg: PackageDefinition, spec: string): ProtoMethod[] {
  const methods: ProtoMethod[] = [];
  for (const [serviceName, entry] of Object.entries(pkg)) {
    if (!isServiceDefinition(entry)) continue;
    for (const [methodName, definition] of Object.entries(entry)) {
      methods.push({
        methodPath: `${serviceName}${NAME_SEPARATOR}${methodName}`,
        serviceName,
        methodName,
        spec,
        requestType: qualify(pkg, definition.requestType, serviceName),
        responseType: qualify(pkg, definition.responseType, serviceName),
        streaming: definition.requestStream || definition.responseStream,
      });
    }
  }
  return methods;
}

/**
 * Every method a workspace declares, and a filled-in request body for any of them.
 *
 * One instance per open workspace. Held rather than rebuilt because the load is the
 * expensive part and the answer only changes when a `.proto` does.
 */
export class ProtoCache {
  private readonly specs = new Map<string, CachedSpec>();

  constructor(private readonly root: string) {}

  /**
   * The index, reloading only the specs whose mtime moved.
   *
   * The spec *list* is re-read every call, because `.postman/resources.yaml` is one small
   * file and a stale list is worse than a stale parse. Note the bound of the mtime check:
   * it covers the declared specs, not the files they import, so editing an imported proto
   * without touching its importer is not picked up until the workspace is reopened.
   */
  index(): ProtoIndex {
    const resources = loadResources(requireWorkspace(this.root));
    for (const stale of [...this.specs.keys()]) {
      if (!resources.specs.includes(stale)) this.specs.delete(stale);
    }

    const methods: ProtoMethod[] = [];
    const warnings: string[] = [];
    for (const spec of resources.specs) {
      const cached = this.load(spec, resources.includeDirs);
      methods.push(...cached.methods);
      if (cached.warning !== undefined) warnings.push(cached.warning);
    }

    methods.sort((a, b) => a.methodPath.localeCompare(b.methodPath));
    return { methods, warnings };
  }

  /**
   * A JSON request body for `methodPath`, as text ready to drop into `message.content`.
   *
   * `tokens` are the variable keys that would resolve on the next run, and a string field
   * whose name is one of them is written as `{{key}}` instead of `""`. That is the whole
   * point of generating this here rather than in the editor: the engine is the only side
   * that knows both the schema and the scope chain.
   *
   * All fields are emitted, including every arm of a `oneof`. proto-loader's descriptors
   * report `oneofIndex: 0` for fields that are in no oneof at all, so membership cannot be
   * told apart from the descriptor — and a template with an extra key to delete is better
   * than one silently missing the arm you wanted.
   */
  skeleton(methodPath: string, tokens: Iterable<string> = []): string {
    const { serviceName, methodName } = splitMethodPath(methodPath);
    const found = this.findMethod(serviceName, methodName);
    const type = found.definition.requestType;
    const context: SkeletonContext = { pkg: found.pkg, tokens: new Set(tokens), visiting: new Set() };
    const name = qualify(found.pkg, type, serviceName);
    return JSON.stringify(messageValue(context, type.type, name), null, SKELETON_INDENT);
  }

  private findMethod(serviceName: string, methodName: string) {
    const index = this.index();
    for (const cached of this.specs.values()) {
      const pkg = cached.pkg;
      if (pkg === undefined) continue;
      const service = pkg[serviceName];
      if (!isServiceDefinition(service)) continue;
      const definition = service[methodName];
      if (definition !== undefined) return { pkg, definition };
    }

    throw new PremanError(`no declared spec defines ${serviceName}.${methodName}`, {
      exitCode: EXIT.CLI,
      details: [
        ...(index.methods.length === 0
          ? ["no methods were found; check localResources.specs in .postman/resources.yaml"]
          : ["available methods:", ...index.methods.map((method) => `  ${method.methodPath}`)]),
        ...index.warnings,
      ],
    });
  }

  private load(spec: string, includeDirs: string[]): CachedSpec {
    let mtimeMs: number;
    try {
      mtimeMs = statSync(spec).mtimeMs;
    } catch (cause) {
      // A spec declared in resources.yaml that is not on disk. Reported rather than
      // thrown: the other specs still have methods, and the list says which one is gone.
      const missing: CachedSpec = {
        mtimeMs: MISSING_MTIME,
        pkg: undefined,
        methods: [],
        warning: `cannot read ${spec}: ${String(cause)}`,
      };
      this.specs.set(spec, missing);
      return missing;
    }

    const cached = this.specs.get(spec);
    if (cached !== undefined && cached.mtimeMs === mtimeMs) return cached;

    const fresh = parseSpec(spec, mtimeMs, includeDirs);
    this.specs.set(spec, fresh);
    return fresh;
  }
}
