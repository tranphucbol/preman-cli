/**
 * The half of the performance budget that needs no window.
 *
 * These are assertions, not aspirations: the numbers come from the budget table in
 * `docs/performance.md` and a regression in the catalog walk is meant to fail the suite
 * rather than be noticed as sluggishness six weeks later.
 *
 * Each case takes the **best** of a few attempts. A budget test answers "does this machine
 * do this much work in this long", and the minimum is the least noisy estimator of the work
 * actually performed — a median on a shared CI runner measures the other tenants. The first
 * attempt is thrown away for the same reason: it pays for the module graph and a cold page
 * cache, neither of which the app pays per keystroke.
 *
 * The start-up, RSS and frame-rate numbers need a real window, so they live in
 * `test/renderer/perf.app.test.ts` behind `PREMAN_PERF=1`.
 */
import { afterEach, describe, expect, it } from "vitest";
import { buildCatalog } from "@preman/core/api/catalog.js";
import { createEngineHost, type EngineHost } from "@preman/desktop/engine/host.js";
import { writeBigWorkspace, type GeneratedWorkspace } from "./support/big-workspace.js";

/** The workspace that drove the plan: 43 requests across nine collections. */
const REAL_WORKSPACE_REQUESTS = 43;
const REAL_WORKSPACE_BUDGET_MS = 50;
const BIG_WORKSPACE_REQUESTS = 1000;
const BIG_WORKSPACE_BUDGET_MS = 400;
const WARM_SWITCH_BUDGET_MS = 100;
/**
 * Three measured attempts plus a discarded first. Four whole catalog builds over a thousand
 * request files is about a second and a half of the suite, which is the price of the gate; a
 * fifth would buy no confidence the fourth did not already.
 */
const ATTEMPTS = 3;
const FIRST_ID = 1;

let generated: GeneratedWorkspace | undefined;
let hosts: EngineHost[] = [];

afterEach(() => {
  for (const host of hosts) host.dispose();
  hosts = [];
  generated?.cleanup();
  generated = undefined;
});

function track(host: EngineHost): EngineHost {
  hosts.push(host);
  return host;
}

/** The shortest of {@link ATTEMPTS} runs, discarding the first. */
async function best(run: () => Promise<unknown>): Promise<number> {
  await run();
  let shortest = Number.POSITIVE_INFINITY;
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    const started = performance.now();
    await run();
    shortest = Math.min(shortest, performance.now() - started);
  }
  return shortest;
}

describe("buildCatalog budget", () => {
  it("givenRealSizedWorkspace_whenBuildCatalog_thenUnderFiftyMs", async () => {
    generated = writeBigWorkspace(REAL_WORKSPACE_REQUESTS);
    const root = generated.root;

    const catalog = await buildCatalog(root);
    expect(catalog.nodes.filter((node) => node.kind === "request")).toHaveLength(REAL_WORKSPACE_REQUESTS);

    const elapsed = await best(() => buildCatalog(root));
    expect(elapsed).toBeLessThanOrEqual(REAL_WORKSPACE_BUDGET_MS);
  });

  it("givenThousandRequestWorkspace_whenBuildCatalog_thenUnderFourHundredMs", async () => {
    generated = writeBigWorkspace(BIG_WORKSPACE_REQUESTS);
    const root = generated.root;

    const catalog = await buildCatalog(root);
    expect(catalog.nodes).toHaveLength(generated.nodes);

    const elapsed = await best(() => buildCatalog(root));
    expect(elapsed).toBeLessThanOrEqual(BIG_WORKSPACE_BUDGET_MS);
  });
});

describe("warm host budget", () => {
  /**
   * What switching back to an already-open workspace costs the engine. The host holds its
   * catalog, so the answer should be the price of one message and nothing else — this is the
   * case that fails the moment somebody makes `ensureCatalog` re-read the disk.
   */
  it("givenWarmHost_whenSwitchingWorkspace_thenUnderOneHundredMs", async () => {
    generated = writeBigWorkspace(BIG_WORKSPACE_REQUESTS);
    const host = track(createEngineHost({ root: generated.root, post: () => undefined }));

    const first = await host.handle({ id: FIRST_ID, kind: "catalog" });
    expect(first.ok).toBe(true);

    let id = FIRST_ID;
    const elapsed = await best(async () => {
      id += 1;
      const response = await host.handle({ id, kind: "catalog" });
      expect(response.ok).toBe(true);
    });
    expect(elapsed).toBeLessThanOrEqual(WARM_SWITCH_BUDGET_MS);
  });
});
