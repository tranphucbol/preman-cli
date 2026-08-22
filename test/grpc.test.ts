import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PremanError } from "@preman/core/errors.js";
import { listMethods, resolveMethod, splitMethodPath } from "@preman/core/grpc/schema.js";
import { parseAuthority, readLocalGrpcPort, resolveTarget, shouldUseTls } from "@preman/core/grpc/target.js";
import { FIXTURE_INCLUDE_DIR, FIXTURE_WS, FIXTURES_DIR, requestPath } from "./helpers.js";

/** The real base64 FileDescriptorSet captured by Postman for pe.aev2.ExchangeService.Exchange. */
const REAL_DESCRIPTOR = readFileSync(join(FIXTURES_DIR, "method-descriptor.b64.txt"), "utf8").trim();

describe("splitMethodPath", () => {
  it("givenDottedPath_whenSplit_thenSplitsOnTheLastDot", () => {
    expect(splitMethodPath("pe.aev2.ExchangeService.Exchange")).toEqual({
      serviceName: "pe.aev2.ExchangeService",
      methodName: "Exchange",
    });
  });

  it("givenWireFormPath_whenSplit_thenSplitsOnTheSlash", () => {
    expect(splitMethodPath("/pe.aev2.ExchangeService/Exchange")).toEqual({
      serviceName: "pe.aev2.ExchangeService",
      methodName: "Exchange",
    });
  });

  it.each(["", "Exchange", "pe.aev2.ExchangeService.", ".Exchange", "/Exchange", "svc/"])(
    "givenUnparseablePath_whenSplit_thenThrows: %j",
    (path) => {
      expect(() => splitMethodPath(path)).toThrow(PremanError);
    },
  );
});

