/**
 * `{{token}}` in a JSON body, and the parse it used to wreck.
 *
 * The bug these guard against was not subtle once it was seen: a single bare token retagged every
 * key after it, because the token's own braces swallowed the one that should have closed the
 * enclosing object. So the assertions are mostly about nodes *after* a token rather than about the
 * token itself — the token was never the part that looked wrong.
 */
import { describe, expect, it } from "vitest";

import {
  NOTHING_ASKED,
  jsonTemplate,
  maskTemplates,
  unresolvedDiagnostics,
} from "@preman/desktop/renderer/ui/template.js";

const parser = jsonTemplate().language.parser;

/** What a real gRPC message looks like: tokens bare in a numeric field and quoted in a string one. */
const AUTHORED_BODY = `{
  "app_id": {{ac_fee_app_id}},
  "app_trans_id": "{{ac_app_trans_id}}",
  "payment_type": "PAYMENT",
  "dest_asset": {
    "dest_asset_type": "MERCHANT",
    "merchant": { "app_id": {{ac_fee_app_id}} }
  }
}`;

interface Nodes {
  readonly errors: number;
  readonly properties: string[];
  readonly strings: string[];
}

function nodes(doc: string): Nodes {
  const cursor = parser.parse(doc).cursor();
  let errors = 0;
  const properties: string[] = [];
  const strings: string[] = [];

  do {
    if (cursor.name === "⚠") errors += 1;
    if (cursor.name === "PropertyName") properties.push(doc.slice(cursor.from, cursor.to));
    if (cursor.name === "String") strings.push(doc.slice(cursor.from, cursor.to));
  } while (cursor.next());

  return { errors, properties, strings };
}

describe("masking a template body", () => {
  it("givenAnyToken_whenMasked_thenTheTextIsExactlyAsLongAsItWas", () => {
    for (const token of ["{{}}", "{{x}}", "{{ac_fee_app_id}}", "{{a.b.c}}"]) {
      expect(maskTemplates(token)).toHaveLength(token.length);
    }
  });

  it("givenAToken_whenMasked_thenItBecomesAParsableNumber", () => {
    const masked = maskTemplates("{{ac_fee_app_id}}");

    expect(masked).toBe("0.000000000000000");
    expect(Number.isNaN(Number(masked))).toBe(false);
  });

  it("givenTextWithoutTokens_whenMasked_thenNothingChanges", () => {
    const literal = `{ "a": 1, "b": "brace } inside a string" }`;

    expect(maskTemplates(literal)).toBe(literal);
  });

  it("givenTokensAtBothEnds_whenMasked_thenOnlyTheTokensMove", () => {
    expect(maskTemplates(`prefix-{{id}}-suffix`)).toBe("prefix-0.0000-suffix");
  });
});

