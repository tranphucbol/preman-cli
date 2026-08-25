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
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { buildCatalog } from "@preman/core/api/catalog.js";
import { FAKER_MODULE } from "@preman/core/scripts/module-names.js";
import { createEngineHost, type EngineHost } from "@preman/desktop/engine/host.js";
import { mergeConsole } from "@preman/desktop/renderer/model/response.js";
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
/** `CONSOLE_MAX_LINES` in each of the three streams: the most the drawer can ever hold. */
const MERGE_ROWS = 5000;
const MERGE_STREAMS = 3;
const MERGE_BUDGET_MS = 10;
const NODE_ID = "postman/collections/payment/Ping.request.yaml";
const RUN_ID = "run-1";
/** The three stream shapes, taken off the function rather than restated beside it. */
type MergeArgs = Parameters<typeof mergeConsole>;

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

/**
 * The drawer re-derives its rows on every console event, so this runs thousands of times in a
 * long run. It is a three-finger merge rather than a concat and a sort for exactly that reason,
 * and this is the case that fails if somebody replaces it with the obvious one-liner.
 */
describe("console merge budget", () => {
  it("givenFiveThousandRowsInThreeStreams_whenMerged_thenItStaysWithinBudget", async () => {
    // Round-robin seqs, so no finger is ever exhausted early and every comparison is paid for.
    const lines: MergeArgs[0] = Array.from({ length: MERGE_ROWS }, (_, index) => ({
      runId: RUN_ID,
      nodeId: NODE_ID,
      seq: index * MERGE_STREAMS,
      line: { level: "log", text: `line ${String(index)}`, origin: { level: "request", label: "request" } },
    }));
    const sideRequests: MergeArgs[1] = Array.from({ length: MERGE_ROWS }, (_, index) => ({
      runId: RUN_ID,
      nodeId: NODE_ID,
      seq: index * MERGE_STREAMS + 1,
      summary: {
        method: "POST",
        url: "https://auth.example/token",
        statusCode: 200,
        statusMessage: "OK",
        message: "",
        ok: true,
        durationMs: 12,
      },
    }));
    const calls: MergeArgs[2] = Array.from({ length: MERGE_ROWS }, (_, index) => ({
      runId: RUN_ID,
      nodeId: NODE_ID,
      seq: index * MERGE_STREAMS + 2,
      itemKey: `${NODE_ID}#${String(index)}`,
    }));

    const rows = mergeConsole(lines, sideRequests, calls);
    expect(rows).toHaveLength(MERGE_ROWS * MERGE_STREAMS);

    const elapsed = await best(() => Promise.resolve(mergeConsole(lines, sideRequests, calls)));
    expect(elapsed).toBeLessThanOrEqual(MERGE_BUDGET_MS);
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

/**
 * What the engine host is allowed to have loaded before it can answer `catalog`.
 *
 * Not a millisecond budget, because the thing it defends is not measurable without a cold page
 * cache and a machine nobody shares. It is the shape decision 029 bought: a static `import` of
 * anything that reaches these five puts them back in front of the sidebar, and the cost lands
 * only on a user whose disk is cold — which is to say, on first launch, and never in CI.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const CORE_SOURCE = resolve(REPO_ROOT, "packages/core/src");
const DESKTOP_SOURCE = resolve(REPO_ROOT, "packages/desktop/src");
const ENGINE_ENTRY = resolve(DESKTOP_SOURCE, "engine/entry.ts");
const CORE_SPECIFIER = "@preman/core/";
const DESKTOP_SPECIFIER = "@preman/desktop/";
/**
 * The send path's dependencies, by cold import cost on the development machine: faker 2.0s,
 * grpc-js 0.3s, chai, csv-parse and proto-loader the rest. `yaml` is deliberately absent — the
 * catalog is YAML, so the sidebar genuinely needs it and it is the only one it needs.
 */
const SEND_PATH_PACKAGES = new Set(["@faker-js/faker", "@grpc/grpc-js", "@grpc/proto-loader", "chai", "csv-parse"]);
const BLOCK_COMMENT = /\/\*[\s\S]*?\*\//g;
const LINE_COMMENT = /(^|[^:])\/\/[^\n]*/g;
/** A whole `import`/`export ... from "x"` statement, newlines and all; `[^;]` keeps it to one. */
const FROM_STATEMENT = /(?:^|[\n;])\s*(?:import|export)\b([^;]*?)\bfrom\s*["']([^"']+)["']/g;
/** `import "x";` on its own. A dynamic `import("x")` matches neither: it has no `from`. */
const BARE_STATEMENT = /(?:^|[\n;])\s*import\s+["']([^"']+)["']/g;
const TYPE_ONLY = /^\s*type\s/;
const JS_SUFFIX = /\.js$/;
const TS_SUFFIX = ".ts";
/** Any faker specifier at all, static or dynamic, quoted either way. */
const FAKER_SPECIFIER = /["'](@faker-js\/faker(?:\/[^"']*)?)["']/g;
const SOURCE_SUFFIX = /\.tsx?$/;
const SCOPE_PREFIX = "@";
const SCOPED_SEGMENTS = 2;
const UNSCOPED_SEGMENTS = 1;

/** `@faker-js/faker/locale/en` and `csv-parse/sync` both have to answer for their package. */
function packageRootOf(specifier: string): string {
  const segments = specifier.split("/");
  const kept = specifier.startsWith(SCOPE_PREFIX) ? SCOPED_SEGMENTS : UNSCOPED_SEGMENTS;
  return segments.slice(0, kept).join("/");
}

/** Where a specifier's file is, or `null` for a package: only the repo's own sources are walked. */
function sourceFileFor(specifier: string, importer: string): string | null {
  let base: string;
  if (specifier.startsWith(CORE_SPECIFIER)) base = resolve(CORE_SOURCE, specifier.slice(CORE_SPECIFIER.length));
  else if (specifier.startsWith(DESKTOP_SPECIFIER)) {
    base = resolve(DESKTOP_SOURCE, specifier.slice(DESKTOP_SPECIFIER.length));
  } else if (specifier.startsWith(".")) base = resolve(dirname(importer), specifier);
  else return null;
  const source = base.replace(JS_SUFFIX, TS_SUFFIX);
  return existsSync(source) && statSync(source).isFile() ? source : null;
}

/** Every specifier this file pulls in at evaluation time. Types are erased; `import()` is not now. */
function staticImportsOf(file: string): string[] {
  const text = readFileSync(file, "utf8").replace(BLOCK_COMMENT, "").replace(LINE_COMMENT, "$1");
  const specifiers = [...text.matchAll(BARE_STATEMENT)].map((match) => match[1] as string);
  for (const match of text.matchAll(FROM_STATEMENT)) {
    if (!TYPE_ONLY.test(match[1] as string)) specifiers.push(match[2] as string);
  }
  return specifiers;
}

describe("engine boot graph", () => {
  it("givenTheEngineEntry_whenItsStaticImportsAreWalked_thenNoSendPathPackageIsReached", () => {
    const parents = new Map<string, string | null>([[ENGINE_ENTRY, null]]);
    const pending = [ENGINE_ENTRY];
    const offenders: string[] = [];

    while (pending.length > 0) {
      const file = pending.pop() as string;
      for (const specifier of staticImportsOf(file)) {
        if (SEND_PATH_PACKAGES.has(packageRootOf(specifier))) {
          offenders.push(`${specifier} <- ${chainTo(file, parents)}`);
          continue;
        }
        const next = sourceFileFor(specifier, file);
        if (next === null || parents.has(next)) continue;
        parents.set(next, file);
        pending.push(next);
      }
    }

    // The chain, not just the package: the import that puts faker back is never in `host.ts`
    // itself. Last time it was six hops away, through `countTests`.
    expect(offenders).toEqual([]);
  });

  it("givenEverySource_whenFakerIsImported_thenOnlyTheLocaleEntryIsNamed", () => {
    // `import()` hides this one from the walk above: faker is allowed on the send path, so the
    // graph test passes either way. What it may not be is the barrel, which loads all 71 locales.
    const offenders: string[] = [];
    for (const file of sourcesUnder(CORE_SOURCE).concat(sourcesUnder(DESKTOP_SOURCE))) {
      const text = readFileSync(file, "utf8");
      for (const [, specifier] of text.matchAll(FAKER_SPECIFIER)) {
        if (specifier !== FAKER_MODULE) offenders.push(`${relative(REPO_ROOT, file)}: ${specifier}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

/** Every TypeScript source under a package, so a barrel import cannot hide in an untravelled file. */
function sourcesUnder(root: string): string[] {
  const files: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    for (const entry of readdirSync(pending.pop() as string, { withFileTypes: true })) {
      const path = resolve(entry.parentPath, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && SOURCE_SUFFIX.test(entry.name)) files.push(path);
    }
  }
  return files;
}

/** How the walk got to `file`, innermost last, for a failure message worth reading. */
function chainTo(file: string, parents: Map<string, string | null>): string {
  const hops: string[] = [];
  let current: string | null = file;
  while (current !== null && current !== undefined) {
    hops.push(relative(REPO_ROOT, current));
    current = parents.get(current) ?? null;
  }
  return hops.reverse().join(" -> ");
}
