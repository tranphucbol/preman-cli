import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { PremanError } from "@preman/core/errors.js";
import { planWorkspace } from "@preman/core/postman/convert.js";
import { cloudCollectionSchema, parseResponse } from "@preman/core/postman/model.js";
import type { PostmanSourceItem, PostmanWorkspaceSource } from "@preman/core/postman/model.js";
import { applyPlan } from "@preman/core/postman/write.js";
import { listRequests } from "@preman/core/workspace/collections.js";
import { requireWorkspace } from "@preman/core/workspace/discover.js";
import { parseRequestFile } from "@preman/core/workspace/request-file.js";
import { cloudFixture } from "./support/postman-cloud.js";

const PROFILE = {
  type: "bearer",
  id: "profile-id",
  name: "Primary",
  custom: { retained: true },
  credentials: [
    { key: "token", value: "first-secret", disabled: true, custom: "retained" },
    { key: "token", value: "second-secret" },
  ],
};
const SCRIPTS = [{ type: "beforeInvoke", code: "pm.variables.set('ready', true);", custom: true }];
const temporaries: string[] = [];

afterEach(() => {
  for (const dir of temporaries.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function source(auth: unknown, level = "collection", kind = "grpc-request"): PostmanWorkspaceSource {
  const request = (
    cloudFixture(kind === "grpc-request" ? "item-grpc-exchange" : "item-http-profile") as {
      data: Record<string, unknown>;
    }
  ).data;
  const leaf: PostmanSourceItem = {
    kind,
    name: "Request",
    detail: { ...request, auth: level === "request" ? auth : undefined },
    children: [],
  };
  return {
    workspaceId: "workspace",
    name: "Workspace",
    environments: [],
    collections: [
      {
        id: "collection-id",
        detail: { name: "Collection", auth: level === "collection" ? auth : undefined },
        items: [
          {
            kind: "folder",
            name: "Outer",
            detail: { name: "Outer", auth: level === "folder" ? auth : undefined },
            children: [{ kind: "collection", name: "Inner", detail: { name: "Inner" }, children: [leaf] }],
          },
        ],
      },
    ],
  };
}

describe("migration auth boundary", () => {
  it("givenCollectionAuthArrays_whenParsedThenPlanned_thenValidationKeepsArraysAndWritingSelectsFirst", () => {
    const parsed = parseResponse(cloudCollectionSchema, { name: "Collection", auth: [PROFILE] }, "collection-id");
    expect(parsed.auth).toEqual([PROFILE]);
    expect(parseResponse(cloudCollectionSchema, parsed, "collection-id")).toEqual(parsed);
    const input = source(undefined);
    const plan = planWorkspace({ ...input, collections: [{ ...input.collections[0]!, detail: parsed }] });
    const definition = plan.files.find(
      (file) => file.relativePath === "postman/collections/Collection/.resources/definition.yaml",
    )!;
    expect((parse(definition.contents) as { auth: unknown }).auth).toEqual(PROFILE);
    expect(parsed.auth).toEqual([PROFILE]);
  });

  it("givenObjectAuthWithMapCredentials_whenPlanned_thenTheExistingObjectShapeIsUnchanged", () => {
    const auth = { type: "bearer", credentials: { token: "secret" }, custom: true };
    const plan = planWorkspace(source(auth, "request", "http-request"));
    const request = plan.files.find((file) => file.relativePath.endsWith("Request.request.yaml"))!;
    expect((parse(request.contents) as { auth: unknown }).auth).toEqual(auth);
  });

  for (const level of ["collection", "folder"]) {
    for (const kind of ["grpc-request", "http-request"]) {
      it(`given${level}${kind}Auth_whenPlanned_thenOnlyTheFirstArrayEntryIsWritten`, () => {
        for (const auth of [
          undefined,
          [],
          [PROFILE],
          [PROFILE, { type: "basic", credentials: { password: "discarded-secret" } }],
        ]) {
          const plan = planWorkspace(source(auth, level, kind));
          const path =
            level === "collection"
              ? "postman/collections/Collection/.resources/definition.yaml"
              : "postman/collections/Collection/Outer/.resources/definition.yaml";
          const written = parse(plan.files.find((file) => file.relativePath === path)!.contents) as {
            auth?: unknown;
          };
          expect(written.auth).toEqual(
            auth === undefined || (Array.isArray(auth) && auth.length === 0) ? undefined : PROFILE,
          );
        }
      });

      it(`givenObject${level}${kind}Auth_whenPlanned_thenItIsRejectedWithoutSecrets`, () => {
        try {
          planWorkspace(source(PROFILE, level, kind));
          expect.unreachable("collection and folder auth must be arrays");
        } catch (error) {
          expect(error).toBeInstanceOf(PremanError);
          const failure = error as PremanError;
          const diagnostic = [failure.message, ...failure.details].join("\n");
          expect(diagnostic).toContain(level === "collection" ? "collection-id" : "Collection/Outer");
          expect(diagnostic).toContain("auth");
          expect(diagnostic).not.toContain("first-secret");
          expect(diagnostic).not.toContain("second-secret");
        }
      });
    }
  }

  for (const kind of ["http-request", "grpc-request"]) {
    it(`given${kind}Auth_whenPlanned_thenObjectsArePreservedAndArraysAreRejected`, () => {
      for (const auth of [undefined, PROFILE]) {
        const plan = planWorkspace(source(auth, "request", kind));
        const request = plan.files.find((file) => file.relativePath.endsWith("Request.request.yaml"))!;
        expect((parse(request.contents) as { auth?: unknown }).auth).toEqual(auth);
      }
      for (const auth of [[], [PROFILE], [PROFILE, PROFILE]]) {
        try {
          planWorkspace(source(auth, "request", kind));
          expect.unreachable("request auth must remain an object");
        } catch (error) {
          expect(error).toBeInstanceOf(PremanError);
          const failure = error as PremanError;
          const diagnostic = [failure.message, ...failure.details].join("\n");
          expect(diagnostic).toContain("Collection/Outer/Inner/Request");
          expect(diagnostic).toContain("auth");
          expect(diagnostic).not.toContain("first-secret");
          expect(diagnostic).not.toContain("second-secret");
        }
      }
    });
  }

  it("givenSingleProfilesWithoutIdentity_whenPlanned_thenRuntimeCredentialShapesAndUnknownFieldsSurvive", () => {
    const values = {
      username: "user",
      password: "secret",
      enabled: true,
      count: 2,
      empty: null,
      nested: { custom: [true, "value"] },
    };
    const credentialsList = Object.entries(values).map(([key, value]) => ({ key, value, custom: { retained: true } }));
    for (const auth of [
      { type: "noauth" },
      { type: "basic", credentials: values, custom: { nested: true }, id: 123 },
      { type: "basic", credentials: credentialsList, custom: { nested: true } },
    ]) {
      const parsed = parseResponse(cloudCollectionSchema, { name: "Collection", auth: [auth] }, "collection-id");
      expect(parsed.auth).toEqual([auth]);
      for (const kind of ["http-request", "grpc-request"]) {
        const plan = planWorkspace(source(auth, "request", kind));
        const request = plan.files.find((file) => file.relativePath.endsWith("Request.request.yaml"))!;
        expect((parse(request.contents) as { auth: unknown }).auth).toEqual(auth);
      }
    }
  });

  it("givenAnInvalidSingleProfile_whenParsed_thenItsFieldPathIsReportedWithoutValues", () => {
    for (const [auth, path] of [
      [{ ...PROFILE, type: { secret: "hidden" } }, "auth.0.type"],
      [{ ...PROFILE, type: 123 }, "auth.0.type"],
    ] as const) {
      try {
        parseResponse(cloudCollectionSchema, { name: "Collection", auth: [auth] }, "collection-id");
        expect.unreachable("invalid profiles must fail validation");
      } catch (error) {
        expect(error).toBeInstanceOf(PremanError);
        const failure = error as PremanError;
        const diagnostic = [failure.message, ...failure.details].join("\n");
        expect(diagnostic).toContain(path);
        expect(diagnostic).toContain("collection-id");
        expect(diagnostic).not.toContain("hidden");
      }
    }
  });

  for (const metadata of [
    { "x-token": "value", "x-count": 2 },
    [
      { key: "x-token", value: "first", disabled: true, custom: true },
      { key: "x-token", value: "second" },
    ],
  ]) {
    it(`givenNestedGrpcWith${Array.isArray(metadata) ? "List" : "Map"}Metadata_whenAppliedAndLoaded_thenRuntimeFieldsSurvive`, async () => {
      const input = source([PROFILE]);
      const collection = input.collections[0]!;
      const outer = collection.items[0]!;
      const inner = outer.children[0]!;
      const leaf = inner.children[0]!;
      const original = leaf.detail as Record<string, unknown>;
      const message = { content: '{\n  "amount": "{{amount}}", "note": "unchanged"\n}', custom: true };
      const request = { ...original, message, metadata, auth: PROFILE, scripts: SCRIPTS };
      const tree = {
        ...input,
        collections: [
          {
            ...collection,
            items: [
              {
                ...outer,
                detail: { name: "Outer", auth: [PROFILE], scripts: SCRIPTS },
                children: [{ ...inner, children: [{ ...leaf, detail: request }] }],
              },
            ],
          },
        ],
      };
      const plan = planWorkspace(tree);
      const dir = mkdtempSync(join(tmpdir(), "preman-auth-"));
      temporaries.push(dir);
      const target = join(dir, "workspace");
      await applyPlan(target, plan);
      const entries = listRequests(requireWorkspace(target));
      expect(entries).toHaveLength(1);
      const entry = entries[0]!;
      expect(entry.folders).toEqual(["Outer", "Inner"]);
      expect(entry.ancestors[0]!.auth).toEqual(PROFILE);
      expect(entry.ancestors[1]!.auth).toEqual(PROFILE);
      expect(entry.ancestors[1]!.scripts).toEqual(SCRIPTS);
      const loaded = parseRequestFile(entry);
      expect(loaded.request).toMatchObject({
        message,
        metadata,
        auth: PROFILE,
        scripts: SCRIPTS,
        methodDescriptor: original.methodDescriptor,
        schema: original.schema,
      });
    });
  }
});