describe("parsing a template body", () => {
  it("givenABareToken_whenParsed_thenThereAreNoErrorNodes", () => {
    expect(nodes(AUTHORED_BODY).errors).toBe(0);
  });

  it("givenABareToken_whenParsed_thenEveryKeyAfterItIsStillAKey", () => {
    // This is the whole bug. Before masking, only "app_id" survived as a PropertyName and the
    // rest were tagged as strings, which is why they changed colour halfway down the document.
    expect(nodes(AUTHORED_BODY).properties).toStrictEqual([
      '"app_id"',
      '"app_trans_id"',
      '"payment_type"',
      '"dest_asset"',
      '"dest_asset_type"',
      '"merchant"',
      '"app_id"',
    ]);
  });

  it("givenABareToken_whenParsed_thenOnlyRealStringsAreStrings", () => {
    expect(nodes(AUTHORED_BODY).strings).toStrictEqual(['"{{ac_app_trans_id}}"', '"PAYMENT"', '"MERCHANT"']);
  });

  it("givenAQuotedToken_whenParsed_thenItIsOneStringAndNotAnObject", () => {
    const { errors, strings } = nodes(`{ "id": "{{ac_app_trans_id}}" }`);

    expect(errors).toBe(0);
    expect(strings).toStrictEqual(['"{{ac_app_trans_id}}"']);
  });

  it("givenATokenFollowedByDigits_whenParsed_thenTheNumberIsStillOneNumber", () => {
    // `{{id}}1` masks to `0.00001`, which is the case in the report that started this.
    expect(nodes(`{ "app_id": {{ac_fee_app_id}}1, "next": 2 }`).properties).toStrictEqual(['"app_id"', '"next"']);
  });

  it("givenACommentedOutField_whenParsed_thenThereAreNoErrorNodes", () => {
    // Decision 047 made the engine send this body. Before the comment mask the grammar met a `/`
    // where a property name belongs, so the editor called a body the engine was happy with broken.
    const commented = ["{", '  "amount": "100",', '  // "request_time": "",', '  "type": "BT_FREEZE"', "}"].join("\n");

    const { errors, properties } = nodes(commented);

    expect(errors).toBe(0);
    expect(properties).toStrictEqual(['"amount"', '"type"']);
  });

  it("givenACommentedOutFieldHoldingAToken_whenParsed_thenBothMasksApply", () => {
    const { errors, properties } = nodes(`{\n  // "id": {{app_id}},\n  "n": {{app_id}}\n}`);

    expect(errors).toBe(0);
    expect(properties).toStrictEqual(['"n"']);
  });

  it("givenCommentMarkersInsideAString_whenParsed_thenTheStringIsIntact", () => {
    const { errors, strings } = nodes(`{ "url": "https://h//p" }`);

    expect(errors).toBe(0);
    expect(strings).toStrictEqual(['"https://h//p"']);
  });

  it("givenPlainJson_whenParsed_thenItParsesExactlyAsJsonWould", () => {
    const { errors, properties, strings } = nodes(`{ "a": 1, "b": [true, null], "c": "text" }`);

    expect(errors).toBe(0);
    expect(properties).toStrictEqual(['"a"', '"b"', '"c"']);
    expect(strings).toStrictEqual(['"text"']);
  });
});

/**
 * The linter, as the pure function it is deliberately split into: there is no DOM here, so an
 * `EditorView` is not something these tests can build, and the diagnostics are the whole of it.
 */
describe("linting a template body", () => {
  const LOCAL = { names: new Set(["greetng"]), environment: "LOCAL" };

  it("givenUnresolvedName_whenLinted_thenOneWarningPerOccurrence", () => {
    const doc = `{ "a": "{{greetng}}", "b": "{{ greetng }}" }`;

    const found = unresolvedDiagnostics(doc, LOCAL);

    expect(found).toHaveLength(2);
    expect(found.map((one) => one.severity)).toStrictEqual(["warning", "warning"]);
    expect(found[0]?.message).toBe("{{greetng}} is not defined in LOCAL");
    // The span covers the braces too, not just the name: the underline is on the token.
    expect(doc.slice(found[0]?.from, found[0]?.to)).toBe("{{greetng}}");
    expect(doc.slice(found[1]?.from, found[1]?.to)).toBe("{{ greetng }}");
  });

  it("givenResolvedName_whenLinted_thenNoDiagnostic", () => {
    expect(unresolvedDiagnostics(`{ "a": "{{greeting}}" }`, LOCAL)).toStrictEqual([]);
  });

  it("givenNoResolverAnswerYet_whenLinted_thenNothingIsReported", () => {
    // The state an editor whose Preview was never opened stays in, and the reason a keystroke
    // never costs a round trip.
    expect(unresolvedDiagnostics(`{ "a": "{{greetng}}" }`, NOTHING_ASKED)).toStrictEqual([]);
  });

  it("givenLintedDocument_whenMaskIsRead_thenMaskingIsUnchanged", () => {
    // Decision 23's mask is load-bearing and the linter compiles its own pattern, so a document
    // the linter has an opinion about must still parse exactly as it did before.
    const doc = `{ "app_id": {{greetng}}, "next": 2 }`;

    expect(unresolvedDiagnostics(doc, LOCAL)).toHaveLength(1);
    expect(maskTemplates(doc)).toHaveLength(doc.length);
    expect(nodes(doc).properties).toStrictEqual(['"app_id"', '"next"']);
  });
});
