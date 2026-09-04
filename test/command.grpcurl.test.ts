import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { copySelection, type CommandPlan } from "@preman/core";
import { DESCRIPTOR_REASON, DESCRIPTOR_WARNING, LOCAL_PATHS_WARNING } from "@preman/core/command/grpcurl.js";
import { splitWords } from "@preman/core/import/shell.js";
import { quoteWords } from "@preman/core/command/shell.js";
import { FIXTURE_WS, cloneFixtureWorkspace, collectionPath, sslPath } from "./helpers.js";

/**
 * What a resolved `grpc-request` looks like as a `grpcurl`. Every assertion is on `words`;
 * the quoting that turns them into `command` is `command.shell.test.ts`'s job.
 */

const GRPC_AUTHORITY = "127.0.0.1:50051";
const ECHO_PROTO = join(FIXTURE_WS, "src", "main", "proto", "echo", "echo.proto");
const PROTO_ROOT = join(FIXTURE_WS, "src", "main", "proto");
const NO_CERTS = {};
const BASE = {
  dir: FIXTURE_WS,
  env: null as string | null,
  url: undefined as string | undefined,
  tls: undefined as boolean | undefined,
  tlsCerts: NO_CERTS as Record<string, unknown>,
  certBaseDir: FIXTURE_WS,
  vars: { grpc_url: GRPC_AUTHORITY, trans_id: "t-1", greeting: "hello", mode: "SUCCEED" } as Record<string, string>,
  workingDir: undefined,
  insecureFileRead: false,
};

/** Every runnable request in `test/fixtures/ws/`; `Legacy Http` is a websocket and is skipped. */
const GRPC_SELECTORS = ["payment/Ping", "payment/Echo", "payment/Descriptor Only", "payment/nested/Deep Echo"];

function plan(selector: string, overrides: Partial<typeof BASE> = {}): Promise<CommandPlan> {
  return copySelection({ ...BASE, ...overrides, selector }).then((result) => result.plan);
}

/** The words that follow `flag`, in order — one `-import-path` does not tell you about the rest. */
function valuesOf(words: readonly string[], flag: string): string[] {
  return words.flatMap((word, index) => (word === flag ? [words[index + 1] ?? ""] : []));
}

function fieldsOf(planned: CommandPlan): string[] {
  return planned.unexpressed.map((entry) => entry.field);
}