describe("resolveMethod", () => {
  const base = {
    requestFilePath: requestPath("Echo.request.yaml"),
    includeDirs: [FIXTURE_INCLUDE_DIR],
    methodDescriptor: undefined,
    preferDescriptor: false,
  };

  it("givenProtoFileWithRootRelativeImport_whenResolved_thenLoadsViaIncludeDirs", () => {
    const resolved = resolveMethod({
      ...base,
      schemaLocation: "../../../src/main/proto/echo/echo.proto",
      methodPath: "test.echo.EchoService.Echo",
    });

    expect(resolved.source).toBe("proto-file");
    expect(resolved.warnings).toEqual([]);
    expect(resolved.serviceName).toBe("test.echo.EchoService");
    expect(resolved.methodName).toBe("Echo");
    expect(resolved.definition.path).toBe("/test.echo.EchoService/Echo");
    expect(resolved.definition.requestStream).toBe(false);
    expect(resolved.definition.responseStream).toBe(false);
  });

  it("givenMissingProtoFileAndADescriptor_whenResolved_thenFallsBackAndWarns", () => {
    const resolved = resolveMethod({
      ...base,
      schemaLocation: "./does-not-exist.proto",
      methodDescriptor: REAL_DESCRIPTOR,
      methodPath: "pe.aev2.ExchangeService.Exchange",
    });

    expect(resolved.source).toBe("descriptor");
    expect(resolved.definition.path).toBe("/pe.aev2.ExchangeService/Exchange");
    expect(resolved.warnings.some((w) => w.includes("schema file not found"))).toBe(true);
    expect(resolved.warnings.some((w) => w.includes("stale or partial"))).toBe(true);
  });

  it("givenPreferDescriptor_whenProtoFileExists_thenStillUsesTheDescriptor", () => {
    const resolved = resolveMethod({
      ...base,
      schemaLocation: "../../../src/main/proto/echo/echo.proto",
      methodDescriptor: REAL_DESCRIPTOR,
      methodPath: "pe.aev2.ExchangeService.Exchange",
      preferDescriptor: true,
    });
    expect(resolved.source).toBe("descriptor");
    // The proto file was skipped entirely, so there is no "not found" warning.
    expect(resolved.warnings).toEqual(["using the descriptor embedded in the request; it may be stale or partial"]);
  });

  it("givenCapturedDescriptor_whenListingMethods_thenOnlyTheCapturedMethodIsPresent", () => {
    // The Postman client captures only the invoked method: Exchange is there, Query is not.
    const exchange = () =>
      resolveMethod({
        ...base,
        schemaLocation: undefined,
        methodDescriptor: REAL_DESCRIPTOR,
        methodPath: "pe.aev2.ExchangeService.Exchange",
      });
    expect(exchange().source).toBe("descriptor");

    try {
      resolveMethod({
        ...base,
        schemaLocation: undefined,
        methodDescriptor: REAL_DESCRIPTOR,
        methodPath: "pe.aev2.ExchangeService.Query",
      });
      expect.unreachable("Query should be absent from the captured descriptor");
    } catch (error) {
      expect(error).toBeInstanceOf(PremanError);
      expect((error as PremanError).message).toContain('method "Query" not found on pe.aev2.ExchangeService');
      expect((error as PremanError).details.join("\n")).toContain("pe.aev2.ExchangeService.Exchange");
    }
  });

  it("givenNoSchemaLocationAndNoDescriptor_whenResolved_thenThrowsActionableError", () => {
    try {
      resolveMethod({ ...base, schemaLocation: undefined, methodPath: "test.echo.EchoService.Echo" });
      expect.unreachable("should have thrown");
    } catch (error) {
      const cliError = error as PremanError;
      expect(cliError.message).toContain("no usable schema");
      expect(cliError.details.join("\n")).toContain("no schema.location");
      expect(cliError.details.join("\n")).toContain("no methodDescriptor");
    }
  });

  it("givenUnknownService_whenResolved_thenListsAvailableMethods", () => {
    try {
      resolveMethod({
        ...base,
        schemaLocation: "../../../src/main/proto/echo/echo.proto",
        methodPath: "test.echo.NopeService.Echo",
      });
      expect.unreachable("should have thrown");
    } catch (error) {
      const cliError = error as PremanError;
      expect(cliError.message).toContain('service "test.echo.NopeService" not found');
      expect(cliError.details.join("\n")).toContain("test.echo.EchoService.Echo");
      expect(cliError.details.join("\n")).toContain("test.echo.EchoService.Ping");
    }
  });

  it("givenStreamingMethod_whenResolved_thenRejectedExplicitly", () => {
    expect(() =>
      resolveMethod({
        ...base,
        requestFilePath: join(FIXTURE_WS, "postman", "collections", "payment", "Streaming.request.yaml"),
        schemaLocation: "../../../src/main/proto/echo/streaming.proto",
        methodPath: "test.echo.StreamService.Chat",
      }),
    ).toThrow(/streaming method/);
  });

  it("givenGarbageDescriptor_whenResolved_thenThrows", () => {
    expect(() =>
      resolveMethod({ ...base, schemaLocation: undefined, methodDescriptor: "", methodPath: "a.B.C" }),
    ).toThrow(PremanError);
    expect(() =>
      resolveMethod({
        ...base,
        schemaLocation: undefined,
        methodDescriptor: "bm90LWEtZGVzY3JpcHRvcg==",
        methodPath: "a.B.C",
      }),
    ).toThrow(PremanError);
  });
});

describe("listMethods", () => {
  it("givenEmptyPackage_whenListing_thenReturnsNothing", () => {
    expect(listMethods({})).toEqual([]);
  });

  it("givenMessagesAlongsideServices_whenListing_thenOnlyServicesAreReported", () => {
    // proto-loader flattens messages and services into one map; only services hold MethodDefinitions.
    const pkg = {
      "test.echo.EchoRequest": { format: "Protocol Buffer 3 DescriptorProto", type: {} },
      "test.echo.EchoService": {
        Echo: { path: "/test.echo.EchoService/Echo" },
        Ping: { path: "/test.echo.EchoService/Ping" },
      },
    } as unknown as Parameters<typeof listMethods>[0];
    expect(listMethods(pkg)).toEqual(["test.echo.EchoService.Echo", "test.echo.EchoService.Ping"]);
  });
});

