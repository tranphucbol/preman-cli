import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { EXIT, PremanError, planImport } from "@preman/core";
import { FIXTURES_DIR, FIXTURE_PROTO, FIXTURE_WS } from "./helpers.js";

/**
 * The three schema cases are the whole point of this file: a `-proto` that is here, a `-proto`
 * that is not, and no `-proto` at all. The first composes `planSpecs`, so it is the one case
 * where planning reads the filesystem, and the fixture's `{{PROTO}}` is substituted here rather
 * than committed as a path that would only exist on one machine.
 */

const GRPCURL_DIR = join(FIXTURES_DIR, "curl");
const PROTO_TOKEN = "{{PROTO}}";
const METHOD = "test.echo.EchoService.Echo";

function fixture(name: string): string {
  return readFileSync(join(GRPCURL_DIR, `${name}.txt`), "utf8").replaceAll(PROTO_TOKEN, FIXTURE_PROTO);
}

function plan(text: string) {
  return planImport({ root: FIXTURE_WS, text });
}

function document(text: string): Record<string, unknown> {
  return parse(plan(text).contents) as Record<string, unknown>;
}

describe("planImport, grpcurl", () => {
  it("givenProtoFlagWithAnExistingFile_whenPlanned_thenTheSpecPlanDeclaresIt", () => {
    const planned = plan(fixture("grpcurl-proto"));

    expect(planned.format).toBe("grpcurl");
    expect(planned.kind).toBe("grpc-request");
    expect(planned.name).toBe("Echo");
    expect(planned.specs).not.toBeNull();

    const entry = planned.specs?.entries[0];
    expect(entry?.source).toBe(FIXTURE_PROTO);
    expect(entry?.loadError).toBeUndefined();

    const shown = parse(planned.contents) as Record<string, unknown>;
    expect(shown).toEqual({
      $kind: "grpc-request",
      name: "Echo",
      url: "localhost:9090",
      methodPath: METHOD,
      schema: { source: "file", location: entry?.declared },
      message: { content: '{"text":"hello","amount":100,"trans_id":"t-1","mode":"SUCCEED"}' },
      metadata: [
        { key: "x-request-id", value: "8f2c1a" },
        { key: "authorization", value: "Bearer sk-not-a-real-token" },
      ],
    });
    // The whole point of composing `planSpecs`: nothing is left for the reader to repair.
    expect(planned.warnings).toEqual([]);
    expect(planned.dropped.map((flag) => flag.flag)).toEqual(["-plaintext", "-max-time"]);
  });

  it("givenProtoFlagWithAMissingFile_whenPlanned_thenItWarnsAndStillImports", () => {
    const planned = plan("grpcurl -plaintext -proto /nowhere/echo.proto localhost:9090 test.echo.EchoService/Echo");

    expect(planned.specs).toBeNull();
    expect((planned.request as { schema?: { location?: string } }).schema?.location).toBe("/nowhere/echo.proto");
    expect(planned.warnings.join("\n")).toMatch(/not on this machine/);
    expect(planned.warnings.join("\n")).toMatch(/preman protos link/);
  });

  it("givenNoProtoFlag_whenPlanned_thenItNamesTheFailureItWillProduce", () => {
    const planned = plan(fixture("grpcurl-reflection"));

    expect(planned.specs).toBeNull();
    expect(document(fixture("grpcurl-reflection"))).toEqual({
      $kind: "grpc-request",
      name: "Ping",
      url: "echo.example.test:443",
      methodPath: "test.echo.EchoService.Ping",
      message: { content: '{"text":"ping"}' },
      metadata: [{ key: "x-tenant", value: "acme" }],
    });
    expect(planned.warnings[0]).toBe(
      'no .proto was named, so sending this will fail with "no declared spec defines test.echo.EchoService.Ping"',
    );
    expect(planned.dropped.map((flag) => flag.flag)).toEqual(["-plaintext", "-emit-defaults"]);
  });

  it("givenASlashSeparatedMethod_whenPlanned_thenMethodPathUsesDots", () => {
    const planned = plan("grpcurl -plaintext localhost:9090 test.echo.EchoService/Ping");

    expect(planned.request).toMatchObject({ methodPath: "test.echo.EchoService.Ping" });
    expect(planned.name).toBe("Ping");
  });

  it("givenDataFromStdin_whenPlanned_thenItIsRefused", () => {
    let thrown: unknown;
    try {
      plan("grpcurl -plaintext -d @ localhost:9090 test.echo.EchoService/Echo");
    } catch (cause) {
      thrown = cause;
    }

    expect(thrown).toBeInstanceOf(PremanError);
    expect((thrown as PremanError).exitCode).toBe(EXIT.CLI);
    expect((thrown as PremanError).message).toMatch(/stdin/);
  });

  it("givenAListSubcommand_whenPlanned_thenItIsRefused", () => {
    expect(() => plan("grpcurl -plaintext localhost:9090 list")).toThrow(/not a request/);
    expect(() => plan("grpcurl -plaintext localhost:9090 describe test.echo.EchoService")).toThrow(/not a request/);
  });

  it("givenACertificateFlag_whenPlanned_thenItsValueIsNotReadAsTheMethod", () => {
    const planned = plan(
      "grpcurl -cacert /tmp/ca.pem -authority echo.internal echo.example.test:443 test.echo.EchoService/Echo",
    );

    expect(planned.request).toMatchObject({ url: "echo.example.test:443", methodPath: METHOD });
    expect(planned.dropped.map((flag) => flag.flag)).toEqual(["-cacert", "-authority"]);
  });

  it("givenAnUnknownFlag_whenPlanned_thenItWarnsAndStillImports", () => {
    const planned = plan("grpcurl -plaintext -future-flag localhost:9090 test.echo.EchoService/Echo");

    expect(planned.request).toMatchObject({ methodPath: METHOD });
    expect(planned.warnings.join("\n")).toMatch(/-future-flag is not a flag preman knows/);
  });

  it("givenNoMethod_whenPlanned_thenItIsRefused", () => {
    expect(() => plan("grpcurl -plaintext localhost:9090")).toThrow(/no address and method/);
  });
});
