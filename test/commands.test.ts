import { rmSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderEnvironment, renderEnvironmentSet } from "@preman/cli/render/env.js";
import { renderList } from "@preman/cli/render/list.js";
import { readEnvironment, writeEnvironmentValue } from "@preman/core/api/environments.js";
import { describeWorkspace } from "@preman/core/api/inspect.js";
import { PremanError } from "@preman/core/errors.js";
import { loadEnvironment } from "@preman/core/workspace/environments.js";
import { cloneFixtureWorkspace, FIXTURE_WS } from "./helpers.js";

/**
 * Golden-output characterization of `list` and `env`: the engine answers the query,
 * the CLI paints it. Colour is off under vitest, so these are plain strings.
 */

function listOutput(dir: string, options: { json: boolean; verbose: boolean }): string {
  return renderList(describeWorkspace(dir), options);
}

function envOutput(dir: string, env: string | undefined, json: boolean): string {
  return renderEnvironment(readEnvironment(dir, env), { json });
}

function envSetOutput(dir: string, env: string, key: string, value: string, json: boolean): string {
  return renderEnvironmentSet(writeEnvironmentValue(dir, env, key, value), { json });
}

describe("list output", () => {
  it("givenWorkspace_whenListed_thenRequestsGroupedByCollection", () => {
    const text = listOutput(FIXTURE_WS, { json: false, verbose: false });

    expect(text.split("\n")).toEqual([
      `workspace ${FIXTURE_WS}`,
      "",
      "requests",
      "  payment",
      "    Ping  grpc",
      "    Echo  grpc",
      "    Legacy Http  websocket-request",
      "    Descriptor Only  grpc",
      "  payment/nested",
      "    Deep Echo  grpc",
      "",
      "environments",
      "  LOCAL  5 vars",
    ]);
  });

  it("givenWorkspace_whenListedAsJson_thenShapeIsStable", () => {
    const report = JSON.parse(listOutput(FIXTURE_WS, { json: true, verbose: false })) as {
      root: string;
      workspaceId: string | null;
      requests: Array<Record<string, string>>;
      environments: Array<{ name: string; file: string; keys: string[] }>;
      specs: string[];
    };

    expect(Object.keys(report)).toEqual(["root", "workspaceId", "requests", "environments", "specs"]);
    expect(report.root).toBe(FIXTURE_WS);
    expect(report.workspaceId).toBe("11111111-2222-3333-4444-555555555555");
    expect(Object.keys(report.requests[0] ?? {})).toEqual(["path", "name", "kind", "file"]);
    expect(report.requests.map((request) => request.path)).toEqual([
      "payment/Ping",
      "payment/Echo",
      "payment/Legacy Http",
      "payment/Descriptor Only",
      "payment/nested/Deep Echo",
    ]);
    expect(report.environments).toHaveLength(1);
    expect(report.environments[0]?.name).toBe("LOCAL");
    expect(report.environments[0]?.keys).toEqual(["grpc_url", "trans_id", "greeting", "mode", "nested_token"]);
    expect(report.specs).toHaveLength(2);
    // Decision: the JSON shape omits includeDirs even though verbose text prints them.
    expect(report).not.toHaveProperty("includeDirs");
  });

  it("givenVerbose_whenListed_thenSpecsAndIncludeDirsAppear", () => {
    const text = listOutput(FIXTURE_WS, { json: false, verbose: true });

    expect(text).toContain("proto specs (2)");
    expect(text).toContain("echo.proto");
    expect(text).toContain("common.proto");
    expect(text).toContain("include dirs (5)");
    expect(text).toContain("src/main/proto");
  });

  it("givenWorkspace_whenDescribed_thenSnapshotCarriesGroupingAndIncludeDirs", () => {
    const snapshot = describeWorkspace(FIXTURE_WS);

    expect(snapshot.requests[4]).toMatchObject({ collection: "payment", folders: ["nested"] });
    expect(snapshot.includeDirs).toHaveLength(5);
  });
});

describe("env show output", () => {
  it("givenEnvironment_whenShown_thenValuesSortedByKey", () => {
    const text = envOutput(FIXTURE_WS, "LOCAL", false);
    const [name, file, blank, ...values] = text.split("\n");

    expect(name).toBe("LOCAL");
    expect(file).toContain("LOCAL.environment.yaml");
    expect(blank).toBe("");
    expect(values).toEqual([
      "  greeting = hello",
      "  grpc_url = (empty)",
      "  mode = SUCCEED",
      "  nested_token = {{greeting}} world",
      "  trans_id = (empty)",
    ]);
  });

  it("givenEmptyValue_whenShown_thenPlaceholderShown", () => {
    expect(envOutput(FIXTURE_WS, "LOCAL", false)).toContain("grpc_url = (empty)");
    // The JSON form reports the raw empty string rather than the placeholder.
    const report = JSON.parse(envOutput(FIXTURE_WS, "LOCAL", true)) as {
      values: Record<string, string>;
    };
    expect(Object.keys(report)).toEqual(["name", "file", "values"]);
    expect(report.values.grpc_url).toBe("");
    expect(report.values.disabled_var).toBeUndefined();
  });

  it("givenNoEnvironments_whenShown_thenErrorRaised", () => {
    const clone = cloneFixtureWorkspace();
    try {
      rmSync(`${clone.workspace.postmanDir}/environments`, { recursive: true, force: true });
      expect(() => envOutput(clone.root, undefined, false)).toThrow(PremanError);
      expect(() => envOutput(clone.root, undefined, false)).toThrow("no environments found under postman/environments");
    } finally {
      clone.cleanup();
    }
  });
});

describe("env set output", () => {
  it("givenKeyAndValue_whenSet_thenFileWrittenAndConfirmationReturned", () => {
    const clone = cloneFixtureWorkspace();
    try {
      const envPath = `${clone.workspace.postmanDir}/environments/LOCAL.environment.yaml`;
      const text = envSetOutput(clone.root, "LOCAL", "greeting", "howdy", false);

      expect(text).toBe(`set greeting=howdy in LOCAL (${envPath})`);
      expect(loadEnvironment(envPath).values.greeting).toBe("howdy");

      const report = JSON.parse(envSetOutput(clone.root, "LOCAL", "extra", "1", true)) as Record<string, string>;
      expect(Object.keys(report)).toEqual(["name", "file", "key", "value"]);
      expect(report).toMatchObject({ name: "LOCAL", key: "extra", value: "1" });
      expect(loadEnvironment(envPath).values.extra).toBe("1");
    } finally {
      clone.cleanup();
    }
  });
});
