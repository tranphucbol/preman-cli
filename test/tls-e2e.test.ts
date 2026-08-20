import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:https";
import { join } from "node:path";
import { rootCertificates, type TLSSocket } from "node:tls";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { main } from "@/cli.js";
import { CliError, EXIT } from "@/errors.js";
import { LOAD_OPTIONS } from "@/grpc/schema.js";
import { httpsRequestOptions, resolveTlsCerts } from "@/tls/certs.js";
import {
  cloneFixtureHttpWorkspace,
  cloneFixtureWorkspace,
  CLIENT_KEY_PASSPHRASE,
  FIXTURE_HTTP_WS,
  FIXTURE_INCLUDE_DIR,
  FIXTURE_PROTO,
  sslPath,
  startHttpServer,
  type HttpTestServer,
} from "./helpers.js";

/** The gRPC request in the fixture workspace, and the HTTP one in the HTTP workspace. */
const GRPC_REQUEST = "Echo";
const HTTP_REQUEST = "admin/Echo Get Body";
/** Both fixture certificates cover `localhost`, so that is the only host we may dial. */
const TLS_HOST = "localhost";
const CLIENT_CN = "preman test client";
/** `.postman/preman.yaml`, relative to a cloned workspace root. */
const CONFIG_REL = join(".postman", "preman.yaml");

function pem(name: string): Buffer {
  return readFileSync(sslPath(name));
}

interface GrpcTlsServer {
  port: number;
  close: () => Promise<void>;
}

/**
 * A TLS gRPC server using the committed fixture certificates. `mutual` makes it
 * demand a client certificate signed by the same CA.
 */
async function startGrpcTlsServer(certName: string, mutual = false): Promise<GrpcTlsServer> {
  const pkg = protoLoader.loadSync(FIXTURE_PROTO, { ...LOAD_OPTIONS, includeDirs: [FIXTURE_INCLUDE_DIR] });
  const service = pkg["test.echo.EchoService"] as grpc.ServiceDefinition;

  const handler: grpc.handleUnaryCall<unknown, unknown> = (_call, callback) => {
    callback(null, { return_code: "OK", message: "done" });
  };

  const server = new grpc.Server();
  server.addService(service, { Echo: handler, Ping: handler });

  const credentials = grpc.ServerCredentials.createSsl(
    mutual ? pem("ca.crt") : null,
    [{ private_key: pem(`${certName}.key`), cert_chain: pem(`${certName}.crt`) }],
    mutual,
  );

  const port = await new Promise<number>((resolve, reject) => {
    server.bindAsync(`${TLS_HOST}:0`, credentials, (error, bound) => {
      if (error) reject(error);
      else resolve(bound);
    });
  });

  return { port, close: () => new Promise((done) => server.tryShutdown(() => done())) };
}

interface HttpsTestServer {
  origin: string;
  /** Common name of the client certificate on each accepted request, in order. */
  peerNames: Array<string | undefined>;
  close: () => Promise<void>;
}

/** The HTTPS mirror of {@link startHttpServer}: one route, `/echo`, always 200. */
function startHttpsServer(certName: string, mutual = false): Promise<HttpsTestServer> {
  const peerNames: Array<string | undefined> = [];
  const server: Server = createServer(
    {
      cert: pem(`${certName}.crt`),
      key: pem(`${certName}.key`),
      ...(mutual ? { ca: pem("ca.crt"), requestCert: true, rejectUnauthorized: true } : {}),
    },
    (req, res) => {
      const subject = (req.socket as TLSSocket).getPeerCertificate().subject as { CN?: string } | undefined;
      peerNames.push(subject?.CN);
      req.resume();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ return_code: "OK", peer: subject?.CN ?? null }));
    },
  );

  return new Promise((done, fail) => {
    server.once("error", fail);
    server.listen(0, TLS_HOST, () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        fail(new Error("https test server did not bind a port"));
        return;
      }
      done({
        origin: `https://${TLS_HOST}:${address.port}`,
        peerNames,
        close: () => new Promise((closed) => server.close(() => closed())),
      });
    });
  });
}

let grpcTls: GrpcTlsServer;
let grpcMutual: GrpcTlsServer;
let httpsTls: HttpsTestServer;
let httpsWrongHost: HttpsTestServer;
let httpsMutual: HttpsTestServer;
let plainHttp: HttpTestServer;
/** The gRPC request writes variables back, so it must never run against the real fixture. */
let grpcWs: ReturnType<typeof cloneFixtureWorkspace>;

beforeAll(async () => {
  grpcWs = cloneFixtureWorkspace();
  [grpcTls, grpcMutual, httpsTls, httpsWrongHost, httpsMutual, plainHttp] = await Promise.all([
    startGrpcTlsServer("server"),
    startGrpcTlsServer("server", true),
    startHttpsServer("server"),
    startHttpsServer("wrong-host"),
    startHttpsServer("server", true),
    startHttpServer(),
  ]);
});

