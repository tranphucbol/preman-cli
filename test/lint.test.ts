import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LINT_RULES, lintWorkspace, type LintFinding, type LintReport } from "@preman/core/api/lint.js";
import { renderLint } from "@preman/cli/render/lint.js";
import { main } from "@preman/cli/main.js";
import { EXIT } from "@preman/core/errors.js";
import { cloneFixtureHttpWorkspace, cloneFixtureWorkspace, collectionPath, type ClonedWorkspace } from "./helpers.js";

/**
 * Every rule here is a static twin of a branch in the runner (ADR 056). The fixtures are written
 * to be minimal *and* to name the branch they mirror, so that a rule going stale shows up as a
 * failing expectation rather than as a report that quietly stops saying anything.
 */

const REQUEST_NAME = "Linted";

/** A syntactically fine request with whatever body block the case under test needs. */
function writeRequest(root: string, body: string[], extra: string[] = []): void {
  const file = collectionPath(root, "admin", `${REQUEST_NAME}.request.yaml`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    [
      "$kind: http-request",
      `name: ${REQUEST_NAME}`,
      'url: "{{http_url}}/echo"',
      "method: POST",
      ...body,
      ...extra,
      "order: 9000",
      "",
    ].join("\n"),
  );
}

/** The findings for the request this suite writes, with the fixture's own baseline dropped. */
function findingsFor(root: string): LintFinding[] {
  const report = lintWorkspace(root);
  return report.requests.flatMap((request) => (request.path.endsWith(REQUEST_NAME) ? request.findings : []));
}

function rules(findings: readonly LintFinding[]): string[] {
  return findings.map((item) => item.rule);
}

