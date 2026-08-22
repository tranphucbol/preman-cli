import { CliError } from "@preman/core/errors.js";
import { BODY_CONTENT_TYPES } from "@preman/core/http/body.js";
import { FROZEN_REQUEST_MESSAGE, PropertyList, type Property } from "./property-list.js";

const DEFAULT_PROTOCOL = "http";
const URL_PATTERN = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/i;
const IPV6_HOST = /:/;
const HEADER_LIST_OPTIONS = { caseInsensitive: true, label: "request headers" } as const;
const METADATA_LIST_OPTIONS = { caseInsensitive: true, label: "request metadata" } as const;
const QUERY_LIST_OPTIONS = { caseInsensitive: false, label: "request query parameters" } as const;
const FORM_LIST_OPTIONS = { caseInsensitive: false, label: "request body fields" } as const;

function decodeQueryPart(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, " "));
  } catch {
    return value;
  }
}

function encodeQueryPart(value: string): string {
  return encodeURIComponent(value).replace(/%20/g, "+").replace(/%7B/gi, "{").replace(/%7D/gi, "}");
}

function encodePathPart(value: string): string {
  return encodeURIComponent(value)
    .replace(/%25([0-9a-f]{2})/gi, "%$1")
    .replace(/%7B/gi, "{")
    .replace(/%7D/gi, "}");
}

function parseQuery(raw: string | undefined): Property[] {
  if (raw === undefined || raw.length === 0) return [];
  return raw.split("&").map((part) => {
    const separator = part.indexOf("=");
    const key = separator === -1 ? part : part.slice(0, separator);
    const value = separator === -1 ? "" : part.slice(separator + 1);
    return { key: decodeQueryPart(key), value: decodeQueryPart(value) };
  });
}

export class Url {
  #protocol: string;
  #host: string[];
  #port: string | undefined;
  #path: string[];
  readonly #authoredPath: string[];
  readonly #rawPath: string;
  readonly #query: PropertyList;
  readonly #rawQuery: string | undefined;
  #queryChanged = false;
  #hash: string | undefined;
  #frozen = false;

