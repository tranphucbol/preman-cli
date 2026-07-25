import { writeFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";
import { EXIT } from "../src/errors.js";
import {
  cloneFixtureHttpWorkspace,
  collectionPath,
  definitionPath,
  FIXTURE_HTTP_WS,
  HTTP_COOKIE,
  HTTP_COOKIE_VALUE,
  HTTP_TOKEN,
  startHttpServer,
  type HttpTestServer,
} from "./helpers.js";

/** The HTTP half of a `--json` report. Only the fields the assertions touch. */
interface HttpReport {
  protocol: string;
  target: { origin: string; tls: boolean; source: string };
  warnings: string[];
  console: Array<{ level: string; text: string; origin: { level: string; label: string } }>;
  sideRequests: Array<{ method: string; url: string; statusCode: number; ok: boolean }>;
  method: string;
  url: string;
  finalUrl: string;
  request_headers: Record<string, string>;
  request_body: string | undefined;
  ok: boolean;
  status: { code: number; name: string; message: string };
  response: Record<string, unknown> | string | null;
  responseHeaders: Record<string, string | string[]>;
  setCookies: string[];
  redirects: Array<{ status: number; from: string; to: string }>;
  testSummary: { total: number; passed: number; failed: number; skipped: number };
  exitCode: number;
}

interface GroupReport {
  group: string;
  items: Array<{ request: { path: string; kind: string }; status: string; run: HttpReport | undefined }>;
  exitCode: number;
}

let http: HttpTestServer;

beforeAll(async () => {
  http = await startHttpServer();
});

afterAll(async () => {
  await http.close();
});

afterEach(() => {
  http.received.length = 0;
  vi.restoreAllMocks();
});

/** Run the CLI, capturing stdout/stderr instead of letting it reach the terminal. */
async function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr += String(chunk);
    return true;
  });

  try {
    const code = await main(args);
    return { code, stdout, stderr };
  } finally {
    vi.restoreAllMocks();
  }
}

/**
 * The fixture's `http_url` is empty on purpose: the port only exists at runtime,
 * so every run injects it with `--var` instead of `--url` (which would also
 * rewrite the origin of requests that resolve their own).
 */
function args(selector: string, ...extra: string[]): string[] {
  return [
    "run",
    selector,
    "-d",
    FIXTURE_HTTP_WS,
    "-e",
    "QC",
    "--var",
    `http_url=${http.origin}`,
    "--no-save",
    "--json",
    ...extra,
  ];
}

