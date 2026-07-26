import { readFileSync } from "node:fs";
import { rootCertificates } from "node:tls";
import { describe, expect, it } from "vitest";
import { CliError, EXIT } from "../src/errors.js";
import {
  emptyTlsCerts,
  grpcChannelCredentials,
  httpsRequestOptions,
  resolveTlsCerts,
  secureContextOptions,
  tlsFailureHints,
  type TlsCertLayer,
} from "../src/tls/certs.js";
import { SSL_DIR, sslPath } from "./helpers.js";

const CLI_LABEL = "--ssl-*";
const CONFIG_LABEL = ".postman/preman.yaml";

function cliLayer(input: TlsCertLayer["input"]): TlsCertLayer {
  return { label: CLI_LABEL, baseDir: SSL_DIR, input };
}

describe("resolveTlsCerts", () => {
  it("givenNoLayers_whenResolvingTlsCerts_thenEveryFieldIsUndefined", () => {
    const certs = resolveTlsCerts([]);

    expect(certs.extraCaCerts).toBeUndefined();
    expect(certs.clientCert).toBeUndefined();
    expect(certs.clientKey).toBeUndefined();
    expect(certs.clientPassphrase).toBeUndefined();
    expect(certs.insecure).toBe(false);
    expect(certs.sources).toEqual({});
    expect(certs.warnings).toEqual([]);
  });

  it("givenCliAndConfigLayers_whenResolving_thenTheCliLayerWins", () => {
    const certs = resolveTlsCerts([
      cliLayer({ extraCaCerts: "ca.crt" }),
      { label: CONFIG_LABEL, baseDir: SSL_DIR, input: { extraCaCerts: "other-ca.crt" } },
    ]);

    expect(certs.extraCaCerts?.toString()).toBe(readFileSync(sslPath("ca.crt"), "utf8"));
    expect(certs.sources.extraCaCerts).toContain(CLI_LABEL);
  });

  it("givenConfigRelativePath_whenResolving_thenItIsRelativeToDotPostman", () => {
    const certs = resolveTlsCerts([{ label: CONFIG_LABEL, baseDir: SSL_DIR, input: { extraCaCerts: "ca.crt" } }]);

    expect(certs.sources.extraCaCerts).toBe(`${CONFIG_LABEL} (${sslPath("ca.crt")})`);
  });

  it("givenMissingCertPath_whenResolving_thenCliErrorNamesTheFlagAndPath", () => {
    let thrown: CliError | undefined;
    try {
      resolveTlsCerts([cliLayer({ extraCaCerts: "nope.crt" })]);
    } catch (error) {
      thrown = error as CliError;
    }

    expect(thrown).toBeInstanceOf(CliError);
    expect(thrown?.exitCode).toBe(EXIT.CLI);
    expect(thrown?.message).toContain("--ssl-extra-ca-certs");
    expect(thrown?.details.join("\n")).toContain(sslPath("nope.crt"));
    expect(thrown?.details.join("\n")).toContain("ENOENT");
  });

  it("givenClientCertWithoutKey_whenResolving_thenTheCertBufferIsUsedAsTheKey", () => {
    const certs = resolveTlsCerts([cliLayer({ clientCert: "client-combined.pem" })]);
    const context = secureContextOptions(certs);

    expect(context.cert).toEqual(certs.clientCert);
    expect(context.key).toEqual(certs.clientCert);
  });

  it("givenClientKeyWithoutCert_whenResolving_thenCliError", () => {
    expect(() => resolveTlsCerts([cliLayer({ clientKey: "client.key" })])).toThrowError(
      /--ssl-client-key needs --ssl-client-cert/,
    );
  });

  it("givenPassphraseWithoutKey_whenResolving_thenWarningNotError", () => {
    const certs = resolveTlsCerts([cliLayer({ clientPassphrase: "secret" })]);

    expect(certs.warnings).toHaveLength(1);
    expect(certs.warnings[0]).toContain("--ssl-client-passphrase");
    expect(secureContextOptions(certs).passphrase).toBeUndefined();
  });
});

describe("secureContextOptions", () => {
  it("givenNoCerts_whenBuildingSecureContext_thenNodeDefaultsAreUntouched", () => {
    expect(secureContextOptions(emptyTlsCerts())).toEqual({});
  });

  it("givenExtraCaCerts_whenBuildingSecureContext_thenSystemRootsArePreserved", () => {
    const context = secureContextOptions(resolveTlsCerts([cliLayer({ extraCaCerts: "ca.crt" })]));

    expect(context.ca).toHaveLength(rootCertificates.length + 1);
    expect(context.ca).toEqual(expect.arrayContaining([rootCertificates[0]]));
  });

  it("givenExtraCaCerts_whenBuildingSecureContext_thenTheCustomCaIsLast", () => {
    const context = secureContextOptions(resolveTlsCerts([cliLayer({ extraCaCerts: "ca.crt" })]));
    const ca = context.ca as string[];

    expect(ca[ca.length - 1]).toBe(readFileSync(sslPath("ca.crt"), "utf8"));
  });
});

describe("httpsRequestOptions", () => {
  it("givenInsecure_whenBuildingHttpsOptions_thenRejectUnauthorizedIsFalse", () => {
    const certs = resolveTlsCerts([cliLayer({ extraCaCerts: "ca.crt", insecure: true })]);
    const options = httpsRequestOptions(certs);

    expect(options.rejectUnauthorized).toBe(false);
    // -k must not silently drop a CA the user also supplied.
    expect(options.ca).toHaveLength(rootCertificates.length + 1);
  });
});

describe("grpcChannelCredentials", () => {
  it("givenPlaintextTarget_whenBuildingGrpcCredentials_thenInsecureCredentialsAreUsed", () => {
    const certs = resolveTlsCerts([cliLayer({ extraCaCerts: "ca.crt" })]);

    expect(grpcChannelCredentials(certs, false)._isSecure()).toBe(false);
    expect(grpcChannelCredentials(certs, true)._isSecure()).toBe(true);
  });
});

describe("tlsFailureHints", () => {
  it("givenUntrustedChainError_whenBuildingHints_thenTheExtraCaFlagIsSuggested", () => {
    const fromHttp = tlsFailureHints(Object.assign(new Error("self signed"), { code: "SELF_SIGNED_CERT_IN_CHAIN" }));
    const fromGrpc = tlsFailureHints(new Error("Handshake failed with fatal error SELF_SIGNED_CERT_IN_CHAIN"));

    expect(fromHttp[0]).toContain("--ssl-extra-ca-certs");
    expect(fromGrpc).toEqual(fromHttp);
    expect(tlsFailureHints(new Error("connection refused"))).toEqual([]);
  });

  it("givenHostnameMismatchError_whenBuildingHints_thenTheHostAndCertNameAreEchoed", () => {
    const reason = "Host: 127.0.0.1. is not in the cert's altnames: DNS:wrong.example";
    const hints = tlsFailureHints(
      Object.assign(new Error(reason), { code: "ERR_TLS_CERT_ALTNAME_INVALID", reason }),
    );

    expect(hints).toHaveLength(1);
    expect(hints[0]).toContain("127.0.0.1");
    expect(hints[0]).toContain("wrong.example");
  });
});
