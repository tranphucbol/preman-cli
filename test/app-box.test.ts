import { describe, expect, it } from "vitest";
import { APP_SUITE, boxCommand, MEDIA_SUITE, parseBoxArguments } from "./app/docker/command.js";

describe("the Linux box's command", () => {
  it("givenNoArguments_whenParsed_thenTheSmokeSuiteRuns", () => {
    expect(parseBoxArguments([])).toEqual({ media: null, tests: [APP_SUITE], options: [] });
  });

  it("givenMediaFlag_whenParsed_thenTheReadmeSuiteRunsWithItsGate", () => {
    expect(parseBoxArguments(["--media"])).toEqual({ media: "1", tests: [MEDIA_SUITE], options: [] });
    expect(parseBoxArguments(["--media=send,palette"]).media).toBe("send,palette");
    expect(boxCommand(parseBoxArguments(["--media=send"]))).toContain("PREMAN_APP=1 PREMAN_README_MEDIA='send' ");
  });

  it("givenOptionsAndPaths_whenParsed_thenOptionsFollowThePaths", () => {
    const run = parseBoxArguments(["test/app/smoke.test.ts", "-t", "palette"]);

    expect(run).toEqual({ media: null, tests: ["test/app/smoke.test.ts"], options: ["-t", "palette"] });
    expect(boxCommand(parseBoxArguments(["test/app/smoke.test.ts", "--bail=1"]))).toBe(
      "bun run --filter '@preman/desktop' build && PREMAN_APP=1 bunx vitest run 'test/app/smoke.test.ts' --no-file-parallelism '--bail=1'",
    );
  });

  it("givenAnArgumentWithAQuote_whenCommandBuilt_thenItIsSingleQuoted", () => {
    expect(boxCommand(parseBoxArguments(["it's.test.ts"]))).toContain(`'it'\\''s.test.ts'`);
  });
});
