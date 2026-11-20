/**
 * The desktop app, launched and used. Gated behind `PREMAN_APP=1`; see `harness.ts`.
 *
 *   bun run test:app          on this machine
 *   bun run test:app:linux    in the Linux box, under Xvfb
 */
import type { Page } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";
import { FIXTURE_WS } from "../helpers.js";
import { httpWorkspace, HTTP_ENVIRONMENT, type HttpWorkspace } from "./fixtures.js";
import { APP_TESTS_ENABLED, closeApp, launchApp, LAUNCH_TIMEOUT_MS, type LaunchedApp } from "./harness.js";

/** Electron's start-up plus a request round trip, with room for a cold Docker volume. */
const APP_TEST_TIMEOUT_MS = 120_000;
const RESPONSE_TIMEOUT_MS = 15_000;
/** Only groups carry `aria-expanded`, so a leaf of the tree is a request. */
const REQUEST_ROW_SELECTOR = '[role="treeitem"]:not([aria-expanded])';
const OPEN_TAB_SELECTOR = '[role="tablist"][aria-label="Open requests"] [role="tab"]';
const PALETTE_INPUT_LABEL = "Go to a request, switch environment, run a command";
const SEND_SHORTCUT = "ControlOrMeta+Enter";
const PALETTE_SHORTCUT = "ControlOrMeta+K";
const FIND_SHORTCUT = "ControlOrMeta+F";
const BODY_FIND_LABEL = "Find (⌘F)";
const FIND_LABEL = "Find";
/** `/login` answers with one token, so the counter has exactly one hit to show. */
const FOUND_ONCE = "token";
const ONE_OF_ONE = "1/1";
/** The committed `ws` fixture's runnable requests, as the sidebar names them. */
const FIXTURE_REQUESTS = ["Ping", "Echo", "Descriptor Only"];
const OK_STATUS = "200";
/** The import pane's box is a CodeMirror editor, not a textarea. */
const EDITOR_SELECTOR = ".cm-content";
/** What an import names a request with no name of its own: the URL's last path segment. */
const IMPORTED_NAME = "echo";
const POLL_MS = 100;
/** Only macOS keeps the app alive with no window, so only there can `activate` bring one back. */
const SURVIVES_LAST_WINDOW = process.platform === "darwin";
const REOPENS = 2;

let launched: LaunchedApp | undefined;
let workspace: HttpWorkspace | undefined;

afterEach(async () => {
  await closeApp(launched);
  launched = undefined;
  await workspace?.dispose();
  workspace = undefined;
});

async function chooseEnvironment(page: Page, name: string): Promise<void> {
  await page.getByRole("combobox", { name: "Environment" }).click();
  await page.getByRole("option", { name }).click();
}

