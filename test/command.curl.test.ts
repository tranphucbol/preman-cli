import { realpathSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { copySelection, type CommandPlan } from "@preman/core";
import { MULTIPART_BOUNDARY_WARNING } from "@preman/core/command/curl.js";
import {
  CLIENT_KEY_PASSPHRASE,
  FIXTURE_HTTP_WS,
  cloneFixtureHttpWorkspace,
  collectionPath,
  definitionPath,
  sslPath,
} from "./helpers.js";

/**
 * What a resolved `http-request` looks like as a `curl`. The quoting is
 * `command.shell.test.ts`'s job; every assertion here is on `words`.
 */

const HTTP_ORIGIN = "http://127.0.0.1:65500";
const NO_CERTS = {};
const BASE = {
  dir: FIXTURE_HTTP_WS,
  env: null as string | null,
  url: undefined,
  tls: undefined,
  tlsCerts: NO_CERTS,
  certBaseDir: FIXTURE_HTTP_WS,
  vars: { http_url: HTTP_ORIGIN, token: "jwt-123" } as Record<string, string>,
  workingDir: undefined,
  insecureFileRead: false,
};

function plan(selector: string, overrides: Partial<typeof BASE> & { draft?: unknown } = {}): Promise<CommandPlan> {
  return copySelection({ ...BASE, ...overrides, selector }).then((result) => result.plan);
}

/** The words that follow `flag`, in order — one `-H` does not tell you about the others. */
function valuesOf(words: readonly string[], flag: string): string[] {
  return words.flatMap((word, index) => (word === flag ? [words[index + 1] ?? ""] : []));
}

function fieldsOf(planned: CommandPlan): string[] {
  return planned.unexpressed.map((entry) => entry.field);
}

describe("planCommand, curl", () => {
  it("givenAGetRequest_whenPlanned_thenTheCommandIsCurlWithTheUrlLast", async () => {
    const planned = await plan("admin/Squeezed");

    expect(planned.format).toBe("curl");
    expect(planned.kind).toBe("http-request");
    expect(planned.words[0]).toBe("curl");
    // No -X: the method is GET (decision 29 only adds it for the others).
    expect(planned.words).not.toContain("-X");
    expect(planned.words).toContain("-L");
    expect(planned.words.at(-1)).toBe(`${HTTP_ORIGIN}/gzip`);
  });

  it("givenAPostWithARawBody_whenPlanned_thenTheBytesAreDataRawVerbatim", async () => {
    const planned = await plan("admin/Login");

    expect(planned.words).toContain("-X");
    expect(valuesOf(planned.words, "-X")).toEqual(["POST"]);
    expect(valuesOf(planned.words, "--data-raw")).toEqual(['{\n  "user_name": "admin",\n  "password": "1"\n}']);
    expect(valuesOf(planned.words, "-H")).toContain("content-type: application/json");
  });

  it("givenAUrlencodedBody_whenPlanned_thenItIsDataRawAndNotDataUrlencode", async () => {
    const planned = await plan("admin/Signed Form");

    expect(planned.words).not.toContain("--data-urlencode");
    expect(valuesOf(planned.words, "--data-raw")).toEqual(["clientid=11&note=a%2Bb%2Fc%3D&sig="]);
    expect(valuesOf(planned.words, "-H")).toContain("content-type: application/x-www-form-urlencoded");
  });

  it("givenAMultipartBody_whenPlanned_thenEachEntryIsAFormFlagAndTheBoundaryIsWarnedAbout", async () => {
    const ws = cloneFixtureHttpWorkspace();
    try {
      writeFileSync(
        `${collectionPath(ws.root, "admin", "Squeezed")}.request.yaml`,
        [
          "$kind: http-request",
          "name: Squeezed",
          'url: "{{http_url}}/echo"',
          "method: POST",
          "body:",
          "  type: formdata",
          "  formdata:",
          "    - key: note",
          "      value: '{{token}}'",
          "    - key: receipt",
          "      type: file",
          "      src: upload/receipt.txt",
          "auth:",
          "  type: noauth",
          "order: 50",
          "",
        ].join("\n"),
      );

      const planned = await plan("admin/Squeezed", { dir: ws.root, certBaseDir: ws.root });

      // `realpathSync`: the fixture clone lives under a symlinked temp dir on macOS.
      expect(valuesOf(planned.words, "-F")).toEqual([
        "note=jwt-123",
        `receipt=@${realpathSync(`${ws.root}/upload/receipt.txt`)}`,
      ]);
      // curl picks its own boundary, so preman's generated header must not name one.
      expect(valuesOf(planned.words, "-H").join()).not.toContain("multipart/form-data");
      expect(planned.warnings).toContain(MULTIPART_BOUNDARY_WARNING);
    } finally {
      ws.cleanup();
    }
  });

  it("givenAnInheritedAuthHeader_whenPlanned_thenTheHeaderIsPresentAndRevealedNamesItsOrigin", async () => {
    const ws = cloneFixtureHttpWorkspace();
    try {
      writeFileSync(
        definitionPath(ws.root, "admin"),
        [
          "$kind: collection",
          "name: admin",
          "auth:",
          "  type: bearer",
          "  credentials:",
          '    token: "{{token}}"',
          "",
        ].join("\n"),
      );
      writeFileSync(
        `${collectionPath(ws.root, "admin", "Squeezed")}.request.yaml`,
        ["$kind: http-request", "name: Squeezed", 'url: "{{http_url}}/gzip"', "method: GET", "order: 50", ""].join(
          "\n",
        ),
      );

      const planned = await plan("admin/Squeezed", { dir: ws.root, certBaseDir: ws.root });

      expect(valuesOf(planned.words, "-H")).toContain("Authorization: Bearer jwt-123");
      expect(planned.revealed[0]).toEqual({ name: "auth", scope: "auth", origin: "collection admin" });
    } finally {
      ws.cleanup();
    }
  });

  it("givenATokenInTheUrl_whenPlanned_thenRevealedNamesTheVariableAndItsScope", async () => {
    // `token` exists in the QC environment file; `http_url` is only supplied as --var.
    const planned = await plan("admin/Profile", { env: "QC", vars: { http_url: HTTP_ORIGIN } });

    expect(planned.revealed).toContainEqual({ name: "http_url", scope: "local" });
    expect(planned.revealed).toContainEqual({ name: "token", scope: "environment" });
  });

  it("givenADynamicVariable_whenPlanned_thenItIsNotInRevealed", async () => {
    const ws = cloneFixtureHttpWorkspace();
    try {
      writeFileSync(
        `${collectionPath(ws.root, "admin", "Squeezed")}.request.yaml`,
        [
          "$kind: http-request",
          "name: Squeezed",
          'url: "{{http_url}}/gzip"',
          "method: GET",
          "headers:",
          '  x-request-id: "{{$guid}}"',
          "auth:",
          "  type: noauth",
          "order: 50",
          "",
        ].join("\n"),
      );

      const planned = await plan("admin/Squeezed", { dir: ws.root, certBaseDir: ws.root });

      expect(planned.revealed.map((entry) => entry.name)).not.toContain("$guid");
      expect(planned.revealed).toContainEqual({ name: "http_url", scope: "local" });
    } finally {
      ws.cleanup();
    }
  });

  it("givenARequestWithAPreRequestScript_whenPlanned_thenTheScriptIsUnexpressedAndNotRun", async () => {
    const result = await copySelection({ ...BASE, selector: "admin/Side Login" });

    // The script would log in and upsert an Authorization header; neither happened.
    expect(fieldsOf(result.plan)).toContain("prerequest");
    expect(fieldsOf(result.plan)).toContain("collection admin http:beforeRequest");
    expect(fieldsOf(result.plan)).toContain("pm.test assertions");
    expect(fieldsOf(result.plan)).toContain("variable writeback");
    expect(result.plan.unexpressed.find((entry) => entry.field === "prerequest")?.reason).toBe(
      "not run; a script that sets a header is not in this command",
    );
    // `{{token}}` came from --var, not from the login the script never made.
    expect(valuesOf(result.plan.words, "-H")).toContain("authorization: Bearer jwt-123");
  });

  it("givenSslClientCertOptions_whenPlanned_thenCertAndKeyAreFlagsAndThePassphraseIsUnexpressed", async () => {
    const planned = await plan("admin/Squeezed", {
      tlsCerts: {
        extraCaCerts: sslPath("ca.crt"),
        clientCert: sslPath("client.crt"),
        clientKey: sslPath("client-encrypted.key"),
        clientPassphrase: CLIENT_KEY_PASSPHRASE,
      },
    });

    expect(valuesOf(planned.words, "--cacert")).toEqual([sslPath("ca.crt")]);
    expect(valuesOf(planned.words, "--cert")).toEqual([sslPath("client.crt")]);
    expect(valuesOf(planned.words, "--key")).toEqual([sslPath("client-encrypted.key")]);
    // The passphrase itself is never rendered (decision 33).
    expect(planned.command).not.toContain(CLIENT_KEY_PASSPHRASE);
    expect(fieldsOf(planned)).toContain("client key passphrase");
  });

  it("givenAnInsecureRun_whenPlanned_thenTheCommandCarriesDashK", async () => {
    const planned = await plan("admin/Squeezed", { tlsCerts: { insecure: true } });

    expect(planned.words).toContain("-k");
  });

  it("givenADraft_whenPlanned_thenTheCommandIsTheDraftAndTheFileIsUntouched", async () => {
    // What an open editor has, which is not what is on disk: `Squeezed` is a GET to /gzip.
    const draft = {
      $kind: "http-request",
      name: "Squeezed",
      method: "DELETE",
      url: "{{http_url}}/profile",
    };

    const drafted = await plan("admin/Squeezed", { draft });
    const onDisk = await plan("admin/Squeezed");

    expect(valuesOf(drafted.words, "-X")).toEqual(["DELETE"]);
    expect(drafted.words.at(-1)).toBe(`${HTTP_ORIGIN}/profile`);
    // The same selector, asked again without a draft, still answers for the bytes on disk. A
    // draft is an argument to one call, never something the copy path remembers.
    expect(onDisk.words).not.toContain("-X");
    expect(onDisk.words.at(-1)).toBe(`${HTTP_ORIGIN}/gzip`);
  });

  it("givenADraftThatIsNotARequest_whenPlanned_thenTheShapeIsRefusedByItsPath", async () => {
    // The file is named, not the draft, because the draft *is* that file — one keystroke from
    // being it. A message about an anonymous document would leave the user with nothing to open.
    await expect(plan("admin/Squeezed", { draft: { $kind: "http-request", url: 42 } })).rejects.toThrow(
      /unexpected shape in .*Squeezed\.request\.yaml/,
    );
  });
});
