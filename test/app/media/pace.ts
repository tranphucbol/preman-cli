/**
 * Driving the app at a pace a reader can follow, and showing what the hands are doing.
 *
 * A screencast sees the page and nothing else: no system cursor, no keyboard. So the suite draws
 * its own pointer, moves it to whatever it is about to click, and shows each shortcut as a badge
 * before pressing it. Without them a GIF is a window that changes by itself.
 *
 * The overlay is a string evaluated in the page, because the root program has no `lib.dom`.
 */
import type { Locator, Page } from "playwright-core";

const KEY_DELAY_MS = 55;
export const STEP_PAUSE_MS = 700;
export const END_PAUSE_MS = 1_500;
const BADGE_MS = 900;
const POINTER_MOVE_MS = 400;
const CENTRE = 2;
/** Playwright's spelling of the renderer's `metaKey || ctrlKey`. */
const MOD = "ControlOrMeta";
/** The badge spells shortcuts the way the app's menus do, on every OS. */
const KEY_GLYPHS: Record<string, string> = {
  Mod: "⌘",
  Shift: "⇧",
  Alt: "⌥",
  Enter: "↵",
  Escape: "Esc",
  ArrowUp: "↑",
  ArrowDown: "↓",
};

const OVERLAY_SCRIPT = `(() => {
  if (document.getElementById("readme-pointer")) return;
  const pointer = document.createElement("div");
  pointer.id = "readme-pointer";
  pointer.style.cssText = [
    "position:fixed", "left:0", "top:0", "width:20px", "height:28px", "pointer-events:none",
    "z-index:2147483646", "transform:translate(-40px,-40px)",
    "transition:transform ${POINTER_MOVE_MS}ms cubic-bezier(0.23,1,0.32,1)",
    "filter:drop-shadow(0 1px 2px rgb(0 0 0 / 0.5))",
  ].join(";");
  pointer.innerHTML = '<svg width="20" height="28" viewBox="0 0 20 28"><path d="M1 1 L1 22 L6 17 L10 26 L13.5 24.5 L9.5 16 L17 16 Z" fill="#fff" stroke="#111" stroke-width="1.5" stroke-linejoin="round"/></svg>';
  const badge = document.createElement("div");
  badge.id = "readme-badge";
  badge.style.cssText = [
    "position:fixed", "right:24px", "bottom:44px", "padding:8px 16px", "border-radius:8px",
    "border:1px solid var(--color-line-strong)", "background:var(--color-control)",
    "color:var(--color-ink)", "font:600 22px var(--font-sans)", "letter-spacing:0.08em",
    "box-shadow:var(--shadow-float)", "pointer-events:none", "z-index:2147483646",
    "opacity:0", "transition:opacity 120ms ease-out",
  ].join(";");
  document.body.append(pointer, badge);
})()`;

export async function installOverlay(page: Page): Promise<void> {
  await page.evaluate(OVERLAY_SCRIPT);
}

export async function pause(page: Page, ms = STEP_PAUSE_MS): Promise<void> {
  await page.waitForTimeout(ms);
}

export async function typeSlowly(page: Page, text: string): Promise<void> {
  await page.keyboard.type(text, { delay: KEY_DELAY_MS });
}

async function movePointer(page: Page, x: number, y: number): Promise<void> {
  await page.evaluate(
    `document.getElementById("readme-pointer").style.transform = "translate(${Math.round(x)}px, ${Math.round(y)}px)"`,
  );
  await page.mouse.move(x, y);
  await page.waitForTimeout(POINTER_MOVE_MS);
}

/** Moves the drawn pointer onto `locator`, then clicks it there. */
export async function clickVisibly(page: Page, locator: Locator): Promise<void> {
  await locator.waitFor();
  const box = await locator.boundingBox();
  if (box === null) throw new Error(`${String(locator)} has no box to click.`);
  const x = box.x + box.width / CENTRE;
  const y = box.y + box.height / CENTRE;
  await movePointer(page, x, y);
  await page.mouse.click(x, y);
}

/** `Mod+Enter` shows `⌘ ↵` for a moment, then presses `ControlOrMeta+Enter`. */
export async function pressVisibly(page: Page, chord: string): Promise<void> {
  const label = chord
    .split("+")
    .map((key) => KEY_GLYPHS[key] ?? key.toUpperCase())
    .join(" ");
  await page.evaluate(`(() => {
    const badge = document.getElementById("readme-badge");
    badge.textContent = ${JSON.stringify(label)};
    badge.style.opacity = "1";
    clearTimeout(window.__readmeBadge);
    window.__readmeBadge = setTimeout(() => { badge.style.opacity = "0"; }, ${BADGE_MS});
  })()`);
  await page.keyboard.press(chord.replaceAll("Mod", MOD));
}
