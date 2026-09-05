import { copyFileSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runSelection, type RunSelectionArgs, type RunSelectionResult } from "@preman/core/api/run.js";
import type { SelectionPort } from "@preman/core/api/select.js";
import { PremanError } from "@preman/core/errors.js";
import { targetLabel, type RunTarget } from "@preman/core/workspace/collections.js";
import type { EnvironmentEntry } from "@preman/core/workspace/environments.js";
import { cloneFixtureWorkspace, collectionPath, FIXTURE_WS, FIXTURES_DIR, SSL_DIR } from "./helpers.js";

/**
 * Selection is asserted through `runSelection` rather than a private helper, because the
 * whole point of the port is which branch the use case reaches. Every run here dials the
 * unbound port from `config/application-local.yml` and fails at the transport, which is
 * enough: the selection has already happened by then.
 */
const BASE: Omit<RunSelectionArgs, "dir" | "selector" | "env"> = {
  url: undefined,
  tls: undefined,
  tlsCerts: {},
  certBaseDir: FIXTURES_DIR,
  timeoutMs: 5_000,
  runTimeoutMs: 0,
  scriptTimeoutMs: 5_000,
  iterationCount: undefined,
  iterationData: undefined,
  delayRequestMs: 0,
  vars: { greeting: "hi", mode: "SUCCEED" },
  save: false,
  preferDescriptor: false,
  bail: false,
  workingDir: undefined,
  insecureFileRead: false,
  safeEval: false,
};

interface SpyPort extends SelectionPort {
  readonly requestCalls: Array<{ candidates: RunTarget[]; selector: string | undefined }>;
  readonly environmentCalls: EnvironmentEntry[][];
}

/** Answers with the first candidate and records that it was asked at all. */
function spyPort(): SpyPort {
  const requestCalls: Array<{ candidates: RunTarget[]; selector: string | undefined }> = [];
  const environmentCalls: EnvironmentEntry[][] = [];
  return {
    requestCalls,
    environmentCalls,
    pickRequest(candidates, selector) {
      requestCalls.push({ candidates, selector });
      return Promise.resolve(candidates[0]!);
    },
    pickEnvironment(candidates) {
      environmentCalls.push(candidates);
      return Promise.resolve(candidates[0]!);
    },
  };
}

function run(overrides: Partial<RunSelectionArgs>): Promise<RunSelectionResult> {
  return runSelection({ ...BASE, dir: FIXTURE_WS, selector: undefined, env: "LOCAL", ...overrides });
}

/** Every request but the named one, so the engine has exactly one candidate left. */
function keepOnlyRequest(root: string, keep: string): void {
  for (const path of ["Ping", "Echo", "Legacy Http", "Descriptor Only"]) {
    if (path !== keep) unlinkSync(collectionPath(root, "payment", `${path}.request.yaml`));
  }
  rmSync(collectionPath(root, "payment", "nested"), { recursive: true, force: true });
}

/** Where a second request declaring `name: Echo` goes, named the way `resolveCollision` names it. */
function duplicateEcho(root: string): string {
  return collectionPath(root, "payment", "Echo (2).request.yaml");
}