describe("preman run (end to end against a real HTTP server)", () => {
  it("givenLoginRequest_whenRun_thenTheLiveCookieSurvivesTheDeleteThenSetPair", async () => {
    const { code, stdout } = await runCli(args("admin/Login"));
    const report = JSON.parse(stdout) as HttpReport;

    expect(code).toBe(EXIT.OK);
    expect(report.protocol).toBe("http");
    expect(report.status.code).toBe(200);
    // The server sends a deletion at /legacy followed by the real cookie at /.
    expect(report.setCookies).toHaveLength(2);
    // Both scripted tests pass only if pm.response.json() and pm.cookies work.
    expect(report.testSummary).toMatchObject({ total: 2, passed: 2, failed: 0 });
    expect(report.request_headers["content-type"]).toBe("application/json");
  });

  it("givenBearerAuth_whenRun_thenTheBlankAuthorizationHeaderDoesNotShadowIt", async () => {
    const { code, stdout } = await runCli(args("admin/Profile", "--var", `token=${HTTP_TOKEN}`));
    const report = JSON.parse(stdout) as HttpReport;

    expect(code).toBe(EXIT.OK);
    expect(report.status.code).toBe(200);
    // Header names keep the casing that actually went on the wire, and the auth
    // block spells it `Authorization`.
    expect(report.request_headers.Authorization).toBe(`Bearer ${HTTP_TOKEN}`);
    expect(report.request_headers["x-trace"]).toBe("trace-1");
  });

  it("givenQueryParamsDuplicatingTheUrl_whenRun_thenTheParamIsSentOnce", async () => {
    await runCli(args("admin/Profile", "--var", `token=${HTTP_TOKEN}`));

    // `tab` is in the url and in queryParams; `page` is only in queryParams.
    expect(http.received).toHaveLength(1);
    expect(http.received[0]?.url).toBe("/profile?tab=main&page=2");
  });

  it("givenNon2xx_whenRun_thenAfterResponseScriptsStillRunAndExitIsBusiness", async () => {
    const { code, stdout } = await runCli(args("admin/Denied"));
    const report = JSON.parse(stdout) as HttpReport;

    expect(code).toBe(EXIT.BUSINESS);
    expect(report.ok).toBe(false);
    expect(report.status.code).toBe(401);
    // A response arrived, so the script ran and could read the error body.
    expect(report.testSummary).toMatchObject({ total: 1, passed: 1, failed: 0 });
    expect(report.exitCode).toBe(EXIT.BUSINESS);
  });

  it("givenGetWithABody_whenRun_thenTheBodyIsSentVerbatim", async () => {
    const { code, stdout } = await runCli(args("admin/Echo Get Body"));
    const report = JSON.parse(stdout) as HttpReport;

    expect(code).toBe(EXIT.OK);
    expect(http.received[0]?.method).toBe("GET");
    expect(http.received[0]?.body).toBe('{"kept": "verbatim"}');
    expect(report.request_headers["content-type"]).toBe("text/plain");
  });

  it("givenGzippedResponse_whenRun_thenTheBodyIsDecoded", async () => {
    const { code, stdout } = await runCli(args("admin/Squeezed"));
    const report = JSON.parse(stdout) as HttpReport;

    expect(code).toBe(EXIT.OK);
    expect(report.response).toMatchObject({ return_code: "OK", squeezed: true });
  });

  it("givenEndlessRedirects_whenRun_thenItStopsAtTheCapAndWarns", async () => {
    const { code, stdout } = await runCli(args("admin/Round And Round"));
    const report = JSON.parse(stdout) as HttpReport;

    expect(code).toBe(EXIT.BUSINESS);
    expect(report.redirects).toHaveLength(5);
    expect(report.warnings.join("\n")).toMatch(/stopped after 5 redirects/);
    expect(report.finalUrl).not.toBe(report.url);
  });

  it("givenPmSendRequest_whenTheScriptLogsIn_thenTheMainRequestInheritsTokenAndCookie", async () => {
    const { code, stdout } = await runCli(args("admin/Side Login"));
    const report = JSON.parse(stdout) as HttpReport;

    expect(code).toBe(EXIT.OK);
    expect(report.sideRequests).toHaveLength(1);
    expect(report.sideRequests[0]).toMatchObject({ method: "POST", statusCode: 200, ok: true });
    // The side request logged in, so the main request carried both the token…
    expect(report.request_headers.authorization).toBe(`Bearer ${HTTP_TOKEN}`);
    // (spelled lowercase here because the request file wrote it that way)
    // …and the cookie the side request collected.
    expect(String((report.response as Record<string, unknown>).cookie)).toContain(
      `${HTTP_COOKIE}=${HTTP_COOKIE_VALUE}`,
    );
    expect(report.testSummary).toMatchObject({ total: 1, passed: 1, failed: 0 });
  });

  it("givenBeforeRequestScript_whenItSendsWithACallback_thenTheTokenLandsBeforeTheRequestIsBuilt", async () => {
    const { code, stdout } = await runCli(args("Callback Login"));
    const report = JSON.parse(stdout) as HttpReport;

    // The script never awaits pm.sendRequest, so this only passes if the run
    // waits for the call the script left behind.
    expect(report.request_headers.Authorization).toBe(`Bearer ${HTTP_TOKEN}`);
    expect(report.sideRequests).toHaveLength(1);
    expect(report.testSummary).toMatchObject({ total: 1, passed: 1, failed: 0 });
    // The unrecognised script type is reported rather than silently dropped.
    expect(report.warnings.join("\n")).toMatch(/script type "onLunarEclipse" is not recognised/);
    expect(code).toBe(EXIT.OK);
  });

  it("givenCollectionRun_whenLoginComesFirst_thenTheJarAndVariablesAreShared", async () => {
    const { code, stdout } = await runCli(args("admin"));
    const report = JSON.parse(stdout) as GroupReport;

    expect(report.items.map((item) => item.request.path)).toEqual([
      "admin/Login",
      "admin/Profile",
      "admin/Denied",
      "admin/Echo Get Body",
      "admin/Squeezed",
      "admin/Round And Round",
      "admin/Side Login",
      "admin/Callback Login",
    ]);
    // Profile has no token of its own: only Login's script can supply it.
    expect(report.items[1]?.status).toBe("ok");
    expect(report.items[1]?.run?.request_headers.Authorization).toBe(`Bearer ${HTTP_TOKEN}`);
    // Login's Set-Cookie was replayed to Profile by the shared jar.
    expect(String((report.items[1]?.run?.response as Record<string, unknown>).cookie)).toContain(
      `${HTTP_COOKIE}=${HTTP_COOKIE_VALUE}`,
    );
    // Denied (401) and Round And Round (302 after the cap) are business failures.
    expect(report.items.map((item) => item.status)).toEqual([
      "ok",
      "ok",
      "business",
      "ok",
      "ok",
      "business",
      "ok",
      "ok",
    ]);
    expect(code).toBe(EXIT.BUSINESS);
  });

  it("givenWorkspaceWithoutDotPostman_whenListed_thenTheRequestsAreStillFound", async () => {
    const { code, stdout } = await runCli(["list", "-d", FIXTURE_HTTP_WS]);

    expect(code).toBe(EXIT.OK);
    expect(stdout).toContain("Login");
    expect(stdout).toContain("Profile");
  });

  it("givenEmptyBaseUrl_whenRun_thenTheErrorSaysHowToFixIt", async () => {
    await expect(
      runCli(["run", "admin/Denied", "-d", FIXTURE_HTTP_WS, "-e", "QC", "--no-save", "--json"]),
    ).rejects.toThrow(/could not determine an HTTP origin/);
  });

  it("givenUrlOverride_whenRun_thenTheOriginIsReplacedAndThePathKept", async () => {
    const { code, stdout } = await runCli([
      "run",
      "admin/Echo Get Body",
      "-d",
      FIXTURE_HTTP_WS,
      "-e",
      "QC",
      "--url",
      http.origin,
      "--no-save",
      "--json",
    ]);
    const report = JSON.parse(stdout) as HttpReport;

    expect(code).toBe(EXIT.OK);
    expect(report.target.source).toBe("--url");
    expect(http.received[0]?.url).toBe("/echo");
  });
});

