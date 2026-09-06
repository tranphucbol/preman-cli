/**
 * The renderer's auth model.
 *
 * Two of the cases here are conformance checks rather than unit tests, and they are the reason
 * this file imports `@preman/core` at all: `AUTH_SCHEMES` is a hand copy of
 * `SUPPORTED_AUTH_TYPES` and `inheritedAuth` is a hand copy of `resolveAuth`, because the
 * renderer may not import core and neither original is a type. A copy that cannot drift is the
 * most that fence allows, and these are what stop it.
 *
 * The rest is the shape rule. `auth.credentials` is a YAML map in hand-written files and a
 * Postman-style array in migrated ones, and core reads both — so the editor must read both and
 * write back the one it found. Reading only the map form is what made a migrated request show an
 * empty Auth tab while authenticating fine on the wire; writing only the map form would have
 * turned that into losing every other credential on the first keystroke.
 */
import { describe, expect, it } from "vitest";

import { SUPPORTED_AUTH_TYPES } from "@preman/core/auth/credentials.js";
import { buildCatalog } from "@preman/core/api/catalog.js";
import { listRequests } from "@preman/core/workspace/collections.js";
import { requireWorkspace } from "@preman/core/workspace/discover.js";
import { resolveAuth } from "@preman/core/workspace/inherit.js";
import { applyAuth } from "@preman/core/http/auth.js";
import { VariableStore } from "@preman/core/vars/store.js";
import type { CatalogNode } from "@preman/desktop/engine/protocol.js";
import {
  AUTH_SCHEMES,
  authOverride,
  credentialValue,
  editAuthChoice,
  editCredential,
  editCredentialRemoved,
  hasCredentials,
  inheritedAuth,
  readAuth,
  schemeLabel,
} from "@preman/desktop/renderer/model/auth.js";
import { project } from "@preman/desktop/renderer/model/request.js";
import { FIXTURE_HTTP_WS, FIXTURE_WS } from "../helpers.js";

function authOf(data: unknown): Record<string, unknown> | undefined {
  return (data as { auth?: Record<string, unknown> }).auth;
}

function credentialsOf(data: unknown): unknown {
  return authOf(data)?.credentials;
}

function node(over: Partial<CatalogNode>): CatalogNode {
  return { id: "x", kind: "folder", name: "x", file: "/x", parentId: null, depth: 0, order: 0, ...over };
}

describe("AUTH_SCHEMES", () => {
  it("givenTheRendererSchemeList_whenComparedToCore_thenTheyAreIdentical", () => {
    expect([...AUTH_SCHEMES]).toEqual([...SUPPORTED_AUTH_TYPES]);
  });
});