  private constructor(parts: {
    protocol: string;
    host: string[];
    port: string | undefined;
    path: string[];
    rawPath: string;
    query: Property[];
    rawQuery: string | undefined;
    hash: string | undefined;
  }) {
    this.#protocol = parts.protocol;
    this.#host = this.#mutableArray(parts.host);
    this.#port = parts.port;
    this.#path = this.#mutableArray(parts.path);
    this.#authoredPath = [...parts.path];
    this.#rawPath = parts.rawPath;
    this.#query = new PropertyList(parts.query, {
      ...QUERY_LIST_OPTIONS,
      onChange: () => {
        this.#queryChanged = true;
      },
    });
    this.#rawQuery = parts.rawQuery;
    this.#hash = parts.hash;
  }

  static parse(raw: string, extraQuery: Property[] = []): Url {
    const text = raw.trim();
    const absolute = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `${DEFAULT_PROTOCOL}://${text}`;
    const match = URL_PATTERN.exec(absolute);
    if (match === null || match[1] === undefined || match[2] === undefined) {
      throw new CliError(`request url "${raw}" is not a valid url`);
    }

    const authority = match[2];
    let hostname = authority;
    let port: string | undefined;
    if (authority.startsWith("[")) {
      const close = authority.indexOf("]");
      if (close === -1) throw new CliError(`request url "${raw}" is not a valid url`);
      hostname = authority.slice(1, close);
      const tail = authority.slice(close + 1);
      if (tail.startsWith(":")) port = tail.slice(1) || undefined;
    } else {
      const colon = authority.lastIndexOf(":");
      if (colon !== -1) {
        hostname = authority.slice(0, colon);
        port = authority.slice(colon + 1) || undefined;
      }
    }

    if (hostname.length === 0) throw new CliError(`request url "${raw}" has no host`);
    const rawPath = match[3] ?? "";
    return new Url({
      protocol: match[1].toLowerCase(),
      host: IPV6_HOST.test(hostname) ? [hostname] : hostname.split("."),
      port,
      path: rawPath.length > 1 ? rawPath.slice(1).split("/") : [],
      rawPath,
      query: [...parseQuery(match[4]), ...extraQuery],
      rawQuery: match[4],
      hash: match[5] === undefined || match[5].length === 0 ? undefined : match[5],
    });
  }

  get protocol(): string {
    return this.#protocol;
  }

  set protocol(value: string) {
    this.#assertMutable();
    this.#protocol = String(value).replace(/:$/, "").toLowerCase();
  }

  get host(): string[] {
    return this.#host;
  }

  set host(value: string[]) {
    this.#assertMutable();
    this.#host = this.#mutableArray(value);
  }

  get port(): string | undefined {
    return this.#port;
  }

  set port(value: string | undefined) {
    this.#assertMutable();
    this.#port = value === undefined || value.length === 0 ? undefined : String(value);
  }

  get path(): string[] {
    return this.#path;
  }

  set path(value: string[]) {
    this.#assertMutable();
    this.#path = this.#mutableArray(value);
  }

  get hash(): string | undefined {
    return this.#hash;
  }

  set hash(value: string | undefined) {
    this.#assertMutable();
    this.#hash = value === undefined || value.length === 0 ? undefined : String(value).replace(/^#/, "");
  }

  get query(): PropertyList {
    return this.#query;
  }

  set query(_value: PropertyList) {
    this.#assertMutable();
    throw new CliError("pm.request.url.query must be edited through its PropertyList methods");
  }

  toString(): string {
    const joinedHost = this.#host.join(".");
    const host = IPV6_HOST.test(joinedHost) ? `[${joinedHost}]` : joinedHost;
    const port = this.#port === undefined ? "" : `:${this.#port}`;
    const pathUnchanged =
      this.#path.length === this.#authoredPath.length &&
      this.#path.every((segment, index) => segment === this.#authoredPath[index]);
    const path = pathUnchanged
      ? this.#rawPath
      : this.#path.length === 0
        ? ""
        : `/${this.#path.map(encodePathPart).join("/")}`;
    const query = this.#query
      .enabled()
      .map(({ key, value }) => `${encodeQueryPart(key)}=${encodeQueryPart(value)}`)
      .join("&");
    const search =
      !this.#queryChanged && this.#rawQuery !== undefined
        ? `?${this.#rawQuery}`
        : query.length === 0
          ? ""
          : `?${query}`;
    const hash = this.#hash === undefined ? "" : `#${this.#hash}`;
    return `${this.#protocol}://${host}${port}${path}${search}${hash}`;
  }

  freeze(): void {
    this.#frozen = true;
    this.#query.freeze();
    Object.freeze(this.#authoredPath);
    Object.freeze(this);
  }

  #mutableArray(values: string[]): string[] {
    return new Proxy([...values], {
      set: (target, property, value) => {
        this.#assertMutable();
        return Reflect.set(target, property, value, target);
      },
      deleteProperty: (target, property) => {
        this.#assertMutable();
        return Reflect.deleteProperty(target, property);
      },
      defineProperty: (target, property, descriptor) => {
        this.#assertMutable();
        return Reflect.defineProperty(target, property, descriptor);
      },
      setPrototypeOf: (target, prototype) => {
        this.#assertMutable();
        return Reflect.setPrototypeOf(target, prototype);
      },
      preventExtensions: (target) => {
        this.#assertMutable();
        return Reflect.preventExtensions(target);
      },
    });
  }

  #assertMutable(): void {
    if (this.#frozen) throw new CliError(FROZEN_REQUEST_MESSAGE);
  }
}

export class LiveBody {
  #mode: string | undefined;
  #raw: string;
  readonly #urlencoded: PropertyList;
  #changed = false;
  #frozen = false;