afterAll(async () => {
  await Promise.all([
    grpcTls.close(),
    grpcMutual.close(),
    httpsTls.close(),
    httpsWrongHost.close(),
    httpsMutual.close(),
    plainHttp.close(),
  ]);
  grpcWs.cleanup();
});

afterEach(() => {
  httpsTls.peerNames.length = 0;
  httpsMutual.peerNames.length = 0;
  plainHttp.received.length = 0;
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

/** `preman run Echo` against the TLS gRPC server, plus whatever flags the test adds. */
function grpcArgs(port: number, ...extra: string[]): string[] {
  return ["run", GRPC_REQUEST, "-d", grpcWs.root, "-e", "LOCAL", "--url", `${TLS_HOST}:${port}`, "--tls", ...extra];
}

/** `preman run admin/Echo Get Body` against an HTTPS server, plus extra flags. */
function httpArgs(origin: string, ...extra: string[]): string[] {
  return ["run", HTTP_REQUEST, "-d", FIXTURE_HTTP_WS, "-e", "QC", "--var", `http_url=${origin}`, ...extra];
}

describe("private certificate authorities", () => {
  it("givenTlsServerWithPrivateCa_whenRunWithoutCaCerts_thenHandshakeFailsWithExitTwo", async () => {
    const { code } = await runCli(grpcArgs(grpcTls.port));
    expect(code).toBe(EXIT.TRANSPORT);

    const http = await runCli(httpArgs(httpsTls.origin));
    expect(http.code).toBe(EXIT.TRANSPORT);
  });

  it("givenTlsServerWithPrivateCa_whenRunWithoutCaCerts_thenErrorSuggestsSslExtraCaCerts", async () => {
    const { stdout } = await runCli(grpcArgs(grpcTls.port));
    expect(stdout).toContain("--ssl-extra-ca-certs");

    const http = await runCli(httpArgs(httpsTls.origin));
    expect(http.stdout).toContain("--ssl-extra-ca-certs");
  });

  it("givenTlsServerWithPrivateCa_whenRunWithSslExtraCaCerts_thenRequestSucceeds", async () => {
    const { code } = await runCli(grpcArgs(grpcTls.port, "--ssl-extra-ca-certs", sslPath("ca.crt")));
    expect(code).toBe(EXIT.OK);

    const http = await runCli(httpArgs(httpsTls.origin, "--ssl-extra-ca-certs", sslPath("ca.crt")));
    expect(http.code).toBe(EXIT.OK);
    expect(httpsTls.peerNames).toHaveLength(1);
  });

  it("givenTlsServerWithPrivateCa_whenRunWithInsecure_thenRequestSucceeds", async () => {
    const { code } = await runCli(grpcArgs(grpcTls.port, "-k"));
    expect(code).toBe(EXIT.OK);

    const http = await runCli(httpArgs(httpsTls.origin, "-k"));
    expect(http.code).toBe(EXIT.OK);
  });

  it("givenSecondCaOnly_whenRunAgainstFirstCasServer_thenHandshakeFails", async () => {
    const { code } = await runCli(grpcArgs(grpcTls.port, "--ssl-extra-ca-certs", sslPath("other-ca.crt")));
    expect(code).toBe(EXIT.TRANSPORT);

    const http = await runCli(httpArgs(httpsTls.origin, "--ssl-extra-ca-certs", sslPath("other-ca.crt")));
    expect(http.code).toBe(EXIT.TRANSPORT);
  });

  it("givenPublicRootsNeeded_whenCustomCaSupplied_thenPublicRootsStillVerify", async () => {
    const { code } = await runCli(httpArgs(httpsTls.origin, "--ssl-extra-ca-certs", sslPath("ca.crt")));
    expect(code).toBe(EXIT.OK);

    // No publicly-trusted endpoint is reachable from the test suite, so the guarantee
    // is asserted on the options that would go to the wire instead.
    const certs = resolveTlsCerts([
      { label: "--ssl-*", baseDir: process.cwd(), input: { extraCaCerts: sslPath("ca.crt") } },
    ]);
    expect(httpsRequestOptions(certs).ca).toHaveLength(rootCertificates.length + 1);
  });

  it("givenHostnameNotInSan_whenRun_thenErrorNamesTheHostAndTheCertName", async () => {
    const { code, stdout } = await runCli(httpArgs(httpsWrongHost.origin, "--ssl-extra-ca-certs", sslPath("ca.crt")));
    expect(code).toBe(EXIT.TRANSPORT);
    expect(stdout).toContain(TLS_HOST);
    expect(stdout).toContain("wrong.example");
  });
});

describe("mutual TLS", () => {
  it("givenMutualTlsServer_whenRunWithoutClientCert_thenRejected", async () => {
    const { code } = await runCli(httpArgs(httpsMutual.origin, "--ssl-extra-ca-certs", sslPath("ca.crt")));
    expect(code).toBe(EXIT.TRANSPORT);

    const rpc = await runCli(grpcArgs(grpcMutual.port, "--ssl-extra-ca-certs", sslPath("ca.crt")));
    expect(rpc.code).toBe(EXIT.TRANSPORT);
  });

  it("givenMutualTlsServer_whenRunWithClientCert_thenServerSeesTheExpectedSubject", async () => {
    const { code } = await runCli(
      httpArgs(
        httpsMutual.origin,
        "--ssl-extra-ca-certs",
        sslPath("ca.crt"),
        "--ssl-client-cert",
        sslPath("client.crt"),
        "--ssl-client-key",
        sslPath("client.key"),
      ),
    );
    expect(code).toBe(EXIT.OK);
    expect(httpsMutual.peerNames).toEqual([CLIENT_CN]);

    const rpc = await runCli(
      grpcArgs(
        grpcMutual.port,
        "--ssl-extra-ca-certs",
        sslPath("ca.crt"),
        "--ssl-client-cert",
        sslPath("client-combined.pem"),
      ),
    );
    expect(rpc.code).toBe(EXIT.OK);
  });

  it("givenEncryptedClientKey_whenRunWithoutPassphrase_thenCliError", async () => {
    try {
      await runCli(
        httpArgs(
          httpsMutual.origin,
          "--ssl-extra-ca-certs",
          sslPath("ca.crt"),
          "--ssl-client-cert",
          sslPath("client.crt"),
          "--ssl-client-key",
          sslPath("client-encrypted.key"),
        ),
      );
      expect.unreachable("expected encrypted key without passphrase to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(CliError);
      const cliError = error as CliError;
      expect(cliError.exitCode).toBe(EXIT.CLI);
      expect(cliError.details.some((detail) => detail.includes("--ssl-client-passphrase"))).toBe(true);
    }
  });

  it("givenEncryptedClientKey_whenRunWithPassphrase_thenRequestSucceeds", async () => {
    const { code } = await runCli(
      httpArgs(
        httpsMutual.origin,
        "--ssl-extra-ca-certs",
        sslPath("ca.crt"),
        "--ssl-client-cert",
        sslPath("client.crt"),
        "--ssl-client-key",
        sslPath("client-encrypted.key"),
        "--ssl-client-passphrase",
        CLIENT_KEY_PASSPHRASE,
      ),
    );
    expect(code).toBe(EXIT.OK);
    expect(httpsMutual.peerNames).toEqual([CLIENT_CN]);
  });
});

describe("workspace configuration", () => {
  function writeConfig(root: string, body: string): void {
    mkdirSync(join(root, ".postman"), { recursive: true });
    writeFileSync(join(root, CONFIG_REL), body);
  }

  it("givenPremanConfigWithExtraCaCerts_whenRun_thenTheCaIsAppliedWithoutFlags", async () => {
    const clone = cloneFixtureHttpWorkspace();
    try {
      writeConfig(clone.root, `tls:\n  extraCaCerts: ${sslPath("ca.crt")}\n`);
      const { code } = await runCli([
        "run",
        HTTP_REQUEST,
        "-d",
        clone.root,
        "-e",
        "QC",
        "--var",
        `http_url=${httpsTls.origin}`,
      ]);
      expect(code).toBe(EXIT.OK);
    } finally {
      clone.cleanup();
    }
  });

  it("givenPremanConfigAndFlag_whenRun_thenTheFlagWins", async () => {
    const clone = cloneFixtureHttpWorkspace();
    try {
      // The config names the CA that cannot verify this server; the flag names the one that can.
      writeConfig(clone.root, `tls:\n  extraCaCerts: ${sslPath("other-ca.crt")}\n`);
      const { code, stdout } = await runCli([
        "run",
        HTTP_REQUEST,
        "-d",
        clone.root,
        "-e",
        "QC",
        "--var",
        `http_url=${httpsTls.origin}`,
        "--ssl-extra-ca-certs",
        sslPath("ca.crt"),
        "-v",
      ]);
      expect(code).toBe(EXIT.OK);
      expect(stdout).toContain("cert extraCaCerts ← --ssl-*");
    } finally {
      clone.cleanup();
    }
  });
});

describe("cleartext targets", () => {
  it("givenPlaintextTargetAndCertFlags_whenRun_thenFlagsAreIgnoredWithoutError", async () => {
    const { code } = await runCli(
      httpArgs(
        plainHttp.origin,
        "--ssl-extra-ca-certs",
        sslPath("ca.crt"),
        "--ssl-client-cert",
        sslPath("client-combined.pem"),
        "-k",
      ),
    );
    expect(code).toBe(EXIT.OK);
    expect(plainHttp.received).toHaveLength(1);
  });
});
