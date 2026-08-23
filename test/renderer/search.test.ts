/**
 * Where a search hit sends the editor.
 *
 * The engine answers with a field path because that is what it can honestly say about a YAML
 * document; `sectionFor` is the table that turns one into a place to look. Two answers are
 * deliberate and are what these tests pin: `undefined` means "leave the sub-tab alone" for fields
 * the bar already shows, and the YAML tab is the fallback rather than a failure.
 */
import { describe, expect, it } from "vitest";

import { describeFieldPath, sectionFor } from "@preman/desktop/renderer/model/search.js";

describe("choosing the sub-tab a hit opens on", () => {
  it("givenFieldTheBarAlreadyShows_whenSectioned_thenTheCurrentSubTabIsLeftAlone", () => {
    // Switching away from whatever the user was editing to reveal something that was never
    // hidden is the worse of the two outcomes.
    expect(sectionFor(["url"])).toBeUndefined();
    expect(sectionFor(["method"])).toBeUndefined();
    expect(sectionFor(["methodPath"])).toBeUndefined();
  });

  it("givenMappedField_whenSectioned_thenItsOwnSubTabIsChosen", () => {
    expect(sectionFor(["headers", 0, "key"])).toBe("headers");
    expect(sectionFor(["auth", "type"])).toBe("auth");
    expect(sectionFor(["scripts", 0, "code"])).toBe("scripts");
  });

  it("givenProtocolSpecificTwinFields_whenSectioned_thenBothLandOnTheSameSubTab", () => {
    // The editor shows whichever the protocol has there, so the pair has to agree.
    expect(sectionFor(["queryParams", 1, "value"])).toBe(sectionFor(["metadata", 1, "value"]));
    expect(sectionFor(["body", "raw"])).toBe(sectionFor(["message"]));
  });

  it("givenUnmappedField_whenSectioned_thenTheYamlTabTakesIt", () => {
    expect(sectionFor(["variables", 0, "key"])).toBe("yaml");
  });

  it("givenPathThatStartsWithAnIndex_whenSectioned_thenTheYamlTabTakesIt", () => {
    // A sequence at the document root is not a field this table knows how to place.
    expect(sectionFor([0, "key"])).toBe("yaml");
    expect(sectionFor([])).toBe("yaml");
  });
});

describe("describing a field path for a result row", () => {
  it("givenPathWithIndices_whenDescribed_thenItReadsAsOneToken", () => {
    expect(describeFieldPath(["scripts", 0, "code"])).toBe("scripts.0.code");
  });

  it("givenEmptyPath_whenDescribed_thenNothingIsInvented", () => {
    expect(describeFieldPath([])).toBe("");
  });
});
