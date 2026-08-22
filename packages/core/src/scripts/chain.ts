import type { GroupDefinition } from "@preman/core/workspace/definitions.js";
import type { RequestScript } from "@preman/core/workspace/schemas.js";

/** The two wire protocols preman can invoke. Also the legal group-level script prefixes. */
export type Protocol = "grpc" | "http";

/**
 * Script types executed before the call. `prerequest` is the HTTP-side alias, and
 * `beforeRequest` is what the Postman filesystem format actually writes for HTTP
 * requests, so it has to be recognised too.
 */
export const PRE_SCRIPT_TYPES = new Set(["beforeinvoke", "beforerequest", "prerequest", "pre-request"]);

/** Fires once per received message; a unary call has exactly one. */
export const MESSAGE_SCRIPT_TYPES = new Set(["onmessage"]);

/** Script types executed after the call, where `pm.test` assertions normally live. */
export const POST_SCRIPT_TYPES = new Set(["afterresponse", "test", "postresponse", "post-response"]);

/** Every type that maps to a run stage. A script outside this set is reported, never dropped. */
export const KNOWN_SCRIPT_TYPES = new Set([...PRE_SCRIPT_TYPES, ...MESSAGE_SCRIPT_TYPES, ...POST_SCRIPT_TYPES]);

/**
 * Separates the protocol scope from the event in a group-level script type, e.g. the `:` in
 * `http:beforeRequest`. Group scripts are inherited by requests of both protocols, so the
 * prefix is the only way to say which ones a script is meant for.
 */
const SCRIPT_SCOPE_SEPARATOR = ":";

/** Prefixes that name a protocol. Anything else is a typo, not a protocol preman lacks. */
const SCRIPT_PROTOCOL_PREFIXES = new Set<Protocol>(["grpc", "http"]);

export type ScriptLevel = "collection" | "folder" | "request";

export interface ScriptOrigin {
  level: ScriptLevel;
  /** `collection payment`, `folder ZAS`, `request`. */
  label: string;
}

/** The origin every request-level script carries. Shared so identity checks stay cheap. */
export const REQUEST_ORIGIN: ScriptOrigin = { level: "request", label: "request" };

export interface OwnedScript {
  origin: ScriptOrigin;
  /** Type with any protocol prefix stripped, lowercased - matched against the stage sets. */
  event: string;
  /** Verbatim from the file, e.g. `http:beforeRequest`, for `pm.info.eventName`. */
  rawType: string;
  code: string;
}

export interface ResolveScriptChainOptions {
  /** Outermost first: the collection, then each folder down to the request's own. */
  ancestors: GroupDefinition[];
  requestScripts: RequestScript[] | undefined;
  protocol: Protocol;
}

export interface ScriptChain {
  scripts: OwnedScript[];
  warnings: string[];
}

export function originOf(group: GroupDefinition): ScriptOrigin {
  return { level: group.kind, label: `${group.kind} ${group.name}` };
}

/**
 * Decision 8: only non-request origins are tagged, so every message a request-level script
 * produces keeps the wording it had before inheritance existed.
 */
function attribute(origin: ScriptOrigin, message: string): string {
  return origin.level === "request" ? message : `${origin.label} ${message}`;
}

interface SplitType {
  /** `undefined` when the type carries no `<protocol>:` scope at all. */
  prefix: string | undefined;
  event: string;
}

function splitType(rawType: string): SplitType {
  const index = rawType.indexOf(SCRIPT_SCOPE_SEPARATOR);
  if (index === -1) {
    return { prefix: undefined, event: rawType.trim().toLowerCase() };
  }
  return {
    prefix: rawType.slice(0, index).trim().toLowerCase(),
    event: rawType
      .slice(index + SCRIPT_SCOPE_SEPARATOR.length)
      .trim()
      .toLowerCase(),
  };
}

function knownTypesDetail(): string {
  return `known types: ${[...KNOWN_SCRIPT_TYPES].join(", ")}`;
}

function knownPrefixesDetail(): string {
  return `known prefixes: ${[...SCRIPT_PROTOCOL_PREFIXES].join(", ")}`;
}

interface ClassifyResult {
  script: OwnedScript | undefined;
  warning: string | undefined;
}

function classify(script: RequestScript, origin: ScriptOrigin, protocol: Protocol): ClassifyResult {
  const rawType = script.type;
  const { prefix, event } = splitType(rawType);

  if (prefix === undefined && origin.level !== "request") {
    // Decision 3: an unprefixed type above the request level cannot say which protocol it
    // targets, so running it would be a guess.
    return {
      script: undefined,
      warning: attribute(
        origin,
        `script type "${rawType}" has no protocol prefix, so it was not run ` +
          `(expected "grpc:<event>" or "http:<event>")`,
      ),
    };
  }

  if (prefix !== undefined && !SCRIPT_PROTOCOL_PREFIXES.has(prefix as Protocol)) {
    return {
      script: undefined,
      warning: attribute(
        origin,
        `script type "${rawType}" has an unrecognised protocol prefix, so it was not run ` +
          `(${knownPrefixesDetail()})`,
      ),
    };
  }

  if (prefix !== undefined && prefix !== protocol) {
    // Decision 4: silent. Telling the user about it on every request of the other protocol
    // in a mixed folder is exactly the noise the prefix exists to avoid.
    return { script: undefined, warning: undefined };
  }

  if (!KNOWN_SCRIPT_TYPES.has(event)) {
    return {
      script: undefined,
      warning: attribute(
        origin,
        `script type "${rawType}" is not recognised, so it was not run (${knownTypesDetail()})`,
      ),
    };
  }

  const code = script.code ?? "";
  if (code.trim() === "") {
    // An empty script is a Postman placeholder, not a mistake worth reporting.
    return { script: undefined, warning: undefined };
  }

  return { script: { origin, event, rawType, code }, warning: undefined };
}

/**
 * Flattens the collection -> folders -> request script declarations into one ordered list,
 * keeping only what this request's protocol can run (decision 5: outermost first, and not
 * unwound on the way out).
 */
export function resolveScriptChain(options: ResolveScriptChainOptions): ScriptChain {
  const scripts: OwnedScript[] = [];
  const warnings: string[] = [];

  const collect = (declared: RequestScript[] | undefined, origin: ScriptOrigin): void => {
    for (const script of declared ?? []) {
      const { script: owned, warning } = classify(script, origin, options.protocol);
      if (owned !== undefined) scripts.push(owned);
      if (warning !== undefined) warnings.push(warning);
    }
  };

  for (const ancestor of options.ancestors) {
    collect(ancestor.scripts, originOf(ancestor));
  }
  collect(options.requestScripts, REQUEST_ORIGIN);

  return { scripts, warnings };
}

export function hasScriptOf(scripts: OwnedScript[], types: Set<string>): boolean {
  return scripts.some((script) => types.has(script.event));
}