describe("request selection", () => {
  it("givenNoRequests_whenSelecting_thenErrorNamesTheEmptyWorkspace", async () => {
    const ws = cloneFixtureWorkspace();
    try {
      rmSync(join(ws.root, "postman/collections"), { recursive: true, force: true });
      const port = spyPort();
      await expect(run({ dir: ws.root, select: port })).rejects.toThrow("no requests found under postman/collections");
      expect(port.requestCalls).toHaveLength(0);
    } finally {
      ws.cleanup();
    }
  });

  it("givenSingleCandidate_whenSelecting_thenPortIsNotConsulted", async () => {
    const ws = cloneFixtureWorkspace();
    try {
      keepOnlyRequest(ws.root, "Echo");
      const port = spyPort();
      const result = await run({ dir: ws.root, select: port });
      expect(result.outcome?.entry.path).toBe("payment/Echo");
      expect(port.requestCalls).toHaveLength(0);
    } finally {
      ws.cleanup();
    }
  });

  it("givenAmbiguousSelector_whenNoPort_thenErrorListsCandidates", async () => {
    const error = await run({ selector: "cho" }).catch((cause: unknown) => cause as PremanError);
    expect(error).toBeInstanceOf(PremanError);
    expect((error as PremanError).message).toBe('"cho" is ambiguous');
    expect((error as PremanError).details).toEqual(["candidates:", "  payment/Echo", "  payment/nested/Deep Echo"]);
  });

  /**
   * The case an error built from `targetLabel` alone could not describe: two siblings that
   * declare the same `name` share a path, so both rows read as the selector the reader just
   * typed. Preman's own import writes this - `resolveCollision` keeps the name and numbers the
   * file - so it is not a workspace anyone had to hand-corrupt to reach.
   */
  it("givenSiblingsSharingAName_whenAmbiguous_thenEachCandidateNamesItsFile", async () => {
    const ws = cloneFixtureWorkspace();
    try {
      copyFileSync(collectionPath(ws.root, "payment", "Echo.request.yaml"), duplicateEcho(ws.root));
      const error = await run({ dir: ws.root, selector: "Echo" }).catch((cause: unknown) => cause as PremanError);

      expect(error).toBeInstanceOf(PremanError);
      expect((error as PremanError).message).toBe('"Echo" is ambiguous');
      const [heading, ...rows] = (error as PremanError).details;
      expect(heading).toBe("candidates:");
      expect([...rows].sort()).toEqual([
        "  payment/Echo  postman/collections/payment/Echo (2).request.yaml",
        "  payment/Echo  postman/collections/payment/Echo.request.yaml",
      ]);
    } finally {
      ws.cleanup();
    }
  });

  it("givenSiblingsSharingAName_whenSelectedByFile_thenTheNamedOneRuns", async () => {
    const ws = cloneFixtureWorkspace();
    try {
      copyFileSync(collectionPath(ws.root, "payment", "Echo.request.yaml"), duplicateEcho(ws.root));
      // Every row the ambiguity error printed is itself a selector; that is what makes it usable.
      const result = await run({ dir: ws.root, selector: "postman/collections/payment/Echo (2).request.yaml" });

      expect(result.outcome?.entry.file).toBe("postman/collections/payment/Echo (2).request.yaml");
    } finally {
      ws.cleanup();
    }
  });

  it("givenAmbiguousSelector_whenPortSupplied_thenPortChoiceIsUsed", async () => {
    const port = spyPort();
    const result = await run({ selector: "cho", select: port });
    expect(port.requestCalls).toHaveLength(1);
    expect(port.requestCalls[0]?.selector).toBe("cho");
    expect(port.requestCalls[0]?.candidates.map(targetLabel)).toEqual(["payment/Echo", "payment/nested/Deep Echo"]);
    expect(result.outcome?.entry.path).toBe("payment/Echo");
  });
});

describe("environment selection", () => {
  it("givenNamedEnvironment_whenSelecting_thenPortIsNotConsulted", async () => {
    const port = spyPort();
    await run({ selector: "Echo", env: "local", select: port });
    expect(port.environmentCalls).toHaveLength(0);
  });

  it("givenMultipleEnvironments_whenNoPort_thenErrorAsksForDashE", async () => {
    const ws = cloneFixtureWorkspace();
    try {
      const environments = join(ws.root, "postman/environments");
      const local = readFileSync(join(environments, "LOCAL.environment.yaml"), "utf8");
      writeFileSync(join(environments, "QC.environment.yaml"), local.replace("name: LOCAL", "name: QC"));
      const error = await run({ dir: ws.root, selector: "Echo", env: undefined }).catch(
        (cause: unknown) => cause as PremanError,
      );
      expect(error).toBeInstanceOf(PremanError);
      expect((error as PremanError).message).toBe("multiple environments exist; pass -e <NAME>");
      expect((error as PremanError).details).toEqual(["available:", "  LOCAL", "  QC"]);
    } finally {
      ws.cleanup();
    }
  });

  it("givenNoEnvironmentSelected_whenRun_thenWarningIsReturnedNotPrinted", async () => {
    const ws = cloneFixtureWorkspace();
    const written: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk: string | Uint8Array): boolean => {
      written.push(String(chunk));
      return true;
    };
    try {
      rmSync(join(ws.root, "postman/environments"), { recursive: true, force: true });
      // Ping is the one request whose only variable is the target, which --var can supply.
      const result = await run({ dir: ws.root, selector: "Ping", env: undefined, vars: { grpc_url: "" } });
      expect(result.warnings).toContain("no environment selected; only --var values are available");
      expect(written).toEqual([]);
    } finally {
      process.stderr.write = write;
      ws.cleanup();
    }
  });
});

describe("certificate base directory", () => {
  it("givenCertPathRelative_whenCertBaseDirDiffersFromDir_thenResolvedAgainstCertBaseDir", async () => {
    const result = await run({
      selector: "Echo",
      tlsCerts: { extraCaCerts: "ca.crt" },
      certBaseDir: SSL_DIR,
    });
    expect(result.outcome?.tlsSources.extraCaCerts).toBe(`--ssl-* (${join(SSL_DIR, "ca.crt")})`);

    // The same relative path anchored at the workspace instead: nothing to read there.
    await expect(
      run({ selector: "Echo", tlsCerts: { extraCaCerts: "ca.crt" }, certBaseDir: FIXTURE_WS }),
    ).rejects.toThrow("cannot read --ssl-extra-ca-certs file");
  });
});