describe("readAuth", () => {
  it("givenNoAuthKey_whenRead_thenTheChoiceIsInherit", () => {
    expect(readAuth({ $kind: "http-request" }).choice).toEqual({ kind: "inherit" });
  });

  it("givenAnEmptyType_whenRead_thenTheChoiceIsNoauth", () => {
    expect(readAuth({ auth: { type: "" } }).choice).toEqual({ kind: "scheme", scheme: "noauth" });
  });

  it("givenNoTypeButABlock_whenRead_thenTheChoiceIsNoauthRatherThanInherit", () => {
    expect(readAuth({ auth: { credentials: { token: "t" } } }).choice).toEqual({ kind: "scheme", scheme: "noauth" });
  });

  it("givenAnUppercaseBearer_whenRead_thenTheSchemeIsBearer", () => {
    expect(readAuth({ auth: { type: " Bearer " } }).choice).toEqual({ kind: "scheme", scheme: "bearer" });
  });

  it("givenAnOauth2Type_whenRead_thenTheChoiceIsUnsupportedAndKeepsTheAuthoredString", () => {
    expect(readAuth({ auth: { type: "OAuth2" } }).choice).toEqual({ kind: "unsupported", type: "OAuth2" });
  });

  it("givenMapShapedCredentials_whenRead_thenTheNamedFieldsCarryTheirValues", () => {
    const block = readAuth({ auth: { type: "bearer", credentials: { token: "{{jwt}}" } } });

    expect(block.shape).toBe("map");
    expect(credentialValue(block, "token")).toBe("{{jwt}}");
    expect(block.extra).toEqual([]);
  });

  it("givenArrayShapedCredentials_whenRead_thenTheNamedFieldsCarryTheirValues", () => {
    const block = readAuth({
      auth: { type: "bearer", credentials: [{ key: "token", value: "{{jwt}}" }] },
    });

    expect(block.shape).toBe("array");
    expect(credentialValue(block, "token")).toBe("{{jwt}}");
  });

  it("givenABasicBlock_whenRead_thenBothNamedFieldsArePresentEvenWhenTheFileHasNeither", () => {
    const block = readAuth({ auth: { type: "basic" } });

    expect(block.named.map((pair) => pair.key)).toEqual(["username", "password"]);
    expect(credentialValue(block, "username")).toBe("");
  });

  it("givenApikeyWithNoIn_whenRead_thenTheFieldReadsAsEmptyAndTheFormDefaultsIt", () => {
    const block = readAuth({ auth: { type: "apikey", credentials: { key: "X-Api-Key", value: "v" } } });

    expect(block.named.map((pair) => pair.key)).toEqual(["key", "value", "in"]);
    expect(credentialValue(block, "in")).toBe("");
  });

  it("givenAnOauth2Block_whenRead_thenItsCredentialsAreExtraAndNotDropped", () => {
    const block = readAuth({ auth: { type: "oauth2", credentials: { accessToken: "abc" } } });

    expect(block.extra.map((pair) => pair.key)).toEqual(["accessToken"]);
  });

  it("givenABearerBlockWithAnUnreadKey_whenRead_thenItIsExtraRatherThanHidden", () => {
    const block = readAuth({ auth: { type: "bearer", credentials: { token: "t", accessToken: "a" } } });

    expect(block.extra.map((pair) => pair.key)).toEqual(["accessToken"]);
  });
});

describe("hasCredentials", () => {
  it("givenABlockWithOnlyAType_whenAsked_thenThereIsNothingToLose", () => {
    expect(hasCredentials(readAuth({ auth: { type: "bearer" } }))).toBe(false);
  });

  it("givenABlockWithAToken_whenAsked_thenThereIsSomethingToLose", () => {
    expect(hasCredentials(readAuth({ auth: { type: "bearer", credentials: { token: "t" } } }))).toBe(true);
  });
});

describe("editAuthChoice", () => {
  it("givenInherit_whenChosen_thenTheWholeBlockIsDeleted", () => {
    const data = { auth: { type: "bearer", credentials: { token: "t" } } };

    const next = project(data, [...editAuthChoice({ kind: "inherit" })]);

    expect(authOf(next)).toBeUndefined();
  });

  it("givenABearerBlock_whenTheSchemeBecomesBasic_thenTheTokenIsStillInTheFile", () => {
    const data = { auth: { type: "bearer", credentials: { token: "t" } } };

    const next = project(data, [...editAuthChoice({ kind: "scheme", scheme: "basic" })]);

    expect(authOf(next)?.type).toBe("basic");
    expect(credentialsOf(next)).toEqual({ token: "t" });
    expect(readAuth(next).extra.map((pair) => pair.key)).toEqual(["token"]);
  });

  it("givenTheUnsupportedTypeAlreadyInTheFile_whenReSelected_thenNothingIsWritten", () => {
    expect(editAuthChoice({ kind: "unsupported", type: "oauth2" })).toEqual([]);
  });
});

