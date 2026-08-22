import { parseStringPromise } from "xml2js";
import { describe, expect, it } from "vitest";
import { escapeXml, renderXml } from "@preman/cli/reporters/xml.js";

describe("escapeXml", () => {
  it("givenAmpersandAndAngles_whenEscape_thenEntitiesEmitted", () => {
    expect(escapeXml("a < b & c > d")).toBe("a &lt; b &amp; c &gt; d");
  });

  it("givenControlCharacter_whenEscape_thenStripped", () => {
    expect(escapeXml("before\u0000\u0008\tafter")).toBe("before\tafter");
  });
});

describe("renderXml", () => {
  it("givenQuotesInAttribute_whenRender_thenEscaped", () => {
    expect(renderXml({ name: "node", attributes: { value: `"quoted" and 'single'` } })).toContain(
      'value="&quot;quoted&quot; and &apos;single&apos;"',
    );
  });

  it("givenNestedElements_whenRender_thenWellFormed", async () => {
    const xml = renderXml({ name: "root", children: [{ name: "child", text: "value" }] });
    await expect(parseStringPromise(xml)).resolves.toMatchObject({ root: { child: ["value"] } });
  });

  it("givenUndefinedAttribute_whenRender_thenOmitted", () => {
    expect(renderXml({ name: "node", attributes: { present: 1, absent: undefined } })).toBe('<node present="1"/>');
  });
});
