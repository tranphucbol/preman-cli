/**
 * A scene is one GIF: a workspace, a launched app, and the steps a reader watches.
 *
 * Gated twice: `PREMAN_APP=1` like every app suite, and `PREMAN_README_MEDIA` because a run
 * rewrites tracked files under `docs/media/`. `PREMAN_README_MEDIA=1` records every scene;
 * `PREMAN_README_MEDIA=send,palette` records those and leaves the others as they are.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright-core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { APP_TESTS_ENABLED, closeApp, launchApp, type LaunchedApp } from "../harness.js";
import { END_PAUSE_MS, installOverlay, pause } from "./pace.js";
import { GIF_MAX_BYTES, requireFfmpeg, startRecording } from "./recorder.js";

const MEDIA_ENV = process.env["PREMAN_README_MEDIA"];
const RECORD_ALL = "1";
const ONLY = MEDIA_ENV === undefined || MEDIA_ENV === RECORD_ALL ? null : new Set(MEDIA_ENV.split(","));
export const README_MEDIA_ENABLED = APP_TESTS_ENABLED && MEDIA_ENV !== undefined && MEDIA_ENV !== "";
const SCENE_TIMEOUT_MS = 120_000;
/** Past this a reader has scrolled on; the scene should be cut, not the cap raised. */
const MAX_GIF_SECONDS = 25;
/** Every GIF together: what the README costs to open. */
const GIFS_MAX_BYTES = 12 * 1024 * 1024;
/** The longest a still screen may hold, so waiting on the network is not what the GIF shows. */
const DEFAULT_MAX_FRAME_SECONDS = 2.5;
const FAILURE_PREFIX = "preman-readme-";

export interface SceneContext {
  page: Page;
}

export interface Scene {
  /** The workspace to open; `dispose` runs after the app has closed. */
  workspace(): Promise<{ root: string; dispose?: () => Promise<void> }>;
  /** Unrecorded: whatever the first frame should already show. */
  setup?(context: SceneContext): Promise<void>;
  /** Recorded. */
  run(context: SceneContext): Promise<void>;
}

let launched: LaunchedApp | undefined;
let dispose: (() => Promise<void>) | undefined;
const recorded: number[] = [];
let declared = 0;

/** One `it` per scene; it writes `docs/media/<name>.gif` and checks the GIF stays small. */
export function scene(name: string, definition: Scene): void {
  declared += 1;
  const skipped = ONLY !== null && !ONLY.has(name);
  it.skipIf(skipped)(
    name,
    async () => {
      const workspace = await definition.workspace();
      dispose = workspace.dispose;
      launched = await launchApp(workspace.root);
      const { page } = launched;
      await failureShot(page, name, async () => {
        await installOverlay(page);
        await definition.setup?.({ page });
        await pause(page);
        const recording = await startRecording(launched as LaunchedApp);
        await definition.run({ page });
        await pause(page, END_PAUSE_MS);
        const media = await recording.stop(name, DEFAULT_MAX_FRAME_SECONDS);
        recorded.push(media.bytes);
        expect(media.bytes, `${media.path} is too heavy for a README`).toBeLessThanOrEqual(GIF_MAX_BYTES);
        expect(media.seconds, `${media.path} runs too long`).toBeLessThanOrEqual(MAX_GIF_SECONDS);
      });
    },
    SCENE_TIMEOUT_MS,
  );
}

/** A failed scene leaves a screenshot of where it stopped, since its GIF was never written. */
async function failureShot(page: Page, name: string, body: () => Promise<void>): Promise<void> {
  try {
    await body();
  } catch (error) {
    const path = join(tmpdir(), `${FAILURE_PREFIX}${name}-failure.png`);
    await page.screenshot({ path }).catch(() => undefined);
    throw new Error(`Scene ${name} failed; its last frame is ${path}.`, { cause: error });
  }
}

export function mediaSuite(title: string, scenes: () => void): void {
  describe.runIf(README_MEDIA_ENABLED)(title, () => {
    beforeAll(requireFfmpeg);
    afterEach(async () => {
      await closeApp(launched);
      launched = undefined;
      await dispose?.();
      dispose = undefined;
    });
    afterAll(() => {
      // Only a run that recorded every scene knows what the whole README weighs.
      if (recorded.length < declared) return;
      const total = recorded.reduce((sum, bytes) => sum + bytes, 0);
      expect(total, "docs/media/ is too heavy for one README").toBeLessThanOrEqual(GIFS_MAX_BYTES);
    });
    scenes();
  });
}
