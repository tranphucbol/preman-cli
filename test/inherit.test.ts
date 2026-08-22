import { describe, expect, it } from "vitest";
import { resolveScriptChain, type Protocol } from "@preman/core/scripts/chain.js";
import type { RequestEntry } from "@preman/core/workspace/collections.js";
import type { GroupDefinition, GroupKind } from "@preman/core/workspace/definitions.js";
import { resolveAuth } from "@preman/core/workspace/inherit.js";
import type { RequestAuth, RequestScript } from "@preman/core/workspace/schemas.js";

function group(
  kind: GroupKind,
  name: string,
  extras: { scripts?: RequestScript[]; auth?: RequestAuth } = {},
): GroupDefinition {
  return {
    path: name,
    name,
    kind,
    order: undefined,
    scripts: extras.scripts ?? [],
    auth: extras.auth,
    filePath: `/tmp/${name}/.resources/definition.yaml`,
  };
}

function script(type: string, code = "pm.variables.set('x', 1);"): RequestScript {
  return { type, code };
}

function chain(ancestors: GroupDefinition[], requestScripts: RequestScript[] | undefined, protocol: Protocol = "grpc") {
  return resolveScriptChain({ ancestors, requestScripts, protocol });
}

/** Only `ancestors` matters to `resolveAuth`; the rest is filler the type demands. */
function entryWith(ancestors: GroupDefinition[]): RequestEntry {
  return {
    filePath: "/tmp/Some.request.yaml",
    name: "Some",
    kind: "grpc-request",
    order: undefined,
    ancestors,
    collection: ancestors[0]?.name ?? "",
    folders: ancestors.slice(1).map((a) => a.name),
    path: [...ancestors.map((a) => a.name), "Some"].join("/"),
  };
}

