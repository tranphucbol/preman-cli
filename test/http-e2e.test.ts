import { createHmac } from "node:crypto";
import { appendFileSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { main } from "@preman/cli/main.js";
import { EXIT } from "@preman/core/errors.js";
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

  /**
   * Decision 041, the HTTP half. The status line and body are already in hand, so the throw is
   * recorded against the response instead of replacing it - and `--no-save` is deliberately
   * absent, because the writeback is the half of this that a throw used to skip.
   */
  it("givenATestScriptThatThrows_whenRun_thenTheResponseIsStillReportedAndSaved", async () => {
    const ws = cloneFixtureHttpWorkspace();
    try {
      appendFileSync(
        `${collectionPath(ws.root, "admin", "Echo Get Body")}.request.yaml`,
        [
          "",
          "scripts:",
          "  - type: test",
          "    language: javascript",
          "    code: |-",
          '      pm.test("status is 200", () => pm.expect(pm.response.code).to.equal(200));',
          '      pm.environment.set("echo_seen", "yes");',
          '      throw new Error("order amount must be a non-negative safe integer");',
          "",
        ].join("\n"),
      );

      const { code, stdout } = await runCli([
        "run",
        "admin/Echo Get Body",
        "-d",
        ws.root,
        "-e",
        "QC",
        "--var",
        `http_url=${http.origin}`,
        "--json",
      ]);

      expect(code).toBe(EXIT.TEST);

      const report = JSON.parse(stdout) as HttpReport & {
        tests: Array<{ name: string; status: string; error: string | null }>;
        savedVars: Record<string, string>;
        savedTo: string | null;
      };

      expect(report.status.code).toBe(200);
      expect(report.response).not.toBeNull();
      expect(report.tests[0]).toMatchObject({ name: "status is 200", status: "passed" });
      expect(report.tests[1]).toMatchObject({
        name: 'script "test"',
        status: "failed",
        error: "order amount must be a non-negative safe integer",
      });
      expect(report.testSummary).toMatchObject({ passed: 1, failed: 1 });
      expect(report.savedVars.echo_seen).toBe("yes");
      expect(readFileSync(report.savedTo!, "utf8")).toContain("echo_seen");
    } finally {
      ws.cleanup();
    }
  });

  it("givenAUrlencodedBodySignedByAScript_whenRun_thenTheFormReachesTheWireEncoded", async () => {
    const { code, stdout } = await runCli(args("admin/Signed Form"));
    const report = JSON.parse(stdout) as HttpReport;
    const signature = createHmac("sha256", "fixture-secret").update("11|a+b/c=").digest("hex");

    expect(code).toBe(EXIT.OK);
    expect(http.received[0]?.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(http.received[0]?.headers["x-signature"]).toBe(signature);
    expect(http.received[0]?.body).toBe(`clientid=11&note=a%2Bb%2Fc%3D&sig=${signature}`);
    // Both scripts assert too: the pre-request one on the authored fields, the
    // post-response one on what came back.
    expect(report.testSummary).toMatchObject({ total: 2, passed: 2, failed: 0 });
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
      "admin/Signed Form",
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
  return ["run", selector, "-d", root, "-e", "QC", "--var", `http_url=${http.origin}`, "--no-save", "--json", ...extra];
}

/** The whole `admin` definition, so the caller controls every inherited key. */
function adminDefinition(body: string): string {
  return `$kind: collection\nname: admin\n${body}`;
}

function writeAdminDefinition(root: string, body: string): void {
  writeFileSync(definitionPath(root, "admin"), adminDefinition(body));
}

function writeScriptedHttpRequest(
  root: string,
  options: { path?: string; method?: string; headers?: string; body?: string; script: string; afterScript?: string },
): void {
  const indentScript = (script: string): string =>
    script
      .trimEnd()
      .split("\n")
      .map((line) => `      ${line}`)
      .join("\n");
  const scripts = ["scripts:", "  - type: beforeRequest", "    code: |", indentScript(options.script)];
  if (options.afterScript !== undefined) {
    scripts.push("  - type: afterResponse", "    code: |", indentScript(options.afterScript));
  }
  writeFileSync(
    `${collectionPath(root, "admin", "Echo Get Body")}.request.yaml`,
    [
      "$kind: http-request",
      "name: Echo Get Body",
      `url: "{{http_url}}${options.path ?? "/echo"}"`,
      `method: ${options.method ?? "GET"}`,
      options.headers ?? "",
      options.body ?? "",
      "auth:",
      "  type: noauth",
      ...scripts,
      "order: 40",
      "",
    ]
      .filter((line) => line.length > 0)
      .join("\n"),
  );
}

describe("structured HTTP bodies", () => {
  it("givenFormDataUpload_whenRun_thenServerReceivesBothParts", async () => {
    const ws = cloneFixtureHttpWorkspace();
    try {
      writeScriptedHttpRequest(ws.root, {
        method: "POST",
        body: [
          "body:",
          "  type: formdata",
          "  formdata:",
          "    - key: note",
          "      value: '{{token}}'",
          "    - key: receipt",
          "      type: file",
          "      src: upload/receipt.txt",
        ].join("\n"),
        script: "// File selection is fixed before scripts run.",
      });
      const { code, stdout } = await runCli(clonedArgs(ws.root, "admin/Echo Get Body", "--var", "token=uploaded"));
      const report = JSON.parse(stdout) as HttpReport;

      expect(code).toBe(EXIT.OK);
      expect(http.received[0]?.headers["content-type"]).toMatch(/^multipart\/form-data; boundary=/);
      expect(http.received[0]?.body).toContain('Content-Disposition: form-data; name="note"\r\n\r\nuploaded');
      expect(http.received[0]?.body).toContain('name="receipt"; filename="receipt.txt"');
      expect(http.received[0]?.body).toContain("receipt-id=fixture-123");
      expect(report.request_body).toMatch(/^<\d+ bytes>$/);
    } finally {
      ws.cleanup();
    }
  });

  it("givenBinaryFileUpload_whenRun_thenServerReceivesIdenticalBytes", async () => {
    const ws = cloneFixtureHttpWorkspace();
    try {
      writeScriptedHttpRequest(ws.root, {
        method: "POST",
        body: "body:\n  type: file\n  file:\n    src: upload/pixel.png",
        script: "// Binary file body.",
      });
      const { code, stdout } = await runCli(clonedArgs(ws.root, "admin/Echo Get Body"));
      const report = JSON.parse(stdout) as HttpReport;

      expect(code).toBe(EXIT.OK);
      expect(http.received[0]?.bodyBuffer).toEqual(readFileSync(`${ws.root}/upload/pixel.png`));
      expect(http.received[0]?.headers["content-type"]).toBe("image/png");
      expect(report.request_body).toBe(`<${http.received[0]?.bodyBuffer.length} bytes>`);
    } finally {
      ws.cleanup();
    }
  });

  /**
   * The same bug as the gRPC one, from the other transport. A `beforeRequest` script sets the
   * variable its own body and header name; before the request resolved a second time, both went
   * out holding whatever the environment file happened to have, and on a fresh workspace that was
   * nothing at all.
   */
  it("givenScriptSettingAVariableItsOwnBodyNames_whenRun_thenTheWireHasTheScriptsValue", async () => {
    const ws = cloneFixtureHttpWorkspace();
    try {
      writeScriptedHttpRequest(ws.root, {
        method: "POST",
        headers: 'headers:\n  - key: x-stamp\n    value: "{{stamp}}"',
        body: 'body:\n  type: text\n  content: \'{"stamp": "{{stamp}}"}\'',
        script: 'pm.environment.set("stamp", "set-by-the-script");',
      });

      const { code } = await runCli(clonedArgs(ws.root, "admin/Echo Get Body"));

      expect(code).toBe(EXIT.OK);
      expect(http.received[0]?.body).toBe('{"stamp": "set-by-the-script"}');
      expect(http.received[0]?.headers["x-stamp"]).toBe("set-by-the-script");
    } finally {
      ws.cleanup();
    }
  });

  it("givenScriptReplacingFileBody_whenRun_thenScriptBodyWins", async () => {
    const ws = cloneFixtureHttpWorkspace();
    try {
      writeScriptedHttpRequest(ws.root, {
        method: "POST",
        body: "body:\n  type: file\n  file:\n    src: upload/pixel.png",
        script: 'pm.request.body.mode = "text"; pm.request.body.raw = "replacement";',
      });
      const { code } = await runCli(clonedArgs(ws.root, "admin/Echo Get Body"));
      expect(code).toBe(EXIT.OK);
      expect(http.received[0]?.body).toBe("replacement");
      expect(http.received[0]?.headers["content-type"]).toBe("text/plain");
    } finally {
      ws.cleanup();
    }
  });

  it("givenStructuredUrlencoded_whenRun_thenServerReceivesEncodedForm", async () => {
    const ws = cloneFixtureHttpWorkspace();
    try {
      writeScriptedHttpRequest(ws.root, {
        method: "POST",
        body: "body:\n  type: urlencoded\n  urlencoded:\n    - key: note\n      value: a+b/c=",
        script: "// Structured form body.",
      });
      const { code } = await runCli(clonedArgs(ws.root, "admin/Echo Get Body"));
      expect(code).toBe(EXIT.OK);
      expect(http.received[0]?.body).toBe("note=a%2Bb%2Fc%3D");
    } finally {
      ws.cleanup();
    }
  });

  it("givenGraphqlRequest_whenRun_thenServerReceivesQueryAndVariables", async () => {
    const ws = cloneFixtureHttpWorkspace();
    try {
      writeScriptedHttpRequest(ws.root, {
        method: "POST",
        body: [
          "body:",
          "  type: graphql",
          "  graphql:",
          "    query: 'query Receipt($id: Int!) { receipt(id: $id) { id } }'",
          "    variables: '{\"id\":7}'",
        ].join("\n"),
        script: "// GraphQL body.",
      });
      const { code } = await runCli(clonedArgs(ws.root, "admin/Echo Get Body"));
      expect(code).toBe(EXIT.OK);
      expect(JSON.parse(http.received[0]?.body ?? "")).toEqual({
        query: "query Receipt($id: Int!) { receipt(id: $id) { id } }",
        variables: { id: 7 },
      });
    } finally {
      ws.cleanup();
    }
  });

  it("givenUploadFollowingRedirect_whenRun_thenBodyReplayedIntact", async () => {
    const ws = cloneFixtureHttpWorkspace();
    try {
      writeScriptedHttpRequest(ws.root, {
        path: "/redirect-preserve",
        method: "POST",
        body: "body:\n  type: file\n  file:\n    src: upload/pixel.png",
        script: "// Replayable buffered body.",
      });
      const { code } = await runCli(clonedArgs(ws.root, "admin/Echo Get Body"));
      expect(code).toBe(EXIT.OK);
      expect(http.received).toHaveLength(2);
      expect(http.received[1]?.bodyBuffer).toEqual(http.received[0]?.bodyBuffer);
    } finally {
      ws.cleanup();
    }
  });

  it("givenMissingUploadFile_whenRun_thenExitsOneNamingTheField", async () => {
    const ws = cloneFixtureHttpWorkspace();
    try {
      writeScriptedHttpRequest(ws.root, {
        method: "POST",
        body: "body:\n  type: formdata\n  formdata:\n    - key: receipt\n      type: file\n      src: missing.pdf",
        script: "// Missing upload.",
      });
      await expect(runCli(clonedArgs(ws.root, "admin/Echo Get Body"))).rejects.toThrow(/formdata field "receipt"/);
      expect(http.received).toHaveLength(0);
    } finally {
      ws.cleanup();
    }
  });

  it("givenUploadOutsideWorkingDir_whenRun_thenExitsOneUntilInsecureFileReadPassed", async () => {
    const ws = cloneFixtureHttpWorkspace();
    const outside = `${ws.root}-outside.txt`;
    try {
      writeFileSync(outside, "outside fixture");
      writeScriptedHttpRequest(ws.root, {
        method: "POST",
        body: `body:\n  type: file\n  file:\n    src: ../${basename(outside)}`,
        script: "// Outside upload.",
      });
      await expect(runCli(clonedArgs(ws.root, "admin/Echo Get Body"))).rejects.toThrow(/outside the working directory/);
      const { code } = await runCli(clonedArgs(ws.root, "admin/Echo Get Body", "--insecure-file-read"));
      expect(code).toBe(EXIT.OK);
      expect(http.received[0]?.body).toBe("outside fixture");
    } finally {
      rmSync(outside, { force: true });
      ws.cleanup();
    }
  });

  it("givenWorkingDir_whenRun_thenRelativeUploadUsesThatDirectory", async () => {
    const ws = cloneFixtureHttpWorkspace();
    try {
      writeScriptedHttpRequest(ws.root, {
        method: "POST",
        body: "body:\n  type: file\n  file:\n    src: receipt.txt",
        script: "// Custom working directory.",
      });
      const { code } = await runCli(clonedArgs(ws.root, "admin/Echo Get Body", "--working-dir", `${ws.root}/upload`));
      expect(code).toBe(EXIT.OK);
      expect(http.received[0]?.body).toBe("receipt-id=fixture-123\n");
    } finally {
      ws.cleanup();
    }
  });
});

/**
 * `Echo Get Body` is the only request that reaches an endpoint which echoes what
 * it received, and every fixture request declares `auth` — so inheritance can
 * only be observed after its own block is removed.
 */
function stripRequestAuth(root: string): void {
  writeFileSync(
    `${collectionPath(root, "admin", "Echo Get Body")}.request.yaml`,
    ["$kind: http-request", "name: Echo Get Body", `url: "{{http_url}}/echo"`, "method: GET", "order: 40", ""].join(
      "\n",
    ),
  );
}

const BEARER_TOKEN_AUTH = ["auth:", "  type: bearer", "  credentials:", `    token: "{{token}}"`].join("\n");

describe("group-level scripts and auth (HTTP)", () => {
  it("givenFolderAuth_whenRequestHasNone_thenInherited", async () => {
    const ws = cloneFixtureHttpWorkspace();
    try {
      writeAdminDefinition(ws.root, BEARER_TOKEN_AUTH);
      stripRequestAuth(ws.root);

      const { code, stdout } = await runCli(clonedArgs(ws.root, "admin/Echo Get Body", "--var", `token=${HTTP_TOKEN}`));
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

      const { code, stdout } = await runCli(clonedArgs(ws.root, "admin/Echo Get Body", "--var", `token=${HTTP_TOKEN}`));
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

describe("mutable pm.request (HTTP)", () => {
  it("givenPreRequestScriptAddingHeader_whenRun_thenServerReceivesHeader", async () => {
    const ws = cloneFixtureHttpWorkspace();
    try {
      writeScriptedHttpRequest(ws.root, { script: 'pm.request.headers.add("X-Scripted", "yes");' });
      const { code } = await runCli(clonedArgs(ws.root, "admin/Echo Get Body"));
      expect(code).toBe(EXIT.OK);
      expect(http.received[0]?.headers["x-scripted"]).toBe("yes");
    } finally {
      ws.cleanup();
    }
  });

  it("givenPreRequestScriptReplacingAuthorization_whenRun_thenServerReceivesScriptValue", async () => {
    const ws = cloneFixtureHttpWorkspace();
    try {
      writeScriptedHttpRequest(ws.root, {
        path: "/profile",
        headers: 'headers:\n  Authorization: "Bearer wrong"',
        script: `pm.request.headers.upsert("Authorization", "Bearer ${HTTP_TOKEN}");`,
      });
      const { code } = await runCli(clonedArgs(ws.root, "admin/Echo Get Body"));
      expect(code).toBe(EXIT.OK);
      expect(http.received[0]?.headers.authorization).toBe(`Bearer ${HTTP_TOKEN}`);
    } finally {
      ws.cleanup();
    }
  });

  it("givenPreRequestScriptSettingContentType_whenRun_thenInferredTypeNotApplied", async () => {
    const ws = cloneFixtureHttpWorkspace();
    try {
      writeScriptedHttpRequest(ws.root, {
        method: "POST",
        body: "body:\n  type: json\n  content: '{\"a\":1}'",
        script: 'pm.request.headers.upsert("Content-Type", "application/vnd.test+json");',
      });
      const { code } = await runCli(clonedArgs(ws.root, "admin/Echo Get Body"));
      expect(code).toBe(EXIT.OK);
      expect(http.received[0]?.headers["content-type"]).toBe("application/vnd.test+json");
    } finally {
      ws.cleanup();
    }
  });

  it("givenPreRequestScriptRewritingUrl_whenRun_thenServerReceivesNewPath", async () => {
    const ws = cloneFixtureHttpWorkspace();
    try {
      writeScriptedHttpRequest(ws.root, {
        path: "/boom",
        script: 'pm.request.url = pm.variables.get("http_url") + "/echo?rewritten=true";',
      });
      const { code } = await runCli(clonedArgs(ws.root, "admin/Echo Get Body"));
      expect(code).toBe(EXIT.OK);
      expect(http.received[0]?.url).toBe("/echo?rewritten=true");
    } finally {
      ws.cleanup();
    }
  });

  it("givenPreRequestScriptSettingUnsupportedMethod_whenRun_thenMethodError", async () => {
    const ws = cloneFixtureHttpWorkspace();
    try {
      writeScriptedHttpRequest(ws.root, { script: 'pm.request.method = "CONNECT";' });
      await expect(runCli(clonedArgs(ws.root, "admin/Echo Get Body"))).rejects.toThrow(
        'unsupported HTTP method "CONNECT"',
      );
      expect(http.received).toHaveLength(0);
    } finally {
      ws.cleanup();
    }
  });

  it("givenInterpolatedHeader_whenScriptReads_thenSeesResolvedValue", async () => {
    const ws = cloneFixtureHttpWorkspace();
    try {
      writeScriptedHttpRequest(ws.root, {
        headers: 'headers:\n  X-Template: "{{token}}"',
        script: 'pm.request.headers.add("X-Seen", pm.request.headers.get("x-template"));',
      });
      const { code } = await runCli(clonedArgs(ws.root, "admin/Echo Get Body", "--var", `token=${HTTP_TOKEN}`));
      expect(code).toBe(EXIT.OK);
      expect(http.received[0]?.headers["x-seen"]).toBe(HTTP_TOKEN);
    } finally {
      ws.cleanup();
    }
  });

  it("givenRedirect_whenAfterResponseRuns_thenRequestShowsTheFinalHop", async () => {
    const ws = cloneFixtureHttpWorkspace();
    try {
      writeScriptedHttpRequest(ws.root, {
        path: "/redirect-echo",
        method: "POST",
        headers: "headers:\n  X-Initial: yes",
        body: "body:\n  type: json\n  content: '{\"a\":1}'",
        script: 'pm.request.headers.add("X-Scripted", "yes");',
        afterScript: [
          'pm.test("request is the final hop", function () {',
          '  pm.expect(pm.request.method).to.equal("GET");',
          '  pm.expect(String(pm.request.url)).to.equal(pm.variables.get("http_url") + "/echo?redirected=true");',
          '  pm.expect(pm.request.body.raw).to.equal("");',
          '  pm.expect(pm.request.headers.has("content-type")).to.be.false;',
          '  pm.expect(pm.request.headers.has("content-length")).to.be.false;',
          "});",
        ].join("\n"),
      });

      const { code, stdout } = await runCli(clonedArgs(ws.root, "admin/Echo Get Body"));
      const report = JSON.parse(stdout) as HttpReport;

      expect(code).toBe(EXIT.OK);
      expect(http.received.map((item) => item.method)).toEqual(["POST", "GET"]);
      expect(report.method).toBe("GET");
      expect(report.finalUrl).toBe(`${http.origin}/echo?redirected=true`);
      expect(report.testSummary).toMatchObject({ total: 1, passed: 1, failed: 0 });
    } finally {
      ws.cleanup();
    }
  });
});

describe("sandbox library isolation (HTTP)", () => {
  it.each([
    { label: "node builtin", script: 'require("fs");', expected: "fs" },
    { label: "relative module", script: 'require("./x.js");', expected: "./x.js" },
    { label: "Function constructor", script: 'Function("return process")();', expected: "Function is not a function" },
  ])("givenScriptUsing$label_whenRun_thenRejected", async ({ script, expected }) => {
    const ws = cloneFixtureHttpWorkspace();
    try {
      writeScriptedHttpRequest(ws.root, { script });
      await expect(runCli(clonedArgs(ws.root, "admin/Echo Get Body"))).rejects.toThrow(expected);
      expect(http.received).toHaveLength(0);
    } finally {
      ws.cleanup();
    }
  });
});
