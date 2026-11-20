/**
 * The find bar's arithmetic: what the counter says, what the bar opens with, where typing lands.
 *
 * All of it is a function of an `EditorState` and a `SearchQuery`, so it runs here against
 * CodeMirror's real search cursor rather than a mounted editor. Plan 023 is why there is one bar
 * to test rather than two.
 */
import { SearchQuery } from "@codemirror/search";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";

import {
  FIND_COUNT_CAP,
  PREFILL_MAX_CHARS,
  countMatches,
  counterText,
  nearestMatch,
  openingQuery,
} from "@preman/desktop/renderer/model/find.js";
import { editability } from "@preman/desktop/renderer/ui/findPanel.js";

const THREE_HITS = "id one id two id";
const HIT = "id";
/** Between the first hit and the second, on no hit at all. */
const BETWEEN_FIRST_AND_SECOND = 4;
const SECOND_HIT_FROM = 7;
const PREVIOUS = "earlier";
const CAP_OVERFLOW = 5;

function stateOf(doc: string, anchor = 0, head = anchor): EditorState {
  return EditorState.create({ doc, selection: EditorSelection.single(anchor, head) });
}

function literal(search: string, options: Partial<{ caseSensitive: boolean; wholeWord: boolean }> = {}) {
  return new SearchQuery({ search, literal: true, caseSensitive: true, ...options });
}

describe("the find counter", () => {
  it("givenThreeHits_whenCaretBeforeTheSecond_thenCounterReadsQuestionOfThree", () => {
    const count = countMatches(stateOf(THREE_HITS, BETWEEN_FIRST_AND_SECOND), literal(HIT));

    expect(counterText(count)).toBe("?/3");
  });

  it("givenSelectionOnSecondHit_whenCounted_thenCounterReadsTwoOfThree", () => {
    const state = stateOf(THREE_HITS, SECOND_HIT_FROM, SECOND_HIT_FROM + HIT.length);

    expect(counterText(countMatches(state, literal(HIT)))).toBe("2/3");
  });

  it("givenNoHits_whenCounted_thenCounterReadsZeroOfZero", () => {
    expect(counterText(countMatches(stateOf(THREE_HITS), literal("absent")))).toBe("0/0");
  });

  it("givenMoreHitsThanTheCap_whenCounted_thenCounterReadsTheCapPlus", () => {
    const doc = "x".repeat(FIND_COUNT_CAP + CAP_OVERFLOW);

    const count = countMatches(stateOf(doc), literal("x"));

    expect(count?.capped).toBe(true);
    expect(count?.total).toBe(FIND_COUNT_CAP);
    expect(counterText(count)).toBe("?/10,000+");
  });

  it("givenInvalidRegex_whenCounted_thenCountIsInvalidAndCounterSaysSo", () => {
    const count = countMatches(stateOf(THREE_HITS), new SearchQuery({ search: "(", regexp: true }));

    expect(count?.invalid).toBe(true);
    expect(counterText(count)).toBe("Invalid regex");
  });

  it("givenMatchCaseOff_whenCounted_thenDifferentCaseCounts", () => {
    const state = stateOf("Id id ID");

    expect(countMatches(state, literal(HIT, { caseSensitive: false }))?.total).toBe(3);
    expect(countMatches(state, literal(HIT))?.total).toBe(1);
  });

  it("givenWholeWord_whenQueryIsInsideALongerWord_thenItDoesNotCount", () => {
    const state = stateOf("id trans_id identity");

    expect(countMatches(state, literal(HIT, { wholeWord: true }))?.total).toBe(1);
  });
});

describe("the query the bar opens with", () => {
  it("givenShortSingleLineSelection_whenOpening_thenItIsTheQuery", () => {
    const state = stateOf(THREE_HITS, SECOND_HIT_FROM, SECOND_HIT_FROM + HIT.length);

    expect(openingQuery(state, PREVIOUS)).toBe(HIT);
  });

  it("givenMultiLineSelection_whenOpening_thenThePreviousQueryIsKept", () => {
    const doc = "first\nsecond";

    expect(openingQuery(stateOf(doc, 0, doc.length), PREVIOUS)).toBe(PREVIOUS);
  });

  it("givenSelectionLongerThanPrefillMax_whenOpening_thenThePreviousQueryIsKept", () => {
    const doc = "a".repeat(PREFILL_MAX_CHARS + 1);

    expect(openingQuery(stateOf(doc, 0, doc.length), PREVIOUS)).toBe(PREVIOUS);
  });
});

describe("where typing lands", () => {
  it("givenCaretAfterTheLastHit_whenNearestMatch_thenItWrapsToTheFirst", () => {
    const state = stateOf(THREE_HITS, THREE_HITS.length);

    expect(nearestMatch(state, literal(HIT), THREE_HITS.length)).toEqual({ from: 0, to: HIT.length });
  });
});

describe("a read-only editor", () => {
  it("givenReadOnlyEditor_whenExtensionsBuilt_thenContentIsFocusable", () => {
    // Without it the content is `contenteditable=false` with no tabindex: it never holds focus,
    // so `Cmd+F` in a response body reached no keymap at all.
    const readOnly = EditorState.create({ extensions: editability(true) });
    const editable = EditorState.create({ extensions: editability(false) });

    expect(readOnly.facet(EditorView.contentAttributes)).toContainEqual({ tabindex: "0" });
    expect(editable.facet(EditorView.contentAttributes)).not.toContainEqual({ tabindex: "0" });
  });
});
