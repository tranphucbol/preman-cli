import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { CatalogNode } from "@preman/desktop/engine/protocol.js";
import { BREADCRUMB_SEPARATOR, breadcrumbPath } from "@preman/desktop/renderer/model/breadcrumb.js";

/**
 * The breadcrumb row, asserted where it can be: the string it puts on the clipboard is pure, and
 * the rest is the row's shape read as source, in `resources.test.ts`'s manner and for its reason.
 *
 * What the source reading is for is the two things the pure part cannot say — that the click target
 * is the whole row rather than a copy button bolted to the end of it, and that the crumbs still do
 * not navigate.
 */

const DESKTOP_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../packages/desktop/src");
const CHROME_SOURCE = readFileSync(join(DESKTOP_DIR, "renderer/panes/DocumentChrome.tsx"), "utf8");

const BLOCK_COMMENT = /\/\*[\s\S]*?\*\//g;
const LINE_COMMENT = /\/\/.*$/gm;
const JSX_COMMENT = /\{\/\*[\s\S]*?\*\/\}/g;
const NOTHING = "";

/** `Breadcrumb`, from its `function` line to the first close at column zero. */
const BREADCRUMB = /function Breadcrumb\(\{ nodeId \}[\s\S]*?\n\}\n/;

function code(source: string): string {
  return source.replace(JSX_COMMENT, NOTHING).replace(BLOCK_COMMENT, NOTHING).replace(LINE_COMMENT, NOTHING);
}

function crumb(name: string): CatalogNode {
  return { id: name, kind: "folder", name, file: `/ws/${name}`, parentId: null, depth: 0, order: 0 };
}

function breadcrumb(): string {
  return BREADCRUMB.exec(code(CHROME_SOURCE))?.[0] ?? NOTHING;
}

describe("breadcrumbPath", () => {
  it("givenARequestInAFolder_whenTheRowIsCopied_thenTheWholeLocationIsOneLine", () => {
    const path = breadcrumbPath([crumb("Payments"), crumb("Cards")], "Authorise");

    // The sentence somebody is about to retype by hand into a ticket, having read it off this row.
    expect(path).toBe("Payments > Cards > Authorise");
  });

  it("givenACollectionsOwnRequest_whenTheRowIsCopied_thenThereIsNoLeadingSeparator", () => {
    expect(breadcrumbPath([crumb("Payments")], "Health")).toBe("Payments > Health");
  });

  it("givenNoAncestorsAtAll_whenTheRowIsCopied_thenItIsJustTheName", () => {
    // A collection opened as a document is its own row, and a path of one is a path.
    expect(breadcrumbPath([], "Payments")).toBe("Payments");
  });

  it("givenTheCopiedPath_whenItIsPasted_thenItIsNotMistakableForAPathOnDisk", () => {
    // A collection's directory is named after the collection, but a request's file is not named
    // after the request, so slashes would produce something that looks runnable and is not.
    expect(BREADCRUMB_SEPARATOR).toBe(" > ");
    expect(breadcrumbPath([crumb("Payments")], "Authorise")).not.toContain("/");
  });

  it("givenTheFinalName_whenTheRowIsCopied_thenItIsIncludedRatherThanTheFolderPath", () => {
    // The difference between this and a folder path, and the reason the row exists: a workspace
    // has four requests called `Create` in four collections.
    expect(breadcrumbPath([crumb("Payments")], "Create")).toContain("Create");
  });
});

describe("the breadcrumb row", () => {
  it("givenTheRow_whenItIsClickedAnywhere_thenTheWholeLocationIsCopied", () => {
    const body = breadcrumb();

    // The target is the thing being copied. A button at the end of the row would be an icon whose
    // only job is to say the row is copyable.
    expect(body).toContain("<button");
    expect(body).toContain("w-full");
    expect(body).toContain("navigator.clipboard.writeText(breadcrumbPath(ancestors, name))");
  });

  it("givenTheCrumbs_whenTheyAreDrawn_thenTheyStillDoNotNavigate", () => {
    const body = breadcrumb();

    // The half of the old record that survives: a click target on a name that is also a directory
    // on disk buys a jump the sidebar already does and risks a rename nobody asked for.
    expect(body).not.toContain("loadTab");
    expect(body).not.toContain("<a ");
  });

  it("givenACopy_whenTheTabIsSwitched_thenTheConfirmationDoesNotFollowIt", () => {
    const body = breadcrumb();

    // Held as the id that was copied rather than as a boolean, so `Copied` cannot end up sitting
    // over a path nobody copied. The comparison is at render; there is no effect to clear it.
    expect(body).toContain("const copied = copiedId === nodeId;");
    expect(body).toContain("setCopiedId(nodeId)");
  });

  it("givenTheNodeIsGone_whenTheRowWouldRender_thenNothingIsDrawn", () => {
    const body = breadcrumb();

    // An orphaned tab has a banner two rows down that says so properly, and a breadcrumb pointing
    // into a tree that no longer contains it would be a lie.
    expect(body).toContain("if (node === undefined) return null;");
  });
});