describe("editCredential", () => {
  it("givenMapShapedCredentials_whenOneIsEdited_thenTheBlockIsStillAMap", () => {
    const data = { auth: { type: "bearer", credentials: { token: "old", scope: "read" } } };
    const block = readAuth(data);

    const next = project(data, [...editCredential(block, "token", "new")]);

    expect(credentialsOf(next)).toEqual({ token: "new", scope: "read" });
  });

  it("givenArrayShapedCredentials_whenOneIsEdited_thenTheOthersSurvive", () => {
    const data = {
      auth: {
        type: "apikey",
        credentials: [
          { key: "key", value: "X-Api-Key" },
          { key: "value", value: "old" },
          { key: "in", value: "header" },
        ],
      },
    };
    const block = readAuth(data);

    const next = project(data, [...editCredential(block, "value", "new")]);

    expect(credentialsOf(next)).toEqual([
      { key: "key", value: "X-Api-Key" },
      { key: "value", value: "new" },
      { key: "in", value: "header" },
    ]);
  });

  it("givenArrayShapedCredentials_whenANewKeyIsAdded_thenTheBlockIsStillAnArray", () => {
    const data = { auth: { type: "basic", credentials: [{ key: "username", value: "u" }] } };
    const block = readAuth(data);

    const next = project(data, [...editCredential(block, "password", "p")]);

    expect(credentialsOf(next)).toEqual([
      { key: "username", value: "u" },
      { key: "password", value: "p" },
    ]);
  });

  it("givenAnArrayEntryWithExtraKeys_whenAnotherIsAdded_thenTheExtraKeysSurvive", () => {
    const data = { auth: { type: "basic", credentials: [{ key: "username", value: "u", type: "string" }] } };
    const block = readAuth(data);

    const next = project(data, [...editCredential(block, "password", "p")]);

    expect(credentialsOf(next)).toEqual([
      { type: "string", key: "username", value: "u" },
      { key: "password", value: "p" },
    ]);
  });

  it("givenNoCredentialsBlock_whenOneIsWritten_thenItIsAMap", () => {
    const data = { auth: { type: "bearer" } };
    const block = readAuth(data);

    const next = project(data, [...editCredential(block, "token", "{{jwt}}")]);

    expect(credentialsOf(next)).toEqual({ token: "{{jwt}}" });
  });
});

describe("editCredentialRemoved", () => {
  it("givenMapShapedCredentials_whenOneIsRemoved_thenOnlyThatKeyGoes", () => {
    const data = { auth: { type: "bearer", credentials: { token: "t", scope: "read" } } };
    const block = readAuth(data);
    const scope = block.extra[0]!;

    const next = project(data, [...editCredentialRemoved(block, scope)]);

    expect(credentialsOf(next)).toEqual({ token: "t" });
  });

  it("givenArrayShapedCredentials_whenOneIsRemoved_thenTheRestAreStillAnArray", () => {
    const data = {
      auth: {
        type: "bearer",
        credentials: [
          { key: "token", value: "t" },
          { key: "scope", value: "read" },
        ],
      },
    };
    const block = readAuth(data);
    const scope = block.extra[0]!;

    const next = project(data, [...editCredentialRemoved(block, scope)]);

    expect(credentialsOf(next)).toEqual([{ key: "token", value: "t" }]);
  });
});

describe("schemeLabel", () => {
  it("givenASupportedType_whenLabelled_thenItReadsAsPostmanNamesIt", () => {
    expect(schemeLabel("BEARER")).toBe("Bearer Token");
  });

  it("givenAnUnsupportedType_whenLabelled_thenTheAuthoredStringIsShownAsIs", () => {
    expect(schemeLabel("oauth2")).toBe("oauth2");
  });
});

