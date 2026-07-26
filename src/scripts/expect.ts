import * as chai from "chai";

export { chai };

/**
 * `pm.expect` is chai in Postman, so it is chai here too. Scripts written against
 * Postman keep working, and every chain (`.deep.equal`, `.have.property`,
 * `.an("array")`, ...) comes for free.
 */
export const expect = chai.expect;

// Response payloads are bigger than chai's 40-character default, and a truncated
// diff is the difference between "obvious" and "run it again with --verbose".
chai.config.truncateThreshold = 400;
chai.config.includeStack = false;

/** Postman's `MessageList`: an ordered list of received gRPC messages. */
export interface ScriptMessage {
  data: unknown;
  timestamp: Date;
}

export interface MessageList {
  idx: (index: number) => ScriptMessage | undefined;
  count: () => number;
  all: () => ScriptMessage[];
  each: (fn: (message: ScriptMessage, index: number) => void) => void;
  map: <T>(fn: (message: ScriptMessage, index: number) => T) => T[];
  filter: (fn: (message: ScriptMessage, index: number) => boolean) => ScriptMessage[];
  /** Chai entry point, so `pm.response.messages.to.include({...})` reads naturally. */
  readonly to: Chai.Assertion;
}

/** Postman's metadata/trailer accessor. */
export interface HeaderList {
  get: (key: string) => string | undefined;
  has: (key: string) => boolean;
  toObject: () => Record<string, string>;
}

/**
 * The shape the assertions below understand. `headers` is the only list both
 * protocols have: gRPC aliases it to metadata, HTTP has nothing else. The rest is
 * optional so an HTTP response is not forced to fake `messages`/`trailers`.
 */
export interface ResponseLike {
  code: number;
  status: string;
  headers: HeaderList;
  metadata?: HeaderList;
  trailers?: HeaderList;
  messages?: MessageList;
}

/**
 * Identifies the objects the plugin below is allowed to reinterpret. A marker set
 * keeps the assertion behaviour off ordinary user objects that happen to look
 * similar.
 */
const messageLists = new WeakSet<object>();

function isMessageList(value: unknown): value is MessageList {
  return typeof value === "object" && value !== null && messageLists.has(value);
}

export function makeMessageList(messages: ScriptMessage[]): MessageList {
  const list: MessageList = {
    idx: (index) => messages[index],
    count: () => messages.length,
    all: () => [...messages],
    each: (fn) => messages.forEach(fn),
    map: (fn) => messages.map(fn),
    filter: (fn) => messages.filter(fn),
    // Defined below so it can close over `list` itself.
    to: undefined as unknown as Chai.Assertion,
  };
  messageLists.add(list);
  Object.defineProperty(list, "to", { get: () => expect(list).to, enumerable: false });
  return list;
}

export function makeHeaderList(entries: Record<string, string | string[]>): HeaderList {
  const flat: Record<string, string> = {};
  for (const [key, value] of Object.entries(entries)) {
    flat[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
  }
  return {
    get: (key) => flat[key.toLowerCase()],
    has: (key) => flat[key.toLowerCase()] !== undefined,
    toObject: () => ({ ...flat }),
  };
}

/**
 * True when every key in `expected` is present in `actual` with a matching value,
 * recursively. This is the semantics of Postman's
 * `pm.response.messages.to.include({...})`: a partial match against any message.
 */
function partialMatch(actual: unknown, expected: unknown): boolean {
  if (expected === actual) return true;
  if (typeof expected !== "object" || expected === null) return false;
  if (typeof actual !== "object" || actual === null) return false;

  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) return false;
    return expected.every((item, i) => partialMatch(actual[i], item));
  }
  if (Array.isArray(actual)) return false;

  const target = actual as Record<string, unknown>;
  return Object.entries(expected as Record<string, unknown>).every(([key, value]) =>
    partialMatch(target[key], value),
  );
}

