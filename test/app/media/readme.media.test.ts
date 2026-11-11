/**
 * The GIFs in the README, recorded from the built app. Each scene writes `docs/media/<name>.gif`.
 *
 *   bun run readme:media                      in the Linux box (the default)
 *   bun run readme:media -- --media=send      one scene, in the box
 *   bun run readme:media:host                 on this machine, for a final pass on macOS
 *
 * The scenes run against the HTTP fixture and an in-process server, so the responses are real
 * and the same on every run.
 */
import type { Locator, Page } from "playwright-core";
import { httpWorkspace, HTTP_ENVIRONMENT } from "../fixtures.js";
import { clickVisibly, pause, pressVisibly, typeSlowly } from "./pace.js";
import { mediaSuite, scene } from "./scenes.js";

const REQUEST_ROW_SELECTOR = '[role="treeitem"]:not([aria-expanded])';
const OPEN_TAB_SELECTOR = '[role="tablist"][aria-label="Open requests"] [role="tab"]';
const PALETTE_INPUT_LABEL = "Go to a request, switch environment, run a command";
const IMPORT_COMMAND = "Import from cURL or grpcurl…";
const RESPONSE_TIMEOUT_MS = 15_000;
const OK_STATUS = "200";
const TESTS_TAB = "Tests";
const IMPORT_PANE_TITLE = "Import from cURL or grpcurl";
const POLL_MS = 100;

/** Polls, since `playwright-core` has no `expect(locator).toBeEnabled()`. */
async function waitForEnabled(page: Page, locator: Locator): Promise<void> {
  const deadline = Date.now() + RESPONSE_TIMEOUT_MS;
  while (!(await locator.isEnabled())) {
    if (Date.now() > deadline) throw new Error(`${String(locator)} never became enabled.`);
    await page.waitForTimeout(POLL_MS);
  }
}

async function chooseEnvironment(page: Page, name: string): Promise<void> {
  await page.getByRole("combobox", { name: "Environment" }).click();
  await page.getByRole("option", { name }).click();
}

/** Waits for the status of the response just sent; the previous one is gone once it is running. */
async function waitForStatus(page: Page, status = OK_STATUS): Promise<void> {
  await page.getByRole("button", { name: "Send", exact: true }).waitFor({ timeout: RESPONSE_TIMEOUT_MS });
  await page.getByText(status, { exact: true }).first().waitFor({ timeout: RESPONSE_TIMEOUT_MS });
}

async function openFromPalette(page: Page, query: string): Promise<void> {
  await pressVisibly(page, "Mod+K");
  await page.getByLabel(PALETTE_INPUT_LABEL).waitFor();
  await pause(page, 300);
  await typeSlowly(page, query);
  await pause(page, 400);
  await pressVisibly(page, "Enter");
}

mediaSuite("the README's media", () => {
  scene("send", {
    workspace: httpWorkspace,
    async setup({ page }) {
      await chooseEnvironment(page, HTTP_ENVIRONMENT);
    },
    async run({ page }) {
      await clickVisibly(page, page.locator(REQUEST_ROW_SELECTOR, { hasText: "Login" }).first());
      await page.locator(OPEN_TAB_SELECTOR, { hasText: "Login" }).waitFor();
      await pause(page);
      await clickVisibly(page, page.getByRole("button", { name: "Send", exact: true }));
      await waitForStatus(page);
      await pause(page);
      await clickVisibly(page, page.getByRole("tab", { name: new RegExp(`^${TESTS_TAB}`) }));
      await pause(page);
    },
  });

  scene("palette", {
    workspace: httpWorkspace,
    async setup({ page }) {
      await chooseEnvironment(page, HTTP_ENVIRONMENT);
    },
    async run({ page }) {
      await openFromPalette(page, "login");
      await page.locator(OPEN_TAB_SELECTOR, { hasText: "Login" }).waitFor();
      await pause(page);
      await pressVisibly(page, "Mod+Enter");
      await waitForStatus(page);
      await pause(page);
      // Login's script stored the token Profile's bearer auth reads, so this one is a 200 too.
      await openFromPalette(page, "prof");
      await page.locator(OPEN_TAB_SELECTOR, { hasText: "Profile" }).waitFor();
      await pause(page);
      await pressVisibly(page, "Mod+Enter");
      await waitForStatus(page);
      await pause(page);
    },
  });

  let origin = "";
  scene("import", {
    async workspace() {
      const workspace = await httpWorkspace();
      origin = workspace.server.origin;
      return workspace;
    },
    async run({ page }) {
      await pressVisibly(page, "Mod+K");
      await page.getByLabel(PALETTE_INPUT_LABEL).waitFor();
      await typeSlowly(page, "import");
      await pause(page, 400);
      await page.getByRole("button", { name: IMPORT_COMMAND }).waitFor();
      await pressVisibly(page, "Enter");
      await page.locator(".cm-content").first().waitFor();
      await pause(page, 400);
      await typeSlowly(page, `curl ${origin}/echo -H 'x-trace: readme' -d 'hello=world'`);
      const confirm = page.getByRole("button", { name: "Import", exact: true });
      await waitForEnabled(page, confirm);
      await pause(page);
      await clickVisibly(page, confirm);
      // The import opens what it wrote, so once the pane is gone the new request is the active tab.
      await page
        .getByText(IMPORT_PANE_TITLE, { exact: true })
        .waitFor({ state: "hidden", timeout: RESPONSE_TIMEOUT_MS });
      await pause(page);
      await pressVisibly(page, "Mod+Enter");
      await waitForStatus(page);
      await pause(page);
    },
  });
});