describe("inheritedAuth", () => {
  it("givenAChainWithACollectionAuth_whenResolved_thenTheOriginIsTheCollection", () => {
    const origin = inheritedAuth([node({ id: "c", kind: "collection", name: "payment", auth: "bearer" })]);

    expect(origin).toEqual({
      nodeId: "c",
      name: "payment",
      kind: "collection",
      type: "bearer",
      label: "collection payment",
    });
  });

  it("givenAChainWhereAFolderOverridesTheCollection_whenResolved_thenTheOriginIsTheFolder", () => {
    const origin = inheritedAuth([
      node({ id: "c", kind: "collection", name: "payment", auth: "bearer" }),
      node({ id: "f", kind: "folder", name: "admin", auth: "apikey" }),
    ]);

    expect(origin?.label).toBe("folder admin");
    expect(origin?.type).toBe("apikey");
  });

  it("givenAFolderWithNoBlockBetweenTwoThatHaveOne_whenResolved_thenTheNearestDeclarationWins", () => {
    const origin = inheritedAuth([
      node({ id: "c", kind: "collection", name: "payment", auth: "bearer" }),
      node({ id: "f", kind: "folder", name: "admin" }),
    ]);

    expect(origin?.nodeId).toBe("c");
  });

  it("givenAChainWithNoAuth_whenResolved_thenThereIsNoOrigin", () => {
    expect(inheritedAuth([node({ id: "c", kind: "collection", name: "payment" })])).toBeNull();
  });

  /**
   * Decision 17: the walk exists in two places, so both are run over every fixture request and
   * asserted to agree. `resolveAuth(entry, undefined)` is asked what a request with no block of
   * its own would inherit, which is exactly the question the Auth tab's inherit state asks.
   */
  it.each([FIXTURE_WS, FIXTURE_HTTP_WS])(
    "givenEveryFixtureRequest_whenResolvedBothWays_thenTheRendererAndCoreAgree",
    async (root) => {
      const catalog = await buildCatalog(root);
      const entries = listRequests(requireWorkspace(root));
      expect(entries.length).toBeGreaterThan(0);

      for (const entry of entries) {
        const chain: CatalogNode[] = [];
        let parent = catalog.nodes.find((candidate) => candidate.id === entry.file)?.parentId ?? null;
        while (parent !== null) {
          const found = catalog.nodes.find((candidate) => candidate.id === parent);
          if (found === undefined) break;
          chain.unshift(found);
          parent = found.parentId;
        }

        const mine = inheritedAuth(chain);
        const theirs = resolveAuth(entry, undefined);

        expect(mine?.label ?? null).toBe(theirs?.origin.label ?? null);
        expect(mine?.type ?? null).toBe(theirs === undefined ? null : theirs.auth.type.trim().toLowerCase());
      }
    },
  );
});

