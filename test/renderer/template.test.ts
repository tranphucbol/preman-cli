/**
 * `{{token}}` in a JSON body, and the parse it used to wreck.
 *
 * The bug these guard against was not subtle once it was seen: a single bare token retagged every
 * key after it, because the token's own braces swallowed the one that should have closed the
 * enclosing object. So the assertions are mostly about nodes *after* a token rather than about the
 * token itself — the token was never the part that looked wrong.
 */
import { describe, expect, it } from "vitest";

import { jsonTemplate, maskTemplates } from "@preman/desktop/renderer/ui/template.js";

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

  it("givenPlainJson_whenParsed_thenItParsesExactlyAsJsonWould", () => {
    const { errors, properties, strings } = nodes(`{ "a": 1, "b": [true, null], "c": "text" }`);

    expect(errors).toBe(0);
    expect(properties).toStrictEqual(['"a"', '"b"', '"c"']);
    expect(strings).toStrictEqual(['"text"']);
  });
});
