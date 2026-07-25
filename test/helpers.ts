import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { requireWorkspace, type Workspace } from "../src/workspace/discover.js";

const here = dirname(fileURLToPath(import.meta.url));

export const FIXTURES_DIR = resolve(here, "fixtures");
/** The read-only fixture workspace checked into the repo. */
export const FIXTURE_WS = join(FIXTURES_DIR, "ws");
export const FIXTURE_PROTO = join(FIXTURE_WS, "src/main/proto/echo/echo.proto");
export const FIXTURE_INCLUDE_DIR = join(FIXTURE_WS, "src/main/proto");

export function fixtureWorkspace(): Workspace {
  return requireWorkspace(FIXTURE_WS);
}

export function requestPath(...segments: string[]): string {
  return join(FIXTURE_WS, "postman/collections/payment", ...segments);
}

/**
 * Copy the fixture workspace into a temp dir so a test can mutate it.
 * Returns the copy's path plus a cleanup function.
 */
export function cloneFixtureWorkspace(): { root: string; workspace: Workspace; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "preman-ws-"));
  cpSync(FIXTURE_WS, root, { recursive: true });
  return {
    root,
    workspace: requireWorkspace(root),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
