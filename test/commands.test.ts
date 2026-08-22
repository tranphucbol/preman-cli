import { rmSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { commandEnvSet, commandEnvShow } from "@preman/cli/commands/env.js";
import { commandList } from "@preman/cli/commands/list.js";
import { CliError } from "@preman/core/errors.js";
import { loadEnvironment } from "@preman/core/workspace/environments.js";
import { cloneFixtureWorkspace, FIXTURE_WS } from "./helpers.js";

/**
 * Golden-output characterization of the `list` and `env` commands, taken before the
 * query half moves into core. Colour is off under vitest, so these are plain strings.
 */

describe("commandList", () => {
  it("givenWorkspace_whenListed_thenRequestsGroupedByCollection", () => {
    const text = commandList({ dir: FIXTURE_WS, json: false, verbose: false });

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
      "  LOCAL  4 vars",
    ]);
  });

  it("givenWorkspace_whenListedAsJson_thenShapeIsStable", () => {
    const report = JSON.parse(commandList({ dir: FIXTURE_WS, json: true, verbose: false })) as {
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
    expect(report.environments[0]?.keys).toEqual(["grpc_url", "trans_id", "greeting", "mode"]);
    expect(report.specs).toHaveLength(2);
    // Decision: the JSON shape omits includeDirs even though verbose text prints them.
    expect(report).not.toHaveProperty("includeDirs");
  });

  it("givenVerbose_whenListed_thenSpecsAndIncludeDirsAppear", () => {
    const text = commandList({ dir: FIXTURE_WS, json: false, verbose: true });

    expect(text).toContain("proto specs (2)");
    expect(text).toContain("echo.proto");
    expect(text).toContain("common.proto");
    expect(text).toContain("include dirs (5)");
    expect(text).toContain("src/main/proto");
  });
});

describe("commandEnvShow", () => {
  it("givenEnvironment_whenShown_thenValuesSortedByKey", () => {
    const text = commandEnvShow({ dir: FIXTURE_WS, env: "LOCAL", json: false });
    const [name, file, blank, ...values] = text.split("\n");

    expect(name).toBe("LOCAL");
    expect(file).toContain("LOCAL.environment.yaml");
    expect(blank).toBe("");
    expect(values).toEqual(["  greeting = hello", "  grpc_url = (empty)", "  mode = SUCCEED", "  trans_id = (empty)"]);
  });

  it("givenEmptyValue_whenShown_thenPlaceholderShown", () => {
    expect(commandEnvShow({ dir: FIXTURE_WS, env: "LOCAL", json: false })).toContain("grpc_url = (empty)");
    // The JSON form reports the raw empty string rather than the placeholder.
    const report = JSON.parse(commandEnvShow({ dir: FIXTURE_WS, env: "LOCAL", json: true })) as {
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
      expect(() => commandEnvShow({ dir: clone.root, env: undefined, json: false })).toThrow(CliError);
      expect(() => commandEnvShow({ dir: clone.root, env: undefined, json: false })).toThrow(
        "no environments found under postman/environments",
      );
    } finally {
      clone.cleanup();
    }
  });
});

describe("commandEnvSet", () => {
  it("givenKeyAndValue_whenSet_thenFileWrittenAndConfirmationReturned", () => {
    const clone = cloneFixtureWorkspace();
    try {
      const envPath = `${clone.workspace.postmanDir}/environments/LOCAL.environment.yaml`;
      const text = commandEnvSet({ dir: clone.root, env: "LOCAL", json: false, key: "greeting", value: "howdy" });

      expect(text).toBe(`set greeting=howdy in LOCAL (${envPath})`);
      expect(loadEnvironment(envPath).values.greeting).toBe("howdy");

      const report = JSON.parse(
        commandEnvSet({ dir: clone.root, env: "LOCAL", json: true, key: "extra", value: "1" }),
      ) as Record<string, string>;
      expect(Object.keys(report)).toEqual(["name", "file", "key", "value"]);
      expect(report).toMatchObject({ name: "LOCAL", key: "extra", value: "1" });
      expect(loadEnvironment(envPath).values.extra).toBe("1");
    } finally {
      clone.cleanup();
    }
  });
});