/** `args()` against a clone rather than the shared fixture. */
function clonedArgs(root: string, selector: string, ...extra: string[]): string[] {
  return [
    "run",
    selector,
    "-d",
    root,
    "-e",
    "QC",
    "--var",
    `http_url=${http.origin}`,
    "--no-save",
    "--json",
    ...extra,
  ];
}

/** The whole `admin` definition, so the caller controls every inherited key. */
function adminDefinition(body: string): string {
  return `$kind: collection\nname: admin\n${body}`;
}

function writeAdminDefinition(root: string, body: string): void {
  writeFileSync(definitionPath(root, "admin"), adminDefinition(body));
}

/**
 * `Echo Get Body` is the only request that reaches an endpoint which echoes what
 * it received, and every fixture request declares `auth` — so inheritance can
 * only be observed after its own block is removed.
 */
function stripRequestAuth(root: string): void {
  writeFileSync(
    `${collectionPath(root, "admin", "Echo Get Body")}.request.yaml`,
    [
      "$kind: http-request",
      "name: Echo Get Body",
      `url: "{{http_url}}/echo"`,
      "method: GET",
      "order: 40",
      "",
    ].join("\n"),
  );
}

const BEARER_TOKEN_AUTH = ["auth:", "  type: bearer", "  credentials:", `    token: "{{token}}"`].join("\n");