describe("lintWorkspace", () => {
  let ws: ClonedWorkspace | undefined;

  afterEach(() => {
    ws?.cleanup();
    ws = undefined;
  });

  function httpWorkspace(): string {
    ws = cloneFixtureHttpWorkspace();
    return ws.root;
  }

  it("givenFormDataPartsUnderContent_whenLinted_thenErrorNamingTheRename", () => {
    // The Paparazzi bug: `body.content` parses, because the body block is passthrough, and is
    // then never read, because `buildBody` dispatches formdata straight to `body.formdata`.
    const root = httpWorkspace();
    writeRequest(root, ["body:", "  type: formdata", "  content:", "    - key: spec", '      value: "{}"']);

    const findings = findingsFor(root);

    expect(rules(findings)).toEqual([LINT_RULES.bodyPartsMissing]);
    expect(findings[0]?.severity).toBe("error");
    expect(findings[0]?.field).toBe("body.formdata");
    expect(findings[0]?.message).toContain("no body is sent");
    expect(findings[0]?.remedy).toBe("rename body.content to body.formdata");
  });

  it("givenFormDataWithNoPartsAtAll_whenLinted_thenErrorWithoutTheRenameRemedy", () => {
    const root = httpWorkspace();
    writeRequest(root, ["body:", "  type: formdata"]);

    const findings = findingsFor(root);

    expect(rules(findings)).toEqual([LINT_RULES.bodyPartsMissing]);
    expect(findings[0]?.remedy).toBe("add body.formdata with the parts to send");
  });

  it("givenFormDataWithBothFields_whenLinted_thenContentIsWarnedAsIgnored", () => {
    const root = httpWorkspace();
    writeRequest(root, [
      "body:",
      "  type: formdata",
      '  content: "ignored"',
      "  formdata:",
      "    - key: spec",
      '      value: "{}"',
    ]);

    const findings = findingsFor(root);

    expect(rules(findings)).toEqual([LINT_RULES.bodyContentIgnored]);
    expect(findings[0]?.severity).toBe("warning");
  });

  it("givenEveryFormDataPartDisabled_whenLinted_thenWarnsThatNoBodyIsSent", () => {
    // `multipartBody` filters disabled parts first and returns an empty body, silently.
    const root = httpWorkspace();
    writeRequest(root, [
      "body:",
      "  type: formdata",
      "  formdata:",
      "    - key: spec",
      '      value: "{}"',
      "      disabled: true",
    ]);

    expect(rules(findingsFor(root))).toEqual([LINT_RULES.bodyPartsDisabled]);
  });

  it("givenFormDataFilePartWithNoSrc_whenLinted_thenErrorBecauseTheRunnerThrows", () => {
    const root = httpWorkspace();
    writeRequest(root, ["body:", "  type: formdata", "  formdata:", "    - key: bundle", "      type: file"]);

    const findings = findingsFor(root);

    expect(rules(findings)).toEqual([LINT_RULES.bodyFileMissing]);
    expect(findings[0]?.severity).toBe("error");
  });

  it("givenDisabledFormDataFilePart_whenLinted_thenSilentBecauseTheRunnerSkipsIt", () => {
    // A part the author has commented out is not a mistake: `multipartBody` filters before it
    // validates, so linting it would report a failure that cannot happen.
    const root = httpWorkspace();
    writeRequest(root, [
      "body:",
      "  type: formdata",
      "  formdata:",
      "    - key: spec",
      '      value: "{}"',
      "    - key: bundle",
      "      type: file",
      '      src: "{{bundle_path}}"',
      "      disabled: true",
    ]);

    expect(findingsFor(root)).toEqual([]);
  });

  it("givenFormDataFilePartNamingAMissingFile_whenLinted_thenErrorNamingThePath", () => {
    const root = httpWorkspace();
    writeRequest(root, [
      "body:",
      "  type: formdata",
      "  formdata:",
      "    - key: bundle",
      "      type: file",
      "      src: upload/nowhere.txt",
    ]);

    const findings = findingsFor(root);

    expect(rules(findings)).toEqual([LINT_RULES.bodyFileAbsent]);
    expect(findings[0]?.message).toContain("upload/nowhere.txt");
  });

  it("givenTemplatedFilePart_whenLinted_thenSilentBecauseAVariableDecidesThePath", () => {
    const root = httpWorkspace();
    writeRequest(root, [
      "body:",
      "  type: formdata",
      "  formdata:",
      "    - key: bundle",
      "      type: file",
      '      src: "{{bundle_path}}"',
    ]);

    expect(findingsFor(root)).toEqual([]);
  });

  it("givenPartsUnderAFieldAnotherModeOwns_whenLinted_thenWarnsWhichModeReadsIt", () => {
    const root = httpWorkspace();
    writeRequest(root, [
      "body:",
      "  type: raw",
      '  content: "{}"',
      "  formdata:",
      "    - key: spec",
      '      value: "x"',
    ]);

    const findings = findingsFor(root);

    expect(rules(findings)).toEqual([LINT_RULES.bodyPartsIgnored]);
    expect(findings[0]?.field).toBe("body.formdata");
    expect(findings[0]?.remedy).toBe("set body.type: formdata, or delete body.formdata");
  });

  it("givenUrlencodedWithFieldsUnderContent_whenLinted_thenSilentBecauseThatIsALegalHome", () => {
    // Unlike formdata, `readRequestBody` accepts a map under `body.content` for urlencoded.
    const root = httpWorkspace();
    writeRequest(root, ["body:", "  type: urlencoded", "  content:", "    - key: grant_type", "      value: password"]);

    expect(findingsFor(root)).toEqual([]);
  });

  it("givenUrlencodedWithBothFields_whenLinted_thenWarnsExactlyAsTheRunnerDoes", () => {
    const root = httpWorkspace();
    writeRequest(root, [
      "body:",
      "  type: urlencoded",
      '  content: "ignored"',
      "  urlencoded:",
      "    - key: grant_type",
      "      value: password",
    ]);

    const findings = findingsFor(root);

    expect(rules(findings)).toEqual([LINT_RULES.bodyContentIgnored]);
    expect(findings[0]?.message).toBe("body.content is ignored because body.urlencoded is present");
  });

  it("givenUrlencodedWithNoFields_whenLinted_thenError", () => {
    const root = httpWorkspace();
    writeRequest(root, ["body:", "  type: urlencoded"]);

    expect(rules(findingsFor(root))).toEqual([LINT_RULES.bodyPartsMissing]);
  });

  it("givenFileBodyWithNoSrc_whenLinted_thenError", () => {
    const root = httpWorkspace();
    writeRequest(root, ["body:", "  type: file", "  file:", '    src: ""']);

    const findings = findingsFor(root);

    expect(rules(findings)).toEqual([LINT_RULES.bodyFileMissing]);
    expect(findings[0]?.field).toBe("body.file.src");
  });

  it("givenGraphqlBodyWithNoQueryBlock_whenLinted_thenError", () => {
    const root = httpWorkspace();
    writeRequest(root, ["body:", "  type: graphql", '  content: "{ me { id } }"']);

    const findings = findingsFor(root);

    expect(rules(findings)).toEqual([LINT_RULES.bodyPartsMissing]);
    expect(findings[0]?.field).toBe("body.graphql");
  });

  it("givenUnknownBodyType_whenLinted_thenWarnsAboutTheMissingContentType", () => {
    const root = httpWorkspace();
    writeRequest(root, ["body:", "  type: protobuf", '  content: "AAAA"']);

    const findings = findingsFor(root);

    expect(rules(findings)).toEqual([LINT_RULES.bodyTypeUnknown]);
    expect(findings[0]?.severity).toBe("warning");
  });

  it("givenKnownContentTypeAlias_whenLinted_thenSilent", () => {
    // `json` is a key of BODY_CONTENT_TYPES, so the runner generates a Content-Type for it.
    const root = httpWorkspace();
    writeRequest(root, ["body:", "  type: json", '  content: "{}"']);

    expect(findingsFor(root)).toEqual([]);
  });

  it("givenAMapUnderRawContent_whenLinted_thenErrorBecauseTheRunnerRefusesToSerialiseIt", () => {
    const root = httpWorkspace();
    writeRequest(root, ["body:", "  type: raw", "  content:", "    - key: a", "      value: b"]);

    const findings = findingsFor(root);

    expect(rules(findings)).toEqual([LINT_RULES.bodyContentNotText]);
    expect(findings[0]?.severity).toBe("error");
  });

  it("givenUnsupportedAuthType_whenLinted_thenError", () => {
    const root = httpWorkspace();
    writeRequest(root, ["body:", "  type: none"], ["auth:", "  type: hawk", "  credentials:", "    id: x"]);

    const findings = findingsFor(root);

    expect(rules(findings)).toEqual([LINT_RULES.authTypeUnknown]);
    expect(findings[0]?.remedy).toContain("bearer");
  });

  it("givenApiKeyAuthOverAnAuthoredHeader_whenLinted_thenWarnsWhichHeaderLoses", () => {
    // ADR 050: the auth block wins, so the authored header is written for nothing.
    const root = httpWorkspace();
    writeRequest(
      root,
      ["body:", "  type: none"],
      [
        "headers:",
        "  X-Api-Key: authored",
        "auth:",
        "  type: apikey",
        "  credentials:",
        "    key: X-Api-Key",
        "    value: real",
      ],
    );

    const findings = findingsFor(root);

    expect(rules(findings)).toEqual([LINT_RULES.authHeaderReplaced]);
    expect(findings[0]?.field).toBe("headers.x-api-key");
  });

  it("givenApiKeyAuthInQuery_whenLinted_thenSilentBecauseNoHeaderIsTaken", () => {
    const root = httpWorkspace();
    writeRequest(
      root,
      ["body:", "  type: none"],
      [
        "headers:",
        "  X-Api-Key: authored",
        "auth:",
        "  type: apikey",
        "  credentials:",
        "    key: X-Api-Key",
        "    value: real",
        "    in: query",
      ],
    );

    expect(findingsFor(root)).toEqual([]);
  });

  it("givenBearerAuthWithAnEmptyToken_whenLinted_thenSilentBecauseNoHeaderIsTaken", () => {
    const root = httpWorkspace();
    writeRequest(
      root,
      ["body:", "  type: none"],
      ["headers:", "  Authorization: authored", "auth:", "  type: bearer", "  credentials:", '    token: ""'],
    );

    expect(findingsFor(root)).toEqual([]);
  });

  it("givenAMalformedRequestFile_whenLinted_thenReportedRatherThanThrown", () => {
    // One bad file must not hide the rest of the tree; that is the whole point of a tree walk.
    const root = httpWorkspace();
    writeFileSync(
      collectionPath(root, "admin", `${REQUEST_NAME}.request.yaml`),
      "$kind: http-request\nname: Linted\nmethod: POST\n",
    );

    const findings = findingsFor(root);

    expect(rules(findings)).toEqual([LINT_RULES.shape]);
    expect(findings[0]?.severity).toBe("error");
    expect(findings[0]?.remedy).toContain("url");
  });

  it("givenAKindPremanCannotRun_whenLinted_thenWarningNotError", () => {
    // `payment/Legacy Http` is a websocket request on purpose. A user not trying to run it
    // should not have it fail their workspace.
    ws = cloneFixtureWorkspace();
    const report = lintWorkspace(ws.root);
    const legacy = report.requests.find((request) => request.path.endsWith("Legacy Http"));

    expect(legacy?.findings.map((item) => item.rule)).toEqual([LINT_RULES.kindUnsupported]);
    expect(legacy?.findings[0]?.severity).toBe("warning");
  });

  it("givenAMissingProtoWithAnEmbeddedDescriptor_whenLinted_thenWarningBecauseTheRunnerFallsBack", () => {
    // grpc/schema.ts only throws when there is no descriptor to fall back to.
    ws = cloneFixtureWorkspace();
    const report = lintWorkspace(ws.root);
    const descriptorOnly = report.requests.find((request) => request.path.endsWith("Descriptor Only"));

    expect(descriptorOnly?.findings.map((item) => item.rule)).toEqual([LINT_RULES.grpcSchemaDescriptorOnly]);
    expect(descriptorOnly?.findings[0]?.severity).toBe("warning");
  });

  it("givenAMissingProtoWithNoDescriptor_whenLinted_thenError", () => {
    ws = cloneFixtureWorkspace();
    const file = collectionPath(ws.root, "payment", "Ping.request.yaml");
    writeFileSync(
      file,
      [
        "$kind: grpc-request",
        "name: Ping",
        'url: "{{grpc_url}}"',
        "methodPath: /zas.Payment/Ping",
        "schema:",
        "  location: ./gone.proto",
        "order: 10",
        "",
      ].join("\n"),
    );

    const report = lintWorkspace(ws.root);
    const ping = report.requests.find((request) => request.path.endsWith("Ping"));

    expect(ping?.findings.map((item) => item.rule)).toEqual([LINT_RULES.grpcSchemaAbsent]);
    expect(ping?.findings[0]?.severity).toBe("error");
  });

  it("givenADeclaredProtoThatIsGone_whenLinted_thenAWorkspaceLevelError", () => {
    ws = cloneFixtureWorkspace();
    rmSync(join(ws.root, "src/main/proto"), { recursive: true, force: true });

    const report = lintWorkspace(ws.root);

    expect(report.workspace.map((item) => item.rule)).toContain(LINT_RULES.specAbsent);
    expect(report.errors).toBeGreaterThan(0);
  });

  it("givenTheHttpFixture_whenLinted_thenOnlyItsOneDeliberateOverride", () => {
    // A guard on the rules themselves: a fixture the suite runs against every day must not
    // start producing findings, or the report stops being worth reading.
    ws = cloneFixtureHttpWorkspace();
    const report = lintWorkspace(ws.root);

    expect(report.checked).toBe(9);
    expect(report.errors).toBe(0);
    expect(report.requests.map((request) => request.path)).toEqual(["admin/Profile"]);
  });
});

