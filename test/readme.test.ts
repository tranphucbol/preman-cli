import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { concatList } from "./app/media/timeline.js";

const REPO_ROOT = resolve(import.meta.dirname, "..");
/** Every Markdown file a reader reaches from the README without leaving the repository. */
const DOCUMENTS = ["README.md"];
/** `[text](target)` and `<img src="target">`; a target with a scheme or a bare anchor is not a file. */
const LINK_PATTERNS = [/\]\(([^)\s]+)\)/g, /\bsrc="([^"]+)"/g];
const EXTERNAL = /^(?:[a-z]+:|#)/i;

function relativeTargets(document: string): string[] {
  const text = readFileSync(join(REPO_ROOT, document), "utf8");
  return LINK_PATTERNS.flatMap((pattern) => [...text.matchAll(pattern)].map((match) => match[1] ?? ""))
    .filter((target) => target !== "" && !EXTERNAL.test(target))
    .map((target) => target.split("#")[0] ?? target);
}

describe("the README's media timeline", () => {
  it("givenFramesWithGaps_whenListed_thenEachLastsUntilTheNext", () => {
    const list = concatList(
      [
        { file: "a.png", timestamp: 10 },
        { file: "b.png", timestamp: 10.5 },
        { file: "c.png", timestamp: 12 },
      ],
      12.25,
    );

    expect(list.script).toBe(
      [
        "ffconcat version 1.0",
        "file 'a.png'",
        "duration 0.500",
        "file 'b.png'",
        "duration 1.500",
        "file 'c.png'",
        "duration 0.250",
        "file 'c.png'",
        "",
      ].join("\n"),
    );
    expect(list.seconds).toBeCloseTo(2.25);
  });

  it("givenAnEndAfterTheLastFrame_whenListed_thenTheLastFrameHoldsUntilTheEnd", () => {
    expect(concatList([{ file: "a.png", timestamp: 1 }], 4).seconds).toBeCloseTo(3);
    // An end at the last frame still shows it, for the shortest time ffmpeg keeps.
    expect(concatList([{ file: "a.png", timestamp: 1 }], 1).seconds).toBeCloseTo(0.1);
  });

  it("givenAMaxFrameLength_whenListed_thenLongFramesAreCapped", () => {
    const list = concatList(
      [
        { file: "a.png", timestamp: 0 },
        { file: "b.png", timestamp: 10 },
      ],
      11,
      2,
    );

    expect(list.script).toContain("file 'a.png'\nduration 2.000");
    expect(list.seconds).toBeCloseTo(3);
  });

  it("givenAQuoteInAFileName_whenListed_thenItIsEscaped", () => {
    expect(concatList([{ file: "it's.png", timestamp: 0 }], 1).script).toContain(`file 'it'\\''s.png'`);
  });

  it("givenNoFrames_whenListed_thenItThrows", () => {
    expect(() => concatList([], 1)).toThrow(/no frames/);
  });
});

describe("the README's links", () => {
  it("givenTheReadme_whenItsLinksAreRead_thenEveryRelativeTargetExists", () => {
    const missing = DOCUMENTS.flatMap((document) =>
      relativeTargets(document)
        .filter((target) => !existsSync(resolve(REPO_ROOT, dirname(document), target)))
        .map((target) => `${document} -> ${target}`),
    );

    expect(missing).toEqual([]);
  });
});