describe("parseAuthority", () => {
  it.each([
    ["localhost:9090", { authority: "localhost:9090", host: "localhost", port: "9090", scheme: undefined }],
    ["grpc://localhost:9090", { authority: "localhost:9090", host: "localhost", port: "9090", scheme: "grpc" }],
    [
      "https://aev2.zalopay.vn:443/some/path?q=1",
      { authority: "aev2.zalopay.vn:443", host: "aev2.zalopay.vn", port: "443", scheme: "https" },
    ],
    ["[::1]:9090", { authority: "[::1]:9090", host: "[::1]", port: "9090", scheme: undefined }],
    ["localhost", { authority: "localhost", host: "localhost", port: undefined, scheme: undefined }],
    ["  localhost:9095  ", { authority: "localhost:9095", host: "localhost", port: "9095", scheme: undefined }],
  ])("givenAuthority_whenParsed_thenSplitsCorrectly: %s", (raw, expected) => {
    expect(parseAuthority(raw)).toEqual(expected);
  });
});

describe("shouldUseTls", () => {
  it.each([
    [{ host: "localhost", port: "9090", scheme: undefined }, false],
    [{ host: "localhost", port: "443", scheme: undefined }, true],
    [{ host: "aev2.zalopay.vn", port: "9090", scheme: undefined }, true],
    [{ host: "AEV2.ZALOPAY.VN", port: "9090", scheme: undefined }, true],
    [{ host: "notzalopay.vn", port: "9090", scheme: undefined }, false],
    [{ host: "localhost", port: "9090", scheme: "grpcs" }, true],
    [{ host: "localhost", port: "9090", scheme: "https" }, true],
    [{ host: "localhost", port: "9090", scheme: "grpc" }, false],
  ])("givenTarget_whenDecidingTls_thenMatchesHeuristic: %j", (parsed, expected) => {
    expect(shouldUseTls(parsed)).toBe(expected);
  });
});

describe("resolveTarget", () => {
  it("givenOverride_whenResolved_thenOverrideWinsOverRequestUrl", () => {
    expect(resolveTarget({ url: "localhost:1111", workspaceRoot: FIXTURE_WS, override: "example.com:443" })).toEqual({
      authority: "example.com:443",
      tls: true,
      source: "--url",
    });
  });

  it("givenRequestUrl_whenResolved_thenUsesIt", () => {
    expect(resolveTarget({ url: "localhost:9095", workspaceRoot: FIXTURE_WS })).toEqual({
      authority: "localhost:9095",
      tls: false,
      source: "request url",
    });
  });

  it("givenEmptyUrl_whenResolved_thenFallsBackToLocalConfigGrpcPort", () => {
    expect(readLocalGrpcPort(FIXTURE_WS)).toBe(19099);
    expect(resolveTarget({ url: "   ", workspaceRoot: FIXTURE_WS })).toEqual({
      authority: "localhost:19099",
      tls: false,
      source: "config/application-local.yml grpc.port",
    });
  });

  it("givenNoConfig_whenResolved_thenUsesDefaultPort", () => {
    expect(readLocalGrpcPort(join(FIXTURE_WS, "nope"))).toBeUndefined();
    expect(resolveTarget({ url: "", workspaceRoot: join(FIXTURE_WS, "nope") })).toEqual({
      authority: "localhost:9090",
      tls: false,
      source: "default port",
    });
  });

  it("givenTlsOverride_whenResolved_thenHeuristicIsIgnoredBothWays", () => {
    expect(resolveTarget({ url: "localhost:9090", workspaceRoot: FIXTURE_WS, tlsOverride: true }).tls).toBe(true);
    expect(resolveTarget({ url: "aev2.zalopay.vn:443", workspaceRoot: FIXTURE_WS, tlsOverride: false }).tls).toBe(
      false,
    );
  });

  it("givenUrlWithoutPort_whenResolved_thenThrowsWithHint", () => {
    try {
      resolveTarget({ url: "localhost", workspaceRoot: FIXTURE_WS });
      expect.unreachable("should have thrown");
    } catch (error) {
      const cliError = error as PremanError;
      expect(cliError.message).toContain("has no port");
      expect(cliError.details.join("\n")).toContain("--url");
    }
  });
});