  constructor(mode: string | undefined, raw: string, urlencoded: Property[] = []) {
    this.#mode = mode === undefined || mode.length === 0 ? undefined : mode;
    this.#raw = raw;
    this.#urlencoded = new PropertyList(urlencoded, {
      ...FORM_LIST_OPTIONS,
      onChange: () => {
        this.#changed = true;
      },
    });
  }

  get mode(): string | undefined {
    return this.#mode;
  }

  set mode(value: string | undefined) {
    this.#assertMutable();
    this.#changed = true;
    this.#mode = value === undefined || value.length === 0 ? undefined : String(value).toLowerCase();
  }

  get raw(): string {
    return this.#raw;
  }

  set raw(value: string) {
    this.#assertMutable();
    this.#changed = true;
    this.#raw = String(value);
  }

  get urlencoded(): PropertyList {
    return this.#urlencoded;
  }

  set urlencoded(_value: PropertyList) {
    this.#assertMutable();
    throw new CliError("pm.request.body.urlencoded must be edited through its PropertyList methods");
  }

  /** Whether a pre-request script changed this body after construction. */
  get changed(): boolean {
    return this.#changed;
  }

  toWire(): { body: string | undefined; contentType: string | undefined } {
    let body: string | undefined;
    if (this.#mode === "urlencoded") {
      const entries = this.#urlencoded.enabled();
      body =
        entries.length === 0
          ? undefined
          : new URLSearchParams(entries.map(({ key, value }): [string, string] => [key, value])).toString();
    } else {
      body = this.#raw.length === 0 ? undefined : this.#raw;
    }
    return {
      body,
      contentType: body === undefined || this.#mode === undefined ? undefined : BODY_CONTENT_TYPES[this.#mode],
    };
  }

  freeze(): void {
    this.#frozen = true;
    this.#urlencoded.freeze();
    Object.freeze(this);
  }

  #assertMutable(): void {
    if (this.#frozen) throw new CliError(FROZEN_REQUEST_MESSAGE);
  }
}

abstract class MutableRequest {
  abstract readonly protocol: "http" | "grpc";
  #url: Url;
  #body: LiveBody;
  #frozen = false;

  protected constructor(url: Url | string, body: LiveBody) {
    this.#url = typeof url === "string" ? Url.parse(url) : url;
    this.#body = body;
  }

  get url(): Url {
    return this.#url;
  }

  set url(value: Url | string) {
    this.assertMutable();
    this.#url = typeof value === "string" ? Url.parse(value) : value;
  }

  get body(): LiveBody {
    return this.#body;
  }

  set body(value: LiveBody) {
    this.assertMutable();
    if (!(value instanceof LiveBody)) throw new CliError("pm.request.body must be a LiveBody");
    this.#body = value;
  }

  freeze(): void {
    this.#frozen = true;
    this.#url.freeze();
    this.#body.freeze();
  }

  protected assertMutable(): void {
    if (this.#frozen) throw new CliError(FROZEN_REQUEST_MESSAGE);
  }
}

export class LiveHttpRequest extends MutableRequest {
  readonly #headers: PropertyList;
  #method: string;

  constructor(options: { url: Url | string; method: string; headers?: Property[]; body: LiveBody }) {
    super(options.url, options.body);
    this.#method = options.method;
    this.#headers = new PropertyList(options.headers ?? [], HEADER_LIST_OPTIONS);
  }

  get protocol(): "http" {
    return "http";
  }

  set protocol(_value: "http") {
    this.assertMutable();
    throw new CliError("pm.request.protocol is read-only");
  }

  get headers(): PropertyList {
    return this.#headers;
  }

  set headers(_value: PropertyList) {
    this.assertMutable();
    throw new CliError("pm.request.headers must be edited through its PropertyList methods");
  }

  get method(): string {
    return this.#method;
  }

  set method(value: string) {
    this.assertMutable();
    this.#method = String(value);
  }

  override freeze(): void {
    super.freeze();
    this.#headers.freeze();
    Object.freeze(this);
  }
}

export class LiveGrpcRequest extends MutableRequest {
  readonly #metadata: PropertyList;
  #methodPath: string;

  constructor(options: { url: Url | string; methodPath: string; metadata?: Property[]; body: LiveBody }) {
    super(options.url, options.body);
    this.#methodPath = options.methodPath;
    this.#metadata = new PropertyList(options.metadata ?? [], METADATA_LIST_OPTIONS);
  }

  get protocol(): "grpc" {
    return "grpc";
  }

  set protocol(_value: "grpc") {
    this.assertMutable();
    throw new CliError("pm.request.protocol is read-only");
  }

  get metadata(): PropertyList {
    return this.#metadata;
  }

  set metadata(_value: PropertyList) {
    this.assertMutable();
    throw new CliError("pm.request.metadata must be edited through its PropertyList methods");
  }

  get methodPath(): string {
    return this.#methodPath;
  }

  set methodPath(value: string) {
    this.assertMutable();
    this.#methodPath = String(value);
  }

  override freeze(): void {
    super.freeze();
    this.#metadata.freeze();
    Object.freeze(this);
  }
}

export type LiveRequest = LiveHttpRequest | LiveGrpcRequest;

export function freezeRequest(request: LiveRequest): void {
  request.freeze();
}