describe("authOverride", () => {
  const BEARER = { type: "bearer", credentials: { token: "tok-1" } };
  const store = () => new VariableStore({ environment: { jwt_token: "tok-1" } });

  it("givenNoAuthoredHeader_whenAsked_thenNothingIsOverridden", () => {
    expect(authOverride({ auth: BEARER, headers: [{ key: "Accept", value: "*/*" }] }, [])).toBeNull();
  });

  it("givenAnAuthorizationHeaderAndABearerBlock_whenAsked_thenTheHeaderIsNamed", () => {
    const override = authOverride({ auth: BEARER, headers: [{ key: "Authorization", value: "Bearer mine" }] }, []);
    expect(override).toEqual({ name: "Authorization", displaced: ["Bearer mine"], type: "bearer", origin: null });
  });

  it("givenALowercaseAuthoredName_whenAsked_thenItStillMatches", () => {
    const override = authOverride({ auth: BEARER, headers: [{ key: "authorization", value: "Bearer mine" }] }, []);
    expect(override?.displaced).toEqual(["Bearer mine"]);
  });

  it("givenTwoAuthoredMatches_whenAsked_thenBothAreListedInAuthoredOrder", () => {
    const headers = [
      { key: "Authorization", value: "one" },
      { key: "Authorization", value: "two" },
    ];
    expect(authOverride({ auth: BEARER, headers }, [])?.displaced).toEqual(["one", "two"]);
  });

  /** `replaceHeader` does not touch a disabled row, so the pane must not claim it will. */
  it("givenADisabledAuthoredHeader_whenAsked_thenNothingIsOverridden", () => {
    const headers = [{ key: "Authorization", value: "Bearer mine", disabled: true }];
    expect(authOverride({ auth: BEARER, headers }, [])).toBeNull();
  });

  it("givenNoauth_whenAsked_thenNothingIsOverridden", () => {
    const headers = [{ key: "Authorization", value: "Bearer mine" }];
    expect(authOverride({ auth: { type: "noauth" }, headers }, [])).toBeNull();
  });

  it("givenAnUnsupportedType_whenAsked_thenNothingIsOverridden", () => {
    const headers = [{ key: "Authorization", value: "Bearer mine" }];
    expect(authOverride({ auth: { type: "oauth2" }, headers }, [])).toBeNull();
  });

  it("givenAnApikeyHeader_whenAsked_thenItsOwnKeyIsNamed", () => {
    const auth = { type: "apikey", credentials: { key: "X-Api-Key", value: "k" } };
    const headers = [{ key: "x-api-key", value: "mine" }];
    expect(authOverride({ auth, headers }, [])).toEqual({
      name: "X-Api-Key",
      displaced: ["mine"],
      type: "apikey",
      origin: null,
    });
  });

  /** An `apikey` bound for the query string collides with a param, which this pane does not show. */
  it("givenAnApikeyInQuery_whenAsked_thenTheHeadersPaneSaysNothing", () => {
    const auth = { type: "apikey", credentials: { key: "token", value: "k", in: "query" } };
    expect(authOverride({ auth, headers: [{ key: "token", value: "mine" }] }, [])).toBeNull();
  });

  it("givenAnInheritedBearer_whenAsked_thenTheOriginIsNamed", () => {
    const ancestors = [node({ id: "c", kind: "collection", name: "payment", auth: "bearer" })];
    const override = authOverride({ headers: [{ key: "Authorization", value: "Bearer mine" }] }, ancestors);
    expect(override?.type).toBe("bearer");
    expect(override?.origin?.label).toBe("collection payment");
  });

  /** ADR 049: the catalog carries the type alone, so an inherited apikey's header name is unknown. */
  it("givenAnInheritedApikey_whenAsked_thenNothingIsClaimed", () => {
    const ancestors = [node({ auth: "apikey" })];
    expect(authOverride({ headers: [{ key: "X-Api-Key", value: "mine" }] }, ancestors)).toBeNull();
  });

  it("givenNoParentDeclaresAuth_whenAsked_thenNothingIsOverridden", () => {
    expect(authOverride({ headers: [{ key: "Authorization", value: "Bearer mine" }] }, [node({})])).toBeNull();
  });

  /**
   * The pane's prediction against the engine's act. `authOverride` exists to say, before a send,
   * what `applyAuth` will do during one; a divergence here is the pane lying about the wire.
   */
  it.each([
    { name: "a bearer block over an authored header", auth: BEARER, key: "Authorization" },
    { name: "a bearer block over a lowercase authored header", auth: BEARER, key: "authorization" },
    { name: "no collision", auth: BEARER, key: "Accept" },
    { name: "noauth", auth: { type: "noauth" }, key: "Authorization" },
    {
      name: "an apikey block over its own key",
      auth: { type: "apikey", credentials: { key: "X-Api-Key", value: "k" } },
      key: "X-Api-Key",
    },
  ])("givenTheHeadersPanePrediction_when$name_thenCoreDoesWhatItSaid", ({ auth, key }) => {
    const authored = "authored-value";
    const data = { auth, headers: [{ key, value: authored }] };
    const predicted = authOverride(data, []);

    const headers = [{ key, value: authored }];
    const warnings = applyAuth({ auth, headers, url: new URL("https://example.test/"), store: store() });
    const replaced = warnings.some((warning) => warning.includes("replaced request header"));

    expect(replaced).toBe(predicted !== null);
    if (predicted === null) {
      // The block may still add a header of its own; what it must not do is disturb this one.
      expect(headers).toContainEqual({ key, value: authored });
      return;
    }
    expect(headers.some((header) => header.key === predicted.name && header.value !== authored)).toBe(true);
    expect(headers.some((header) => header.value === authored)).toBe(false);
  });
});