describe("renderLint", () => {
  function report(overrides: Partial<LintReport> = {}): LintReport {
    return { root: "/ws", workspace: [], requests: [], checked: 3, errors: 0, warnings: 0, ...overrides };
  }

  it("givenNoFindings_whenRendered_thenSaysCleanAndTheDenominator", () => {
    expect(renderLint(report(), { json: false, verbose: false })).toContain("clean");
    expect(renderLint(report(), { json: false, verbose: false })).toContain("3 requests checked");
  });

  it("givenFindings_whenRendered_thenEachCarriesItsRemedy", () => {
    const text = renderLint(
      report({
        requests: [
          {
            path: "admin/Linted",
            file: "postman/collections/admin/Linted.request.yaml",
            findings: [
              {
                rule: LINT_RULES.bodyPartsMissing,
                severity: "error",
                field: "body.formdata",
                message: "no body is sent",
                remedy: "rename body.content to body.formdata",
              },
            ],
          },
        ],
        errors: 1,
      }),
      { json: false, verbose: false },
    );

    expect(text).toContain("admin/Linted");
    expect(text).toContain("no body is sent");
    expect(text).toContain("rename body.content to body.formdata");
    expect(text).toContain("1 error");
  });

  it("givenVerbose_whenRendered_thenTheRuleIdIsGreppable", () => {
    const one = report({
      requests: [
        {
          path: "admin/Linted",
          file: "admin/Linted.request.yaml",
          findings: [
            {
              rule: LINT_RULES.bodyTypeUnknown,
              severity: "warning",
              field: "body.type",
              message: "unknown",
              remedy: "fix it",
            },
          ],
        },
      ],
      warnings: 1,
    });

    expect(renderLint(one, { json: false, verbose: true })).toContain(LINT_RULES.bodyTypeUnknown);
    expect(renderLint(one, { json: false, verbose: false })).not.toContain(`[${LINT_RULES.bodyTypeUnknown}]`);
  });

  it("givenJson_whenRendered_thenTheReportRoundTrips", () => {
    const parsed = JSON.parse(renderLint(report({ warnings: 2 }), { json: true, verbose: false })) as LintReport;

    expect(parsed.checked).toBe(3);
    expect(parsed.warnings).toBe(2);
  });
});

describe("preman lint", () => {
  let ws: ClonedWorkspace | undefined;

  afterEach(() => {
    ws?.cleanup();
    ws = undefined;
  });

  it("givenOnlyWarnings_whenRun_thenExitsZero", async () => {
    ws = cloneFixtureHttpWorkspace();

    await expect(main(["lint", "--dir", ws.root, "--json"])).resolves.toBe(EXIT.OK);
  });

  it("givenOnlyWarningsAndStrict_whenRun_thenExitsOne", async () => {
    // The fixture's one deliberate auth override is enough to fail a strict gate.
    ws = cloneFixtureHttpWorkspace();

    await expect(main(["lint", "--dir", ws.root, "--strict", "--json"])).resolves.toBe(EXIT.CLI);
  });

  it("givenAnError_whenRun_thenExitsOneWithoutStrict", async () => {
    ws = cloneFixtureHttpWorkspace();
    writeRequest(ws.root, ["body:", "  type: formdata", "  content:", "    - key: spec", '      value: "{}"']);

    await expect(main(["lint", "--dir", ws.root, "--json"])).resolves.toBe(EXIT.CLI);
  });
});