describe("resolveScriptChain", () => {
  it("givenNoScriptsAnywhere_whenResolved_thenChainIsEmpty", () => {
    const result = chain([group("collection", "payment")], undefined);

    expect(result.scripts).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("givenCollectionAndFolderAndRequestScripts_whenResolved_thenOrderIsOuterToInner", () => {
    const result = chain(
      [
        group("collection", "payment", { scripts: [script("grpc:beforeInvoke", "// c")] }),
        group("folder", "nested", { scripts: [script("grpc:beforeInvoke", "// f")] }),
      ],
      [script("beforeInvoke", "// r")],
    );

    expect(result.scripts.map((s) => s.code)).toEqual(["// c", "// f", "// r"]);
    expect(result.scripts.map((s) => s.origin.label)).toEqual(["collection payment", "folder nested", "request"]);
    expect(result.warnings).toEqual([]);
  });

  it("givenPrefixedScript_whenProtocolMatches_thenEventIsStrippedAndRawTypeKept", () => {
    const result = chain([group("folder", "ZAS", { scripts: [script("http:beforeRequest")] })], undefined, "http");

    expect(result.scripts).toHaveLength(1);
    expect(result.scripts[0]?.event).toBe("beforerequest");
    expect(result.scripts[0]?.rawType).toBe("http:beforeRequest");
    expect(result.scripts[0]?.origin).toEqual({ level: "folder", label: "folder ZAS" });
  });

  it("givenGrpcPrefixedGroupScript_whenHttpRequestResolves_thenSkippedSilently", () => {
    const result = chain([group("folder", "mixed", { scripts: [script("grpc:beforeInvoke")] })], undefined, "http");

    expect(result.scripts).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("givenUnprefixedGroupScript_whenResolved_thenWarnsAndSkips", () => {
    const result = chain([group("folder", "ZAS", { scripts: [script("beforeRequest")] })], undefined, "http");

    expect(result.scripts).toEqual([]);
    expect(result.warnings).toEqual([
      'folder ZAS script type "beforeRequest" has no protocol prefix, so it was not run ' +
        '(expected "grpc:<event>" or "http:<event>")',
    ]);
  });

  it("givenUnknownPrefixInGroupScript_whenResolved_thenWarnsAndSkips", () => {
    const result = chain([group("collection", "payment", { scripts: [script("ws:beforeInvoke")] })], undefined);

    expect(result.scripts).toEqual([]);
    expect(result.warnings).toEqual([
      'collection payment script type "ws:beforeInvoke" has an unrecognised protocol prefix, ' +
        "so it was not run (known prefixes: grpc, http)",
    ]);
  });

  it("givenUnknownEventInGroupScript_whenResolved_thenWarnsAndSkips", () => {
    const result = chain([group("folder", "nested", { scripts: [script("grpc:onLunarEclipse")] })], undefined);

    expect(result.scripts).toEqual([]);
    expect(result.warnings[0]).toMatch(
      /^folder nested script type "grpc:onLunarEclipse" is not recognised, so it was not run \(known types: /,
    );
  });

  it("givenUnknownEventInRequestScript_whenResolved_thenWarningIsNotAttributed", () => {
    const result = chain([group("collection", "payment")], [script("onLunarEclipse")]);

    expect(result.warnings[0]).toMatch(/^script type "onLunarEclipse" is not recognised/);
  });

  it("givenPrefixedRequestScript_whenProtocolMatches_thenPrefixIsHonoured", () => {
    const result = chain([group("collection", "payment")], [script("grpc:afterResponse")], "grpc");

    expect(result.scripts.map((s) => s.event)).toEqual(["afterresponse"]);
  });

  it("givenPrefixedRequestScript_whenProtocolDiffers_thenSkippedSilently", () => {
    const result = chain([group("collection", "admin")], [script("grpc:afterResponse")], "http");

    expect(result.scripts).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("givenBlankCode_whenResolved_thenSkippedWithoutWarning", () => {
    const result = chain(
      [group("folder", "nested", { scripts: [script("grpc:beforeInvoke", "   \n")] })],
      [{ type: "beforeInvoke" }],
    );

    expect(result.scripts).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("givenMixedCaseAndPaddedType_whenResolved_thenNormalisedForMatching", () => {
    const result = chain([group("folder", "nested", { scripts: [script(" GRPC : BeforeInvoke ")] })], undefined);

    expect(result.scripts.map((s) => s.event)).toEqual(["beforeinvoke"]);
    expect(result.scripts[0]?.rawType).toBe(" GRPC : BeforeInvoke ");
  });
});

describe("resolveAuth", () => {
  const bearer: RequestAuth = { type: "bearer", credentials: { token: "{{jwt}}" } };
  const basic: RequestAuth = { type: "basic", credentials: { username: "u", password: "p" } };

  it("givenNoAuthAnywhere_whenResolved_thenUndefined", () => {
    expect(resolveAuth(entryWith([group("collection", "payment")]), undefined)).toBeUndefined();
  });

  it("givenRequestAuth_whenResolved_thenRequestWins", () => {
    const entry = entryWith([group("collection", "payment", { auth: basic })]);

    expect(resolveAuth(entry, bearer)).toEqual({ auth: bearer, origin: { level: "request", label: "request" } });
  });

  it("givenRequestNoauth_whenAncestorHasAuth_thenNoauthWins", () => {
    const entry = entryWith([group("collection", "payment", { auth: bearer })]);
    const noauth: RequestAuth = { type: "noauth" };

    expect(resolveAuth(entry, noauth)?.auth).toEqual(noauth);
  });

  it("givenFolderAuth_whenRequestHasNone_thenInheritedFromFolder", () => {
    const entry = entryWith([
      group("collection", "payment", { auth: basic }),
      group("folder", "nested", { auth: bearer }),
    ]);

    expect(resolveAuth(entry, undefined)).toEqual({
      auth: bearer,
      origin: { level: "folder", label: "folder nested" },
    });
  });

  it("givenOnlyCollectionAuth_whenFolderDeclaresNone_thenInheritedFromCollection", () => {
    const entry = entryWith([group("collection", "payment", { auth: basic }), group("folder", "nested")]);

    expect(resolveAuth(entry, undefined)).toEqual({
      auth: basic,
      origin: { level: "collection", label: "collection payment" },
    });
  });
});