describe("group-level scripts and auth (HTTP)", () => {
  it("givenFolderAuth_whenRequestHasNone_thenInherited", async () => {
    const ws = cloneFixtureHttpWorkspace();
    try {
      writeAdminDefinition(ws.root, BEARER_TOKEN_AUTH);
      stripRequestAuth(ws.root);

      const { code, stdout } = await runCli(
        clonedArgs(ws.root, "admin/Echo Get Body", "--var", `token=${HTTP_TOKEN}`),
      );
      const report = JSON.parse(stdout) as HttpReport;

      expect(code).toBe(EXIT.OK);
      expect(report.request_headers.Authorization).toBe(`Bearer ${HTTP_TOKEN}`);
      expect(http.received[0]?.headers.authorization).toBe(`Bearer ${HTTP_TOKEN}`);
      // Inherited auth is announced: a stale token is otherwise an unexplained 401.
      expect(report.warnings).toContain("auth inherited from collection admin");
    } finally {
      ws.cleanup();
    }
  });

  it("givenFolderAuth_whenRequestDeclaresNoauth_thenUnauthenticated", async () => {
    const ws = cloneFixtureHttpWorkspace();
    try {
      // The request keeps its own `auth: {type: noauth}`, which must win.
      writeAdminDefinition(ws.root, BEARER_TOKEN_AUTH);

      const { code, stdout } = await runCli(
        clonedArgs(ws.root, "admin/Echo Get Body", "--var", `token=${HTTP_TOKEN}`),
      );
      const report = JSON.parse(stdout) as HttpReport;

      expect(code).toBe(EXIT.OK);
      expect(report.request_headers.Authorization).toBeUndefined();
      expect(http.received[0]?.headers.authorization).toBeUndefined();
      expect(report.warnings.join("\n")).not.toContain("auth inherited");
    } finally {
      ws.cleanup();
    }
  });

  it("givenCollectionScriptWithHttpPrefix_whenRun_thenItRunsWithOriginTagged", async () => {
    const ws = cloneFixtureHttpWorkspace();
    try {
      writeAdminDefinition(
        ws.root,
        ["scripts:", "  - type: http:beforeRequest", "    code: |", `      console.log("from the collection");`].join(
          "\n",
        ),
      );

      const { code, stdout } = await runCli(clonedArgs(ws.root, "admin/Echo Get Body"));
      const report = JSON.parse(stdout) as HttpReport;

      expect(code).toBe(EXIT.OK);
      expect(report.console).toEqual([
        { level: "log", text: "from the collection", origin: { level: "collection", label: "collection admin" } },
      ]);
    } finally {
      ws.cleanup();
    }
  });

  it("givenGrpcPrefixedScript_whenHttpRequestRuns_thenSkippedSilently", async () => {
    const ws = cloneFixtureHttpWorkspace();
    try {
      writeAdminDefinition(
        ws.root,
        ["scripts:", "  - type: grpc:beforeInvoke", "    code: |", `      console.log("wrong protocol");`].join("\n"),
      );

      const { code, stdout } = await runCli(clonedArgs(ws.root, "admin/Echo Get Body"));
      const report = JSON.parse(stdout) as HttpReport;

      expect(code).toBe(EXIT.OK);
      // The prefix exists precisely so a mixed folder does not warn on every request.
      expect(report.warnings).toEqual([]);
      expect(report.console).toEqual([]);
    } finally {
      ws.cleanup();
    }
  });
});
