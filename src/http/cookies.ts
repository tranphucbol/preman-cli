export interface Cookie {
  name: string;
  value: string;
  /** Host the cookie applies to, lower-cased and without a leading dot. */
  domain: string;
  path: string;
  /** Absolute epoch ms, or undefined for a session cookie. */
  expiresAt: number | undefined;
  /** True when no `Domain` attribute was sent: the cookie is for that exact host. */
  hostOnly: boolean;
  httpOnly: boolean;
  secure: boolean;
}

const KEY_SEPARATOR = "\u0000";
const ROOT_PATH = "/";
const DELETED_MAX_AGE = 0;

function defaultPath(pathname: string): string {
  // RFC 6265 §5.1.4: the "directory" of the request path.
  if (!pathname.startsWith(ROOT_PATH)) return ROOT_PATH;
  const lastSlash = pathname.lastIndexOf(ROOT_PATH);
  return lastSlash === 0 ? ROOT_PATH : pathname.slice(0, lastSlash);
}

/** RFC 6265 §5.1.3. */
function domainMatches(host: string, cookie: Cookie): boolean {
  if (host === cookie.domain) return true;
  if (cookie.hostOnly) return false;
  return host.endsWith(`.${cookie.domain}`);
}

/** RFC 6265 §5.1.4. */
function pathMatches(pathname: string, cookiePath: string): boolean {
  if (pathname === cookiePath) return true;
  if (!pathname.startsWith(cookiePath)) return false;
  return cookiePath.endsWith(ROOT_PATH) || pathname.charAt(cookiePath.length) === ROOT_PATH;
}

interface ParsedSetCookie {
  cookie: Cookie;
  /** True when the server asked us to delete it (`Max-Age<=0` or a past `Expires`). */
  expired: boolean;
}

function parseSetCookie(header: string, url: URL, now: number): ParsedSetCookie | undefined {
  const parts = header.split(";");
  const pair = parts[0] ?? "";
  const eq = pair.indexOf("=");
  if (eq <= 0) return undefined;

  const name = pair.slice(0, eq).trim();
  if (name.length === 0) return undefined;

  const host = url.hostname.toLowerCase();
  const cookie: Cookie = {
    name,
    value: pair.slice(eq + 1).trim(),
    domain: host,
    path: defaultPath(url.pathname),
    expiresAt: undefined,
    hostOnly: true,
    httpOnly: false,
    secure: false,
  };

  let maxAge: number | undefined;
  for (const attribute of parts.slice(1)) {
    const separator = attribute.indexOf("=");
    const key = (separator === -1 ? attribute : attribute.slice(0, separator)).trim().toLowerCase();
    const value = separator === -1 ? "" : attribute.slice(separator + 1).trim();

    if (key === "domain" && value.length > 0) {
      cookie.domain = value.replace(/^\./, "").toLowerCase();
      cookie.hostOnly = false;
    } else if (key === "path" && value.startsWith(ROOT_PATH)) {
      cookie.path = value;
    } else if (key === "max-age") {
      const parsed = Number.parseInt(value, 10);
      if (Number.isFinite(parsed)) maxAge = parsed;
    } else if (key === "expires") {
      const parsed = Date.parse(value);
      if (!Number.isNaN(parsed)) cookie.expiresAt = parsed;
    } else if (key === "httponly") {
      cookie.httpOnly = true;
    } else if (key === "secure") {
      cookie.secure = true;
    }
  }

  // Max-Age wins over Expires (RFC 6265 §5.2.2).
  if (maxAge !== undefined) cookie.expiresAt = now + maxAge * 1000;

  const expired =
    (maxAge !== undefined && maxAge <= DELETED_MAX_AGE) || (cookie.expiresAt !== undefined && cookie.expiresAt <= now);
  return { cookie, expired };
}

/**
 * An in-memory cookie jar, scoped to a single run (shared across a collection run).
 *
 * `Secure` and `SameSite` are recorded but not enforced: a CLI hitting a local
 * plaintext service still needs the session cookies a browser would withhold.
 * `HttpOnly` cookies are visible to scripts for the same reason — `pm.cookies.get`
 * on the CSRF cookie is the whole point.
 */
export class CookieJar {
  private readonly cookies = new Map<string, Cookie>();
  private readonly insertedAt = new Map<string, number>();
  private sequence = 0;

  /** Apply every `Set-Cookie` from one response, in order. */
  storeFrom(url: URL, setCookieHeaders: readonly string[]): void {
    const now = Date.now();
    for (const header of setCookieHeaders) {
      const parsed = parseSetCookie(header, url, now);
      if (parsed === undefined) continue;

      const key = this.keyOf(parsed.cookie);
      if (parsed.expired) {
        // This is what makes a delete-then-set pair land on the real value:
        // the deletion only removes the (name, domain, path) it names.
        this.cookies.delete(key);
        this.insertedAt.delete(key);
        continue;
      }
      this.cookies.set(key, parsed.cookie);
      this.insertedAt.set(key, this.sequence++);
    }
  }

  /** The `Cookie` header value for `url`, or undefined when nothing matches. */
  headerFor(url: URL): string | undefined {
    const matches = this.matching(url);
    if (matches.length === 0) return undefined;
    return matches.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
  }

  /**
   * Value of a cookie by name, ignoring the request url.
   *
   * Scripts call `pm.cookies.get("admin_csrf_token")` with no url in hand; the
   * longest path wins so a specific cookie beats a root-level one of the same name.
   */
  get(name: string): string | undefined {
    const candidates = this.live().filter((cookie) => cookie.name === name);
    return this.sorted(candidates)[0]?.value;
  }

  has(name: string): boolean {
    return this.get(name) !== undefined;
  }

  toObject(): Record<string, string> {
    const out: Record<string, string> = {};
    // Reverse order so the highest-precedence cookie is written last.
    for (const cookie of this.sorted(this.live()).reverse()) out[cookie.name] = cookie.value;
    return out;
  }

  all(): Cookie[] {
    return this.sorted(this.live());
  }

  private keyOf(cookie: Cookie): string {
    return [cookie.name, cookie.domain, cookie.path].join(KEY_SEPARATOR);
  }

  private live(): Cookie[] {
    const now = Date.now();
    const out: Cookie[] = [];
    for (const [key, cookie] of this.cookies) {
      if (cookie.expiresAt !== undefined && cookie.expiresAt <= now) {
        this.cookies.delete(key);
        this.insertedAt.delete(key);
        continue;
      }
      out.push(cookie);
    }
    return out;
  }

  private matching(url: URL): Cookie[] {
    const host = url.hostname.toLowerCase();
    return this.sorted(
      this.live().filter((cookie) => domainMatches(host, cookie) && pathMatches(url.pathname, cookie.path)),
    );
  }

  /** RFC 6265 §5.4: longer paths first, then insertion order. */
  private sorted(cookies: readonly Cookie[]): Cookie[] {
    return [...cookies].sort((a, b) => {
      if (a.path.length !== b.path.length) return b.path.length - a.path.length;
      return (this.insertedAt.get(this.keyOf(a)) ?? 0) - (this.insertedAt.get(this.keyOf(b)) ?? 0);
    });
  }
}