function describe(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * The internal surface a chai plugin callback gets on `this`. `@types/chai` models
 * only the public chainable API, so the `assert` helper every plugin uses has to be
 * declared here.
 */
interface PluginAssertion {
  assert(
    expression: unknown,
    message: string,
    negatedMessage: string,
    expected?: unknown,
    actual?: unknown,
    showDiff?: boolean,
  ): void;
}

function assertHeader(
  assertion: PluginAssertion,
  list: HeaderList | undefined,
  label: string,
  key: string,
  expected: string | undefined,
): void {
  if (list === undefined) {
    throw new chai.AssertionError(`expected the assertion target to be a response with ${label}`);
  }
  const actual = list.get(key);
  if (expected === undefined) {
    assertion.assert(
      actual !== undefined,
      `expected ${label} to contain "${key}"`,
      `expected ${label} not to contain "${key}"`,
      key,
      undefined,
    );
    return;
  }
  assertion.assert(
    actual === expected,
    `expected ${label} "${key}" to be "${expected}" but got ${describe(actual)}`,
    `expected ${label} "${key}" not to be "${expected}"`,
    expected,
    actual,
  );
}

/**
 * Teaches chai the handful of Postman-specific assertions that operate on a
 * response: `pm.response.to.have.status(...)` / `.header(k[, v])` /
 * `.metadata(k[, v])` / `.trailer(k[, v])`, and
 * `pm.response.messages.to.include({...})`.
 */
chai.use((instance, utils) => {
  const { Assertion } = instance;

  Assertion.addMethod("status", function (this: object, expectedStatus: number | string) {
    const self = this as PluginAssertion;
    const target = utils.flag(this, "object") as ResponseLike | undefined;
    if (typeof target !== "object" || target === null || typeof target.code !== "number") {
      throw new chai.AssertionError("expected the assertion target to be a gRPC or HTTP response");
    }
    if (typeof expectedStatus === "number") {
      self.assert(
        target.code === expectedStatus,
        `expected status ${expectedStatus} but got ${target.code} (${target.status})`,
        `expected status not to be ${expectedStatus}`,
        expectedStatus,
        target.code,
      );
      return;
    }
    // Compared case-insensitively without normalising the reported value: gRPC
    // names are SCREAMING_SNAKE, HTTP reason phrases are "Not Found".
    self.assert(
      target.status.toUpperCase() === expectedStatus.toUpperCase(),
      `expected status ${expectedStatus} but got ${target.status}`,
      `expected status not to be ${expectedStatus}`,
      expectedStatus,
      target.status,
    );
  });

  Assertion.addMethod("header", function (this: object, key: string, value?: string) {
    const target = utils.flag(this, "object") as ResponseLike | undefined;
    assertHeader(this as PluginAssertion, target?.headers, "response headers", key, value);
  });

  Assertion.addMethod("metadata", function (this: object, key: string, value?: string) {
    const target = utils.flag(this, "object") as ResponseLike | undefined;
    assertHeader(this as PluginAssertion, target?.metadata, "response metadata", key, value);
  });

  Assertion.addMethod("trailer", function (this: object, key: string, value?: string) {
    const target = utils.flag(this, "object") as ResponseLike | undefined;
    assertHeader(this as PluginAssertion, target?.trailers, "response trailers", key, value);
  });

  // `include` is a *chainable* method in chai (`.include.members`, `.includes(...)`),
  // so it must be overwritten with the chainable variant; `overwriteMethod` throws.
  Assertion.overwriteChainableMethod(
    "include",
    function (_super: (...args: unknown[]) => unknown) {
      return function (this: object, ...args: unknown[]) {
        const self = this as PluginAssertion;
        const target = utils.flag(this, "object");
        if (!isMessageList(target)) {
          _super.apply(this, args);
          return;
        }
        const expectedShape = args[0];
        const payloads = target.all().map((m) => m.data);
        self.assert(
          payloads.some((data) => partialMatch(data, expectedShape)),
          `expected a response message to include ${describe(expectedShape)}`,
          `expected no response message to include ${describe(expectedShape)}`,
          expectedShape,
          payloads,
        );
      };
    },
    // `@types/chai` types the chaining behaviour as `() => void`, but chai passes it
    // `_super` like every other overwrite hook. Delegating keeps `.include.members`
    // and friends working, so the cast is the honest option.
    ((_super: (...args: unknown[]) => unknown) =>
      function (this: object) {
        _super.call(this);
      }) as unknown as () => void,
  );
});