describe.runIf(APP_TESTS_ENABLED)("the desktop app", () => {
  it(
    "givenFixtureWorkspace_whenLaunched_thenSidebarListsItsRequests",
    async () => {
      launched = await launchApp(FIXTURE_WS);
      const { page } = launched;

      for (const name of FIXTURE_REQUESTS) {
        await expect(page.locator(REQUEST_ROW_SELECTOR, { hasText: name }).first().isVisible()).resolves.toBe(true);
      }
    },
    APP_TEST_TIMEOUT_MS,
  );

  it(
    "givenHttpRequest_whenSentWithModEnter_thenResponsePaneShowsTheStatus",
    async () => {
      workspace = await httpWorkspace();
      launched = await launchApp(workspace.root);
      const { page } = launched;

      await chooseEnvironment(page, HTTP_ENVIRONMENT);
      await page.locator(REQUEST_ROW_SELECTOR, { hasText: "Login" }).first().click();
      await page.locator(OPEN_TAB_SELECTOR, { hasText: "Login" }).waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await page.getByRole("button", { name: "Send", exact: true }).waitFor();
      await page.keyboard.press(SEND_SHORTCUT);

      await page.getByText(OK_STATUS, { exact: true }).first().waitFor({ timeout: RESPONSE_TIMEOUT_MS });
      expect(workspace.server.received.map((request) => `${request.method} ${request.url}`)).toEqual(["POST /login"]);
    },
    APP_TEST_TIMEOUT_MS,
  );

  it(
    "givenResponseBody_whenFindIsClosedAndModFPressed_thenTheFindBarReopensOnTheBody",
    async () => {
      workspace = await httpWorkspace();
      launched = await launchApp(workspace.root);
      const { page } = launched;

      await chooseEnvironment(page, HTTP_ENVIRONMENT);
      await page.locator(REQUEST_ROW_SELECTOR, { hasText: "Login" }).first().click();
      await page.getByRole("button", { name: "Send", exact: true }).waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await page.keyboard.press(SEND_SHORTCUT);
      await page.getByText(OK_STATUS, { exact: true }).first().waitFor({ timeout: RESPONSE_TIMEOUT_MS });

      await page.getByRole("button", { name: BODY_FIND_LABEL }).click();
      const bar = page.getByRole("search", { name: FIND_LABEL });
      await page.keyboard.type(FOUND_ONCE);
      await bar.getByText(ONE_OF_ONE, { exact: true }).waitFor({ timeout: RESPONSE_TIMEOUT_MS });

      // Escape hands focus back to the read-only body; Cmd+F only fires if the body can hold it.
      await page.keyboard.press("Escape");
      await waitUntil(async () => (await bar.count()) === 0);
      await page.keyboard.press(FIND_SHORTCUT);
      await bar.getByText(ONE_OF_ONE, { exact: true }).waitFor({ timeout: RESPONSE_TIMEOUT_MS });
      await expect(bar.getByRole("textbox", { name: FIND_LABEL }).inputValue()).resolves.toBe(FOUND_ONCE);
    },
    APP_TEST_TIMEOUT_MS,
  );

  it(
    "givenCommandPalette_whenARequestIsChosen_thenItOpensInATab",
    async () => {
      launched = await launchApp(FIXTURE_WS);
      const { page } = launched;

      await page.keyboard.press(PALETTE_SHORTCUT);
      const input = page.getByLabel(PALETTE_INPUT_LABEL);
      await input.fill("deep");
      await input.press("Enter");

      const tab = page.locator(OPEN_TAB_SELECTOR, { hasText: "Deep Echo" });
      await tab.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await expect(tab.getAttribute("aria-selected")).resolves.toBe("true");
    },
    APP_TEST_TIMEOUT_MS,
  );

  it(
    "givenACurlTypedIntoImport_whenImportIsClickedWithTheEditorFocused_thenTheRequestOpens",
    async () => {
      workspace = await httpWorkspace();
      launched = await launchApp(workspace.root);
      const { page } = launched;

      await page.keyboard.press(PALETTE_SHORTCUT);
      const input = page.getByLabel(PALETTE_INPUT_LABEL);
      await input.fill("import");
      await input.press("Enter");
      await page.locator(EDITOR_SELECTOR).first().click();
      await page.keyboard.type(`curl ${workspace.server.origin}/echo -d 'hello=world'`);
      const confirm = page.getByRole("button", { name: "Import", exact: true });
      await waitUntil(() => confirm.isEnabled());
      // The click itself blurs the editor; that blur used to re-plan and disable the button mid-click.
      await confirm.click();

      const tab = page.locator(OPEN_TAB_SELECTOR, { hasText: IMPORTED_NAME });
      await tab.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await expect(tab.getAttribute("aria-selected")).resolves.toBe("true");
    },
    APP_TEST_TIMEOUT_MS,
  );

  it.runIf(SURVIVES_LAST_WINDOW)(
    "givenAWindowReopenedByActivate_whenItIsClosed_thenActivateOpensAnother",
    async () => {
      launched = await launchApp(FIXTURE_WS);
      const { app } = launched;
      const windowCount = (): Promise<number> =>
        app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);

      // The second round is the one that failed: only the window `start()` made knew to forget itself.
      for (let round = 0; round < REOPENS; round += 1) {
        await app.evaluate(({ BrowserWindow }) => {
          BrowserWindow.getAllWindows()[0]?.close();
        });
        await waitUntil(async () => (await windowCount()) === 0);
        await app.evaluate(({ app: electronApp }) => {
          electronApp.emit("activate");
        });
        await waitUntil(async () => (await windowCount()) === 1);
      }
    },
    APP_TEST_TIMEOUT_MS,
  );
});

/** `playwright-core` has no retrying `expect`, so a condition is polled. */
async function waitUntil(condition: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + RESPONSE_TIMEOUT_MS;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error("The condition never held.");
    await new Promise((settled) => setTimeout(settled, POLL_MS));
  }
}