describe("planCommand, grpcurl", () => {
  it("givenAPlaintextTarget_whenPlanned_thenTheCommandCarriesPlaintext", async () => {
    const planned = await plan("payment/Ping");

    expect(planned.format).toBe("grpcurl");
    expect(planned.kind).toBe("grpc-request");
    expect(planned.words[0]).toBe("grpcurl");
    expect(planned.words).toContain("-plaintext");
    expect(valuesOf(planned.words, "-d")).toEqual(['{"text":"ping"}']);
  });

  it("givenATlsTarget_whenPlanned_thenThereIsNoPlaintextFlag", async () => {
    const planned = await plan("payment/Ping", {
      tls: true,
      tlsCerts: { extraCaCerts: sslPath("ca.crt"), insecure: true },
    });

    expect(planned.words).not.toContain("-plaintext");
    expect(planned.words).toContain("-insecure");
    expect(valuesOf(planned.words, "-cacert")).toEqual([sslPath("ca.crt")]);
  });

  it("givenAProtoBackedMethod_whenPlanned_thenProtoAndImportPathsArePresent", async () => {
    const planned = await plan("payment/Ping");

    expect(valuesOf(planned.words, "-proto")).toEqual([ECHO_PROTO]);
    expect(valuesOf(planned.words, "-import-path")).toContain(PROTO_ROOT);
    // The paths only mean anything on the machine that resolved them (ADR 038).
    expect(planned.warnings).toContain(LOCAL_PATHS_WARNING);
  });

  it("givenADescriptorOnlyMethod_whenPlanned_thenTheSchemaIsUnexpressedAndItSaysItWillNotRun", async () => {
    const planned = await plan("payment/Descriptor Only");

    expect(planned.words).not.toContain("-proto");
    expect(planned.unexpressed).toContainEqual({ field: "schema", reason: DESCRIPTOR_REASON });
    expect(planned.warnings).toContain(DESCRIPTOR_WARNING);
    // Everything else still resolved, so the reader can see what would have been sent.
    expect(planned.words.slice(-2)).toEqual([GRPC_AUTHORITY, "pe.aev2.ExchangeService/Exchange"]);
  });

  it("givenADottedMethodPath_whenPlanned_thenThePositionalUsesASlash", async () => {
    const planned = await plan("payment/Echo");

    // `test.echo.EchoService.Echo` in the file; the wire form on the command line.
    expect(planned.words.at(-1)).toBe("test.echo.EchoService/Echo");
    expect(planned.words.at(-2)).toBe(GRPC_AUTHORITY);
  });

  it("givenMetadata_whenPlanned_thenKeysAreLowercased", async () => {
    const ws = cloneFixtureWorkspace();
    try {
      writeFileSync(
        `${collectionPath(ws.root, "payment", "Ping")}.request.yaml`,
        [
          "$kind: grpc-request",
          'url: "{{grpc_url}}"',
          "name: Ping",
          "methodPath: test.echo.EchoService.Ping",
          "message:",
          '  content: "{}"',
          "metadata:",
          "  - key: X-Trace",
          "    value: on",
          "  - key: X-Disabled",
          "    value: never sent",
          "    disabled: true",
          "schema:",
          "  source: file",
          "  location: ../../../src/main/proto/echo/echo.proto",
          "order: 10",
          "",
        ].join("\n"),
      );

      const planned = await plan("payment/Ping", { dir: ws.root, certBaseDir: ws.root });

      // Lowercased as they go on the wire, and the disabled entry never gets there.
      expect(valuesOf(planned.words, "-H")).toEqual(["x-trace: on"]);
    } finally {
      ws.cleanup();
    }
  });

  it("givenAnAuthBlock_whenPlanned_thenTheCredentialIsMetadataAndIsRevealed", async () => {
    const ws = cloneFixtureWorkspace();
    try {
      writeFileSync(
        `${collectionPath(ws.root, "payment", "Ping")}.request.yaml`,
        [
          "$kind: grpc-request",
          'url: "{{grpc_url}}"',
          "name: Ping",
          "methodPath: test.echo.EchoService.Ping",
          "message:",
          '  content: "{}"',
          "auth:",
          "  type: bearer",
          "  credentials:",
          '    token: "{{token}}"',
          "schema:",
          "  source: file",
          "  location: ../../../src/main/proto/echo/echo.proto",
          "order: 10",
          "",
        ].join("\n"),
      );

      const planned = await plan("payment/Ping", {
        dir: ws.root,
        certBaseDir: ws.root,
        vars: { grpc_url: GRPC_AUTHORITY, token: "jwt-123" },
      });

      expect(valuesOf(planned.words, "-H")).toContain("authorization: Bearer jwt-123");
      expect(planned.revealed).toContainEqual({ name: "auth", scope: "auth", origin: "request" });
      // The credential is in the words, so the pane has something to warn about.
      expect(planned.command).toContain("jwt-123");
    } finally {
      ws.cleanup();
    }
  });

  it("givenEveryFixtureGrpcRequest_whenPlannedThenSplit_thenTheArgvRoundTrips", async () => {
    for (const selector of GRPC_SELECTORS) {
      const planned = await plan(selector);

      expect(planned.command).toBe(quoteWords(planned.words));
      expect(splitWords(planned.command)).toEqual([...planned.words]);
      // A plan is only ever describing; nothing above may claim a run happened.
      expect(fieldsOf(planned)).toContain("pm.test assertions");
    }
  });
});
