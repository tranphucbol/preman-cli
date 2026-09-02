/**
 * Script-slot resolution in the renderer's request model.
 *
 * `readScripts` has to find a request's script by every `type` spelling core's
 * `packages/core/src/scripts/chain.ts` accepts for that phase (case-insensitively) - not just
 * the one literal label this editor writes for a new slot - or a request authored by the
 * Postman filesystem format (which spells the post-call phase `afterResponse`, not `test`)
 * shows an empty "After response" tab even though the script exists and core runs it fine.
 */
import { describe, expect, it } from "vitest";

import {
  editScript,
  GRPC_SCRIPT_TYPES,
  HTTP_SCRIPT_TYPES,
  readScripts,
  type ScriptSlot,
} from "@preman/desktop/renderer/model/request.js";

function scriptsOf(entries: ReadonlyArray<{ type: string; code: string }>): unknown {
  return { scripts: entries.map((entry) => ({ ...entry, language: "javascript" })) };
}

function slotOf(slots: readonly ScriptSlot[], type: string): ScriptSlot {
  const slot = slots.find((candidate) => candidate.type === type);
  if (slot === undefined) throw new Error(`no "${type}" slot in ${JSON.stringify(slots)}`);
  return slot;
}

describe("readScripts", () => {
  it("givenAfterResponseTypeOnGrpcRequest_whenRead_thenFillsTheTestSlot", () => {
    const data = scriptsOf([{ type: "afterResponse", code: "pm.test('x', () => {});" }]);

    const slots = readScripts(data, GRPC_SCRIPT_TYPES);

    const test = slotOf(slots, "test");
    expect(test.code).toBe("pm.test('x', () => {});");
    expect(test.at).toBe(0);
  });

  it("givenBeforeRequestTypeOnHttpRequest_whenRead_thenFillsThePrerequestSlot", () => {
    const data = scriptsOf([{ type: "beforeRequest", code: "pm.environment.set('a', '1');" }]);

    const slots = readScripts(data, HTTP_SCRIPT_TYPES);

    const pre = slotOf(slots, "prerequest");
    expect(pre.code).toBe("pm.environment.set('a', '1');");
    expect(pre.at).toBe(0);
  });

  it("givenPostResponseTypeOnHttpRequest_whenRead_thenFillsTheTestSlot", () => {
    const data = scriptsOf([{ type: "post-response", code: "pm.test('y', () => {});" }]);

    const slots = readScripts(data, HTTP_SCRIPT_TYPES);

    expect(slotOf(slots, "test").code).toBe("pm.test('y', () => {});");
  });

  it("givenMixedCaseType_whenRead_thenStillMatches", () => {
    const data = scriptsOf([{ type: "AfterResponse", code: "1;" }]);

    expect(slotOf(readScripts(data, GRPC_SCRIPT_TYPES), "test").code).toBe("1;");
  });

  it("givenNoScripts_whenRead_thenEveryCanonicalSlotIsEmptyAndUnindexed", () => {
    const slots = readScripts({}, GRPC_SCRIPT_TYPES);

    expect(slots.map((slot) => slot.type)).toStrictEqual(["beforeInvoke", "test"]);
    for (const slot of slots) {
      expect(slot.code).toBe("");
      expect(slot.at).toBeNull();
    }
  });

  it("givenUnrelatedScriptType_whenRead_thenTheSlotStaysUnfilled", () => {
    const data = scriptsOf([{ type: "onMessage", code: "1;" }]);

    expect(slotOf(readScripts(data, GRPC_SCRIPT_TYPES), "test").at).toBeNull();
  });
});

describe("editScript", () => {
  it("givenAnAliasedExistingSlot_whenEdited_thenPatchesItInPlaceRatherThanAppending", () => {
    const data = scriptsOf([{ type: "afterResponse", code: "old();" }]);
    const slot = slotOf(readScripts(data, GRPC_SCRIPT_TYPES), "test");

    const edits = editScript(data, slot, "new();");

    // A fix that stopped matching the alias would instead append a second `test` entry at
    // index 1, leaving both scripts in the file and both running on every invocation.
    expect(edits).toStrictEqual([{ path: ["scripts", 0, "code"], value: "new();" }]);
  });

  it("givenNoExistingSlot_whenEdited_thenAppendsOneUnderTheCanonicalType", () => {
    const data = scriptsOf([]);
    const slot = slotOf(readScripts(data, GRPC_SCRIPT_TYPES), "test");

    const edits = editScript(data, slot, "new();");

    expect(edits).toStrictEqual([
      { path: ["scripts", 0], value: { type: "test", language: "javascript", code: "new();" } },
    ]);
  });
});
