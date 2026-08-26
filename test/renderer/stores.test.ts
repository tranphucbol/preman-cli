/**
 * The renderer's state, exercised without a browser.
 *
 * These stores carry the four rules the app's responsiveness rests on: a row subscribes to its own
 * node, a form subscribes to its own tab, an external edit never overwrites unsaved work, and an
 * unsaved edit survives a crash without ever touching the workspace. All four are properties of
 * plain functions and plain objects, so all four are testable here.
 *
 * Where a document is needed it comes from a real `createEngineHost` over a real cloned fixture,
 * not a stub. A hand-written `NodeDocument` would let a reload test pass while the reload was
 * reading a field the engine does not actually send.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createEngineHost, type EngineHost } from "@preman/desktop/engine/host.js";
import type {
  Catalog,
  CatalogNode,
  EnginePayload,
  EngineRequest,
  EngineRequestKind,
  EngineResults,
  RunEvent,
} from "@preman/desktop/engine/protocol.js";
import { EXIT_CODES, ORDER_STEP } from "@preman/desktop/engine/protocol.js";
import { DEFAULT_PREFERENCES, TITLE_BAR_GUTTER_PX } from "@preman/desktop/preload/bridge.js";
import type {
  CreateWorkspaceResult,
  MigrateResult,
  PremanBridge,
  SessionSnapshot,
  WindowControl,
} from "@preman/desktop/preload/bridge.js";
import { EngineRequestError, type EngineClient } from "@preman/desktop/renderer/client.js";
import type { TestResult } from "@preman/desktop/renderer/model/response.js";
import {
  FIELD,
  edit,
  editPairEnabled,
  editPairKey,
  editPairValue,
  editGrpcAuthority,
  editGrpcTls,
  pairsToText,
  project,
  readGrpcUrl,
  readPairs,
  textToPairs,
} from "@preman/desktop/renderer/model/request.js";
import { createEnvironment, saveTab } from "@preman/desktop/renderer/actions.js";
import { clearFlush, flushPending, registerFlush } from "@preman/desktop/renderer/pending.js";
import {
  DRAFT_PERSIST_DEBOUNCE_MS,
  readSession,
  restoreCollapse,
  restoreOpenState,
  startPersistence,
} from "@preman/desktop/renderer/persist.js";
import { useCatalogStore } from "@preman/desktop/renderer/stores/catalog.js";
import { useOverlayStore } from "@preman/desktop/renderer/stores/overlay.js";
import { CONSOLE_MAX_LINES, useRunsStore } from "@preman/desktop/renderer/stores/runs.js";
import {
  applyExternalChange,
  createNewWorkspace,
  migrateFromPostman,
  useSessionStore,
} from "@preman/desktop/renderer/stores/session.js";
import { DEFAULT_BODY_VIEW, isDirty, useTabsStore } from "@preman/desktop/renderer/stores/tabs.js";

import { cloneFixtureHttpWorkspace, cloneFixtureWorkspace, type ClonedWorkspace } from "../helpers.js";

const FIRST_REQUEST_ID = 1;
const PING_ID = "postman/collections/payment/Ping.request.yaml";
const PAYMENT_ID = "postman/collections/payment";
const ADMIN_ID = "postman/collections/admin";
const PROFILE_ID = "postman/collections/admin/Profile.request.yaml";
const HEADERS_FIELD = "headers";
/** Nested under `body` in a real file; the pair edits are written against the leaf name. */
const FORMDATA_FIELD = "formdata";
const EMPTY_VALUE = "";

/** Workspace creation: the name asked for, where main says it went, and why it might refuse. */
const NEW_WORKSPACE_NAME = "payments";
const NEW_WORKSPACE_ROOT = "/tmp/home/.local/share/preman/workspace/payments";
const CREATE_REFUSAL = "/tmp/home/.local/share/preman/workspace/payments already exists.";
/** The fake's default, so a test that forgot to say what creation answers cannot pass by accident. */
const NO_CREATE_ANSWER = "no creation result was staged";

/** Migration: the cloud workspace asked for, where main says it wrote it, and why it might refuse. */
const CLOUD_WORKSPACE_ID = "2a52db72-0b3f-45c5-8242-000000000001";
const MIGRATED_ROOT = "/tmp/migrated/work";
const MIGRATED_NAME = "Work";
const MIGRATE_REFUSAL = "Postman Desktop does not appear to be running";
const MIGRATE_ADVICE = "open Postman Desktop and sign in, then try again";
/** Same reasoning as `NO_CREATE_ANSWER`: nothing succeeds because a test forgot to stage it. */
const NO_MIGRATE_ANSWER = "no migration result was staged";
const NO_CALLS = 0;
const SETTLE_MS = DRAFT_PERSIST_DEBOUNCE_MS * 2;

/** Two requests over two data rows, which is what the runner's `#N` labels exist for. */
const RUN_ID = "run-1";
const ITERATION_COUNT = 2;
const ITERATED_TOTAL = 4;
const FIRST_ITERATION = 0;
/** A run has entered one iteration the moment it starts, before any request says which. */
const FIRST_ITERATION_COUNT = 1;
const RUN_WARNING = "no environment selected";

/** Big enough that any per-node work in a render path would show up as a hang, not a slowdown. */
const COLLECTION_COUNT = 50;
const REQUESTS_PER_COLLECTION = 100;
const SYNTHETIC_NODE_COUNT = COLLECTION_COUNT * REQUESTS_PER_COLLECTION;
const ROOT_DEPTH = 0;
const CHILD_DEPTH = 1;
const FIRST_REVISION = 1;

// ---------------------------------------------------------------------------------------------
// Fakes: exactly the two seams the renderer has, and nothing else.
// ---------------------------------------------------------------------------------------------

interface FakeBridge {
  readonly bridge: PremanBridge;
  /** The last snapshot written, or null if nothing has been. */
  saved(): SessionSnapshot | null;
  seed(snapshot: SessionSnapshot): void;
  writes(): number;
  /** What creation answers. Set per test; the default is a refusal, so nothing succeeds by accident. */
  answerCreate(result: CreateWorkspaceResult): void;
  /** Which names creation was asked for, which roots were opened, and how often Recents was read. */
  created(): string[];
  opened(): string[];
  lists(): number;
  /** What main says it is reopening at launch. The default is nothing, which is a cold first run. */
  answerReopening(root: string | null): void;
  /** What migration answers, and which cloud workspace ids it was asked for. */
  answerMigrate(result: MigrateResult): void;
  migrated(): string[];
}

/** What main hands back when nothing has been stored: no `activeEnvironment` key at all, because
 * an absent choice and a chosen "none" are different answers. */
function emptySnapshot(): SessionSnapshot {
  return { activeNodeId: null, collapsedIds: [], tabs: [], drafts: [] };
}

function fakeBridge(): FakeBridge {
  let stored: SessionSnapshot = emptySnapshot();
  let written: SessionSnapshot | null = null;
  let writes = 0;
  let createResult: CreateWorkspaceResult = { ok: false, message: NO_CREATE_ANSWER };
  const createNames: string[] = [];
  const openedRoots: string[] = [];
  let listCalls = 0;
  let reopeningRoot: string | null = null;
  let migrateResult: MigrateResult = { status: "failed", message: NO_MIGRATE_ANSWER, details: [] };
  const migratedIds: string[] = [];

  const bridge: PremanBridge = {
    titleBarGutter: TITLE_BAR_GUTTER_PX,
    preferences: { ...DEFAULT_PREFERENCES },
    savePreferences: () => Promise.resolve(),
    setWindowChrome: () => undefined,
    onOpenSettings: () => () => undefined,
    onCreateWorkspace: () => () => undefined,
    onMigrate: () => () => undefined,
    onHostFailure: () => () => undefined,
    listPostmanWorkspaces: () => Promise.resolve({ status: "listed", workspaces: [] }),
    migratePostmanWorkspace: (workspaceId: string) => {
      migratedIds.push(workspaceId);
      return Promise.resolve(migrateResult);
    },
    onMigrateProgress: () => () => undefined,
    listWorkspaces: () => {
      listCalls += 1;
      return Promise.resolve([]);
    },
    pickWorkspaceDirectory: () => Promise.resolve(null),
    openWorkspace: (root: string) => {
      openedRoots.push(root);
      return Promise.resolve();
    },
    reopening: () => Promise.resolve(reopeningRoot),
    createWorkspace: (name: string) => {
      createNames.push(name);
      return Promise.resolve(createResult);
    },
    forgetWorkspace: () => Promise.resolve(),
    revealInFileManager: () => Promise.resolve(),
    pickDataFile: () => Promise.resolve(null),
    saveReport: () => Promise.resolve(null),
    controlWindow: (_action: WindowControl) => undefined,
    readSession: () => Promise.resolve(structuredClone(stored)),
    saveSession: (_root: string, snapshot: SessionSnapshot) => {
      written = structuredClone(snapshot);
      stored = structuredClone(snapshot);
      writes += 1;
      return Promise.resolve();
    },
  };

  return {
    bridge,
    saved: () => written,
    seed: (snapshot) => {
      stored = structuredClone(snapshot);
    },
    writes: () => writes,
    answerCreate: (result) => {
      createResult = result;
    },
    created: () => [...createNames],
    opened: () => [...openedRoots],
    lists: () => listCalls,
    answerReopening: (root) => {
      reopeningRoot = root;
    },
    answerMigrate: (result) => {
      migrateResult = result;
    },
    migrated: () => [...migratedIds],
  };
}

/**
 * `window` does not exist under `environment: "node"`, and it should not: the two things the
 * renderer reaches for on it are the bridge and the port, and both are seams by design.
 */
function installBridge(bridge: PremanBridge): void {
  (globalThis as { window?: unknown }).window = { preman: bridge };
}

function uninstallBridge(): void {
  delete (globalThis as { window?: unknown }).window;
}

/** An `EngineClient` backed by a real host, so every document is one the engine actually sends. */
function hostClient(host: EngineHost, root: string): EngineClient {
  let nextId = FIRST_REQUEST_ID;
  return {
    root,
    async send<K extends EngineRequestKind>(kind: K, payload: EnginePayload<K>): Promise<EngineResults[K]> {
      const request = { id: nextId++, kind, ...payload } as unknown as EngineRequest;
      const response = await host.handle(request);
      if (!response.ok) throw new EngineRequestError(response.error);
      return response.data as EngineResults[K];
    },
    onPush: () => () => undefined,
    close: () => undefined,
  };
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

function resetStores(): void {
  useCatalogStore.getState().clear();
  useTabsStore.getState().clear();
  useRunsStore.getState().clear();
  useOverlayStore.getState().dismiss();
  const session = useSessionStore.getState();
  session.setClient(null, null);
  // `undefined`, not `null`: a fresh store has nobody's answer, and `null` is somebody's.
  session.setEnvironment(undefined);
  session.setDegraded(null);
  session.setHostFailure(null);
  session.setReopening(null);
}

/** Every file in the workspace, keyed by its relative posix path. The bytes, not the mtimes. */
function bytesOf(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const absolute = join(dir, entry);
      if (statSync(absolute).isDirectory()) walk(absolute);
      else files[relative(root, absolute).split(sep).join("/")] = readFileSync(absolute, "utf8");
    }
  };
  walk(root);
  return files;
}

function syntheticCatalog(): Catalog {
  const nodes: CatalogNode[] = [];
  for (let collection = 0; collection < COLLECTION_COUNT; collection += 1) {
    const id = `postman/collections/c${collection}`;
    nodes.push({
      id,
      kind: "collection",
      name: `c${collection}`,
      file: `/ws/${id}`,
      parentId: null,
      depth: ROOT_DEPTH,
      order: (collection + 1) * ORDER_STEP,
    });
    for (let request = 0; request < REQUESTS_PER_COLLECTION; request += 1) {
      nodes.push({
        id: `${id}/r${request}.request.yaml`,
        kind: "request",
        name: `r${request}`,
        file: `/ws/${id}/r${request}.request.yaml`,
        parentId: id,
        depth: CHILD_DEPTH,
        order: (request + 1) * ORDER_STEP,
        protocol: "http",
        label: "GET",
      });
    }
  }
  return { root: "/ws", workspaceId: null, revision: FIRST_REVISION, nodes, environments: [], specs: [] };
}

// ---------------------------------------------------------------------------------------------
// Suites
// ---------------------------------------------------------------------------------------------

describe("the sidebar's row budget", () => {
  beforeEach(resetStores);
  afterEach(resetStores);

  /**
   * The mounted-row count and the frame rate belong to the Playwright suite, which has layout.
   * What is testable here is the thing that makes them possible: the sidebar renders `visibleIds`
   * and resolves each row through `byId`, so neither the row count nor the per-row work grows with
   * the size of the tree.
   */
  it("givenFiveThousandNodes_whenScrolling_thenOnlyViewportRowsMount", () => {
    const catalog = syntheticCatalog();
    const store = useCatalogStore.getState();
    store.replace(catalog);

    expect(catalog.nodes).toHaveLength(SYNTHETIC_NODE_COUNT + COLLECTION_COUNT);
    expect(useCatalogStore.getState().visibleIds).toHaveLength(SYNTHETIC_NODE_COUNT + COLLECTION_COUNT);

    // Collapsing the roots hides 5,000 rows without the store consulting a single parent: the
    // engine emits a group immediately before its subtree, so one pass over depths is enough.
    for (const node of catalog.nodes) {
      if (node.kind === "collection") useCatalogStore.getState().toggle(node.id);
    }
    expect(useCatalogStore.getState().visibleIds).toHaveLength(COLLECTION_COUNT);

    // And a row's own lookup is a map hit that yields the identical object the catalog holds,
    // which is what lets `useNode` re-render one row instead of five thousand.
    const { byId, nodes } = useCatalogStore.getState();
    expect(byId.size).toBe(nodes.length);
    const middle = nodes[Math.floor(nodes.length / 2)];
    expect(middle).toBeDefined();
    expect(byId.get(middle?.id ?? "")).toBe(middle);
  });
});

describe("tab isolation", () => {
  beforeEach(resetStores);
  afterEach(resetStores);

  it("givenTwoOpenTabs_whenEditingOne_thenOtherDoesNotRerender", () => {
    const tabs = useTabsStore.getState();
    tabs.open({ id: PING_ID, name: "Ping", kind: "request" });
    tabs.open({ id: PROFILE_ID, name: "Profile", kind: "request" });

    const untouchedBefore = useTabsStore.getState().tabs.get(PROFILE_ID);
    const editedBefore = useTabsStore.getState().tabs.get(PING_ID);

    useTabsStore.getState().setField(PING_ID, FIELD.url, "https://example.test/ping");

    const untouchedAfter = useTabsStore.getState().tabs.get(PROFILE_ID);
    const editedAfter = useTabsStore.getState().tabs.get(PING_ID);

    // `useTab` is an identity selector, so a preserved reference *is* a skipped render. The edited
    // tab must have moved, or the form being typed into would not repaint.
    expect(untouchedAfter).toBe(untouchedBefore);
    expect(editedAfter).not.toBe(editedBefore);
    expect(isDirty(editedAfter!)).toBe(true);
    expect(isDirty(untouchedAfter!)).toBe(false);
  });

  it("givenOneCellTypedIntoRepeatedly_whenEdited_thenOneEditIsPending", () => {
    const tabs = useTabsStore.getState();
    tabs.open({ id: PING_ID, name: "Ping", kind: "request" });

    for (const value of ["h", "ht", "htt", "http"]) {
      useTabsStore.getState().setField(PING_ID, FIELD.url, value);
    }

    const tab = useTabsStore.getState().tabs.get(PING_ID);
    expect(tab?.edits).toHaveLength(1);
    expect(tab?.edits[0]?.value).toBe("http");
  });
});

describe("which body view a tab opens in", () => {
  beforeEach(resetStores);
  afterEach(resetStores);

  it("givenTabInPreview_whenReopened_thenViewIsEdit", () => {
    const node = { id: PING_ID, name: "Ping", kind: "request" } as const;
    useTabsStore.getState().open(node);
    useTabsStore.getState().setBodyView(PING_ID, "preview");
    expect(useTabsStore.getState().tabs.get(PING_ID)?.bodyView).toBe("preview");

    // The whole store is cleared and the node opened again, which is what a workspace switch and a
    // session restore both do. Preview is a place the user is looking, not a property of the
    // request, so it must not survive that — and the only way it could is if it were persisted.
    useTabsStore.getState().clear();
    useTabsStore.getState().open(node);

    expect(useTabsStore.getState().tabs.get(PING_ID)?.bodyView).toBe(DEFAULT_BODY_VIEW);
  });

  it("givenTwoOpenTabs_whenOneSwitchesToPreview_thenTheOtherStaysInEdit", () => {
    const tabs = useTabsStore.getState();
    tabs.open({ id: PING_ID, name: "Ping", kind: "request" });
    tabs.open({ id: PROFILE_ID, name: "Profile", kind: "request" });

    useTabsStore.getState().setBodyView(PING_ID, "preview");

    // The view is per tab because the switch is drawn per tab. A shared one would mean opening a
    // second request showed a preview of a body nobody asked to resolve.
    expect(useTabsStore.getState().tabs.get(PING_ID)?.bodyView).toBe("preview");
    expect(useTabsStore.getState().tabs.get(PROFILE_ID)?.bodyView).toBe(DEFAULT_BODY_VIEW);
  });
});

describe("external changes under an open tab", () => {
  let workspace: ClonedWorkspace;
  let host: EngineHost;

  beforeEach(async () => {
    resetStores();
    workspace = cloneFixtureWorkspace();
    host = createEngineHost({ root: workspace.root, post: () => undefined });
    const client = hostClient(host, workspace.root);
    useSessionStore.getState().setClient(client, workspace.root);
    useCatalogStore.getState().replace(await client.send("catalog", {}));
  });

  afterEach(() => {
    host.dispose();
    resetStores();
    workspace.cleanup();
  });

  it("givenDirtyTabAndExternalEdit_whenWatcherFires_thenConflictIsFlagged", async () => {
    const node = useCatalogStore.getState().byId.get(PING_ID);
    expect(node).toBeDefined();
    useTabsStore.getState().open(node!);
    useTabsStore
      .getState()
      .loaded(PING_ID, await useSessionStore.getState().client!.send("read-node", { nodeId: PING_ID }));
    useTabsStore.getState().setField(PING_ID, FIELD.url, "https://mine.test/ping");

    const before = useTabsStore.getState().tabs.get(PING_ID);
    applyExternalChange([PING_ID]);
    const after = useTabsStore.getState().tabs.get(PING_ID);

    expect(after?.conflicted).toBe(true);
    // The edits are still pending and the baseline is untouched. Silently reloading over unsaved
    // work to stay in sync is the one behaviour a tool must never have.
    expect(after?.edits).toStrictEqual(before?.edits);
    expect(after?.saved).toBe(before?.saved);
  });

  it("givenCleanTabAndExternalEdit_whenWatcherFires_thenTabReloadsSilently", async () => {
    const node = useCatalogStore.getState().byId.get(PING_ID);
    expect(node).toBeDefined();
    useTabsStore.getState().open(node!);
    useTabsStore
      .getState()
      .loaded(PING_ID, await useSessionStore.getState().client!.send("read-node", { nodeId: PING_ID }));

    const before = useTabsStore.getState().tabs.get(PING_ID)?.saved;
    expect(before).toBeDefined();

    applyExternalChange([PING_ID]);
    // `applyExternalChange` fires the read and does not wait: the watcher is not a request.
    await expect.poll(() => useTabsStore.getState().tabs.get(PING_ID)?.saved !== before).toBe(true);

    const after = useTabsStore.getState().tabs.get(PING_ID);
    expect(after?.conflicted).toBe(false);
    expect(after?.error).toBeNull();
    expect(after?.saved?.text).toBe(before?.text);
  });

  it("givenNoTabForAChangedFile_whenWatcherFires_thenNothingHappens", () => {
    applyExternalChange([PING_ID]);

    expect(useTabsStore.getState().tabs.size).toBe(0);
  });
});

describe("flushing the focused editor before a save", () => {
  let workspace: ClonedWorkspace;
  let host: EngineHost;
  /** Whatever this suite last registered, so a test that forgets to clear it does not leak. */
  let registered: (() => void) | null = null;

  beforeEach(async () => {
    resetStores();
    workspace = cloneFixtureWorkspace();
    host = createEngineHost({ root: workspace.root, post: () => undefined });
    const client = hostClient(host, workspace.root);
    useSessionStore.getState().setClient(client, workspace.root);
    useCatalogStore.getState().replace(await client.send("catalog", {}));
    const ping = useCatalogStore.getState().byId.get(PING_ID);
    expect(ping).toBeDefined();
    useTabsStore.getState().open(ping!);
    useTabsStore.getState().loaded(PING_ID, await client.send("read-node", { nodeId: PING_ID }));
  });

  afterEach(() => {
    if (registered !== null) clearFlush(registered);
    registered = null;
    host.dispose();
    resetStores();
    workspace.cleanup();
  });

  /**
   * `CodeEditor` and `Field` are uncontrolled and commit on blur, and `Cmd+S` is bound at
   * `window` precisely so CodeMirror cannot swallow it - which also means it never blurs
   * anything. `saveTab` calls `flushPending()` before it reads the store, so the focused
   * editor's own commit lands first. This suite stands in for that editor with a hand-registered
   * flush: CodeMirror needs a DOM this project's `node` test environment does not have, so the
   * seam under test is `pending.ts` and the store, not the editor's chrome.
   */
  it("givenFocusedEditor_whenSaveInvoked_thenPendingTextIsWritten", async () => {
    registered = () => useTabsStore.getState().setField(PING_ID, FIELD.url, "https://flushed.test/ping");
    registerFlush(registered);

    const failed = await saveTab(useTabsStore.getState().tabs.get(PING_ID)!);

    expect(failed).toBeNull();
    const tab = useTabsStore.getState().tabs.get(PING_ID);
    expect(tab?.saved?.data).toMatchObject({ url: "https://flushed.test/ping" });
    expect(isDirty(tab!)).toBe(false);
  });

  it("givenFocusedEditorWithNoTyping_whenSaveInvoked_thenNothingIsWritten", async () => {
    // The guard at `RequestEditor.tsx`'s `onCommit` sites applies before a flush ever reaches
    // `setField`: an editor whose text still equals its baseline calls nothing, so the tab this
    // flush belongs to never became dirty and `saveTab` has nothing to write.
    registered = () => undefined;
    registerFlush(registered);
    const before = useTabsStore.getState().tabs.get(PING_ID)?.saved;

    const failed = await saveTab(useTabsStore.getState().tabs.get(PING_ID)!);

    expect(failed).toBeNull();
    expect(useTabsStore.getState().tabs.get(PING_ID)?.saved).toBe(before);
  });

  it("givenIdleTyping_whenDebounceElapses_thenTabIsUnsaved", () => {
    // `CodeEditor`'s idle timer commits through the same `setField`/`setText` call a blur does,
    // just 300ms into typing rather than on focus loss. What that buys is exactly this: `isDirty`
    // - and so the Save button's `disabled` state - goes true while the caret is still in the
    // field, not only once it leaves.
    const tab = useTabsStore.getState().tabs.get(PING_ID)!;
    expect(isDirty(tab)).toBe(false);

    useTabsStore.getState().setField(PING_ID, FIELD.url, "https://idle.test/ping");

    expect(isDirty(useTabsStore.getState().tabs.get(PING_ID)!)).toBe(true);
  });

  it("givenTypingThenBlur_whenBothCommit_thenEditsHoldOneEntryPerPath", () => {
    // The idle commit and the blur commit both land through `setField`, and `upsert` keys by
    // path, so a field that changes twice before it is saved still contributes one entry - a
    // ten-minute typing session does not make a tab "more dirty" for having taken longer.
    useTabsStore.getState().setField(PING_ID, FIELD.url, "https://idle.test/ping");
    useTabsStore.getState().setField(PING_ID, FIELD.url, "https://final.test/ping");

    expect(useTabsStore.getState().tabs.get(PING_ID)?.edits).toStrictEqual([
      { path: FIELD.url, value: "https://final.test/ping" },
    ]);
  });

  it("givenTwoEditorsInSequence_whenOneTearsDown_thenTheOtherStaysRegistered", () => {
    // `clearFlush` takes the function being cleared rather than clearing whatever is registered,
    // so a teardown that fires after a newer editor already focused - and registered - cannot
    // clear that newer editor's flush. This is the property `CodeEditor`'s blur handler and
    // unmount cleanup both depend on.
    const first = () => useTabsStore.getState().setField(PING_ID, FIELD.url, "https://first.test/ping");
    const second = () => useTabsStore.getState().setField(PING_ID, FIELD.url, "https://second.test/ping");

    registerFlush(first);
    registerFlush(second);
    clearFlush(first); // a stale teardown from the editor that already lost focus

    registered = second;
    flushPending();

    expect(useTabsStore.getState().tabs.get(PING_ID)?.edits).toStrictEqual([
      { path: FIELD.url, value: "https://second.test/ping" },
    ]);
  });
});

describe("the bulk header editor", () => {
  let workspace: ClonedWorkspace;
  let host: EngineHost;

  beforeEach(() => {
    resetStores();
    // The HTTP fixture, because it is the one with headers to read: `Profile` declares them as a
    // YAML map, which is also the shape the bulk tab has to survive.
    workspace = cloneFixtureHttpWorkspace();
    host = createEngineHost({ root: workspace.root, post: () => undefined });
  });

  afterEach(() => {
    host.dispose();
    resetStores();
    workspace.cleanup();
  });

  /**
   * The bulk tab and the grid are two views of one field, so the round trip has to be lossless in
   * both directions. A text form that dropped `disabled` would silently re-enable a header the
   * user turned off.
   */
  it("givenBulkEditText_whenBlurred_thenHeadersGridMatches", async () => {
    const client = hostClient(host, workspace.root);
    const document = await client.send("read-node", { nodeId: PROFILE_ID });

    const grid = readPairs(document.data, HEADERS_FIELD);
    const text = pairsToText(grid.pairs);
    // Exactly what the textarea shows, so a change made there is made against the real thing.
    expect(text.split("\n")).toHaveLength(grid.pairs.length);

    const typed = `${text}\n//X-Disabled: off\nX-Added: yes`;
    const applied = project(document.data, [edit([HEADERS_FIELD], textToPairs(typed))]);
    const reread = readPairs(applied, HEADERS_FIELD);

    expect(reread.pairs.map((pair) => pair.key)).toStrictEqual([
      ...grid.pairs.map((pair) => pair.key),
      "X-Disabled",
      "X-Added",
    ]);
    expect(reread.pairs.map((pair) => pair.value)).toStrictEqual([
      ...grid.pairs.map((pair) => pair.value),
      "off",
      "yes",
    ]);
    expect(reread.pairs.find((pair) => pair.key === "X-Disabled")?.disabled).toBe(true);
    expect(reread.pairs.find((pair) => pair.key === "X-Added")?.disabled).toBe(false);
  });

  /**
   * A field the file has not written yet reads as `absent`, and the format's default for every
   * pair list is the array. Two of these five used to test `=== "array"` and so treated `absent`
   * as a map, writing `metadata: {key: value}` into a request whose schema declares a list —
   * refused by core as `metadata: Expected array, received object`, against a request the user
   * may only have edited the scripts of.
   */
  it("givenAbsentPairField_whenAPairIsEdited_thenTheEditKeepsTheArrayShape", () => {
    const absent = readPairs({ $kind: "grpc-request" }, "metadata");
    expect(absent.shape).toBe("absent");
    const pair = { key: "x-tenant", value: EMPTY_VALUE, disabled: false, at: 0 };

    const valued = editPairValue("metadata", absent, pair, "acme");
    const keyed = editPairKey("metadata", absent, pair, "x-account");

    // The whole field, as a list - never `["metadata", "x-tenant"]`, which is a map key.
    expect(valued).toStrictEqual({ path: ["metadata"], value: [{ key: "x-tenant", value: "acme" }] });
    expect(keyed).toStrictEqual([{ path: ["metadata"], value: [{ key: "x-account", value: EMPTY_VALUE }] }]);
  });

  it("givenMapShapedPairField_whenAPairIsEdited_thenTheMapKeyIsStillUsed", () => {
    // Headers legitimately come as a map in the HTTP format, and that shape must keep working:
    // the fix above is about `absent`, not about collapsing the two real shapes into one.
    const list = readPairs({ headers: { Accept: "application/json" } }, HEADERS_FIELD);
    expect(list.shape).toBe("map");

    const valued = editPairValue(HEADERS_FIELD, list, list.pairs[0]!, "text/plain");

    expect(valued).toStrictEqual({ path: [HEADERS_FIELD, "Accept"], value: "text/plain" });
  });

  /**
   * The checkbox is controlled by the projection, so an edit that comes out identical to what is
   * already in `tab.edits` is a checkbox that visibly snaps back. `editPairEnabled` used to patch
   * `disabled: true` onto an entry that already carried it, which made switching a row off work
   * and switching it back on do nothing at all - in every grid, not only form data.
   */
  it("givenADisabledPair_whenSwitchedBackOn_thenTheEntryLosesTheDisabledFlag", () => {
    const list = readPairs({ formdata: [{ key: "note", value: "hi", disabled: true }] }, FORMDATA_FIELD);

    const [enabled] = editPairEnabled(FORMDATA_FIELD, list, list.pairs[0]!, false);
    const [disabled] = editPairEnabled(FORMDATA_FIELD, list, list.pairs[0]!, true);

    expect(enabled).toStrictEqual({ path: [FORMDATA_FIELD], value: [{ key: "note", value: "hi" }] });
    expect(disabled).toStrictEqual({ path: [FORMDATA_FIELD], value: [{ key: "note", value: "hi", disabled: true }] });
    // The round trip the grid actually performs: what it writes is what it reads back.
    expect(readPairs(project({}, [enabled!]), FORMDATA_FIELD).pairs[0]?.disabled).toBe(false);
  });

  /**
   * The grid models three fields and a form-data entry has six. Every pair edit rewrites the whole
   * array, so anything the grid does not model has to be carried through: rebuilding the entry
   * from `key`/`value`/`disabled` alone turned a file upload into an empty text field, and core
   * then refused the run with `formdata field "avatar" has no file source`.
   */
  it("givenAFormDataFileField_whenAnotherRowIsToggled_thenItsSourceSurvives", () => {
    const file = { key: "avatar", type: "file", src: "upload/a.png", contentType: "image/png" };
    const list = readPairs({ formdata: [{ key: "note", value: "hi" }, file] }, FORMDATA_FIELD);

    const [change] = editPairEnabled(FORMDATA_FIELD, list, list.pairs[0]!, true);
    const carried = readPairs(project({}, [change!]), FORMDATA_FIELD).pairs[1]?.source;

    expect(carried).toMatchObject({ type: "file", src: "upload/a.png", contentType: "image/png" });
  });

  it("givenTextWithBlankLinesAndComments_whenParsed_thenTheyAreSkipped", () => {
    const pairs = textToPairs("# a note\n\nAccept: application/json\n   \n// Off: yes\n: novalue\n");

    expect(pairs).toStrictEqual([
      { key: "Accept", value: "application/json" },
      { key: "Off", value: "yes", disabled: true },
    ]);
  });
});

/**
 * Creating a workspace, from the seam the renderer actually has.
 *
 * The filesystem half is `test/desktop.workspace.test.ts`; what is left here is the rule that makes
 * the dialog honest. A refusal has to come back as a value and change nothing — not open a host,
 * not reorder Recents — because the dialog is still on screen showing the name that caused it.
 */
/**
 * The gRPC request bar's two halves of one YAML string: the lock owns `grpcs://`, the field owns
 * the authority. What these assert is the string that lands in `url`, because that is the only
 * thing `grpc/target.ts` reads to decide TLS.
 */
describe("the gRPC url split between the lock and the field", () => {
  const GRPC = { $kind: "grpc-request" };

  it("givenPinnedUrl_whenRead_thenSchemeIsTheLockAndAuthorityIsTheField", () => {
    expect(readGrpcUrl({ ...GRPC, url: "grpcs://{{grpc_url}}" })).toEqual({
      tls: true,
      authority: "{{grpc_url}}",
    });
  });

  it("givenBareAuthority_whenRead_thenUnpinned", () => {
    expect(readGrpcUrl({ ...GRPC, url: "{{grpc_url}}" })).toEqual({ tls: false, authority: "{{grpc_url}}" });
  });

  it("givenBareAuthority_whenPinning_thenWritesGrpcsAheadOfIt", () => {
    const data = { ...GRPC, url: "{{grpc_url}}" };
    expect(editGrpcTls(data, true)).toEqual([edit(FIELD.url, "grpcs://{{grpc_url}}")]);
  });

  // Not `grpc://`: core strips it and `shouldUseTls` still turns TLS on for `:443`, so writing it
  // would be the editor claiming a plaintext call it cannot deliver.
  it("givenPinnedUrl_whenUnpinning_thenDropsTheSchemeRatherThanWritingGrpc", () => {
    const data = { ...GRPC, url: "grpcs://api.example:443" };
    expect(editGrpcTls(data, false)).toEqual([edit(FIELD.url, "api.example:443")]);
  });

  // The field never shows the scheme, so "no scheme typed" cannot mean "no TLS" - that would
  // unlock the request on any edit to its host.
  it("givenPinnedUrl_whenEditingTheAuthority_thenKeepsTheScheme", () => {
    const data = { ...GRPC, url: "grpcs://old.example:443" };
    expect(editGrpcAuthority(data, "new.example:443")).toEqual([edit(FIELD.url, "grpcs://new.example:443")]);
  });

  // A scheme typed into the field is the lock's, not text: it moves the toggle instead of being
  // kept, so a pasted full url still lands as one scheme and one authority.
  it("givenPastedSchemeInTheField_whenCommitted_thenMovesTheLockRatherThanKeepingTheText", () => {
    const data = { ...GRPC, url: "{{grpc_url}}" };
    expect(editGrpcAuthority(data, "grpcs://api.example:443")).toEqual([edit(FIELD.url, "grpcs://api.example:443")]);
  });

  it("givenPinnedUrl_whenPastingAPlaintextScheme_thenUnpins", () => {
    const data = { ...GRPC, url: "grpcs://api.example:443" };
    expect(editGrpcAuthority(data, "grpc://api.example:9090")).toEqual([edit(FIELD.url, "api.example:9090")]);
  });
});

describe("acquiring a workspace from the window", () => {
  let bridge: FakeBridge;

  beforeEach(() => {
    resetStores();
    bridge = fakeBridge();
    installBridge(bridge.bridge);
  });

  afterEach(() => {
    uninstallBridge();
    resetStores();
  });

  it("givenWorkspaceCreationSucceeds_whenCreateNewWorkspaceRuns_thenItOpensAndRefreshesRecents", async () => {
    bridge.answerCreate({ ok: true, root: NEW_WORKSPACE_ROOT });

    const result = await createNewWorkspace(NEW_WORKSPACE_NAME);

    expect(result).toEqual({ ok: true, root: NEW_WORKSPACE_ROOT });
    // The name crosses, never a path: main is the only side that knows where a new workspace goes.
    expect(bridge.created()).toEqual([NEW_WORKSPACE_NAME]);
    // Opened through the same call a recent workspace takes, and Recents read back afterwards.
    expect(bridge.opened()).toEqual([NEW_WORKSPACE_ROOT]);
    expect(bridge.lists()).toBeGreaterThan(NO_CALLS);
  });

  it("givenWorkspaceCreationFails_whenCreateNewWorkspaceRuns_thenItReturnsTheErrorWithoutOpening", async () => {
    bridge.answerCreate({ ok: false, message: CREATE_REFUSAL });

    const result = await createNewWorkspace(NEW_WORKSPACE_NAME);

    expect(result).toEqual({ ok: false, message: CREATE_REFUSAL });
    expect(bridge.created()).toEqual([NEW_WORKSPACE_NAME]);
    // Nothing else moved: no host asked for, no Recents read, no session state touched.
    expect(bridge.opened()).toHaveLength(NO_CALLS);
    expect(bridge.lists()).toBe(NO_CALLS);
    expect(useSessionStore.getState().root).toBeNull();
  });

  it("givenMigrationSucceeds_whenMigrateFromPostmanRuns_thenItOpensAndRefreshesRecents", async () => {
    bridge.answerMigrate({
      status: "migrated",
      outcome: {
        root: MIGRATED_ROOT,
        workspaceName: MIGRATED_NAME,
        counts: { collection: 2, "grpc-request": 1 },
        skipped: [{ path: "Adapter/Legacy Socket", kind: "websocket-request" }],
      },
    });

    const result = await migrateFromPostman(CLOUD_WORKSPACE_ID);

    expect(result.status).toBe("migrated");
    // An id crosses, never a destination: main owns the dialog that names where it went.
    expect(bridge.migrated()).toEqual([CLOUD_WORKSPACE_ID]);
    // Opened through the same call a recent workspace takes, and Recents read back afterwards.
    expect(bridge.opened()).toEqual([MIGRATED_ROOT]);
    expect(bridge.lists()).toBeGreaterThan(NO_CALLS);
  });

  it("givenMigrationFails_whenMigrateFromPostmanRuns_thenItReturnsTheErrorWithoutOpening", async () => {
    bridge.answerMigrate({ status: "failed", message: MIGRATE_REFUSAL, details: [MIGRATE_ADVICE] });

    const result = await migrateFromPostman(CLOUD_WORKSPACE_ID);

    // The advice survives the crossing: the pane says both lines, so `details[]` is not folded in.
    expect(result).toEqual({ status: "failed", message: MIGRATE_REFUSAL, details: [MIGRATE_ADVICE] });
    expect(bridge.opened()).toHaveLength(NO_CALLS);
    expect(bridge.lists()).toBe(NO_CALLS);
    expect(useSessionStore.getState().root).toBeNull();
  });

  it("givenTheDestinationDialogIsDismissed_whenMigrateFromPostmanRuns_thenNothingIsOpened", async () => {
    bridge.answerMigrate({ status: "cancelled" });

    const result = await migrateFromPostman(CLOUD_WORKSPACE_ID);

    expect(result).toEqual({ status: "cancelled" });
    expect(bridge.opened()).toHaveLength(NO_CALLS);
  });
});

describe("drafts across a crash", () => {
  let workspace: ClonedWorkspace;
  let host: EngineHost;
  let bridge: FakeBridge;

  beforeEach(() => {
    resetStores();
    workspace = cloneFixtureWorkspace();
    host = createEngineHost({ root: workspace.root, post: () => undefined });
    bridge = fakeBridge();
    installBridge(bridge.bridge);
  });

  afterEach(() => {
    host.dispose();
    uninstallBridge();
    resetStores();
    workspace.cleanup();
  });

  /**
   * The whole promise of the draft layer in one test: an unsaved edit and a folded tree come back,
   * and the workspace on disk is byte-for-byte what it was. An editor that recovered work by
   * writing it into the repository would be recovering it into somebody's next commit.
   */
  it("givenDraftAndCrash_whenReopened_thenDraftIsRestoredAndWorkspaceIsClean", async () => {
    const client = hostClient(host, workspace.root);
    const before = bytesOf(workspace.root);

    // ---- the session that crashes -------------------------------------------------------
    useSessionStore.getState().setClient(client, workspace.root);
    useCatalogStore.getState().replace(await client.send("catalog", {}));
    const stop = startPersistence(workspace.root);

    const ping = useCatalogStore.getState().byId.get(PING_ID);
    expect(ping).toBeDefined();
    useTabsStore.getState().open(ping!);
    useTabsStore.getState().loaded(PING_ID, await client.send("read-node", { nodeId: PING_ID }));
    useTabsStore.getState().setField(PING_ID, FIELD.url, "https://unsaved.test/ping");
    useTabsStore.getState().setText(PING_ID, "# a raw yaml draft\n");
    useCatalogStore.getState().toggle(ADMIN_ID);
    useSessionStore.getState().setEnvironment("LOCAL");

    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
    expect(bridge.writes()).toBeGreaterThan(0);

    const snapshot = bridge.saved();
    expect(snapshot?.drafts).toHaveLength(1);
    expect(snapshot?.collapsedIds).toStrictEqual([ADMIN_ID]);
    expect(snapshot?.activeEnvironment).toBe("LOCAL");

    // ---- the crash ----------------------------------------------------------------------
    stop();
    resetStores();
    expect(useTabsStore.getState().tabs.size).toBe(0);

    // ---- the reopen ---------------------------------------------------------------------
    useSessionStore.getState().setClient(client, workspace.root);
    const restored = await readSession(workspace.root);
    restoreCollapse(restored);
    useCatalogStore.getState().replace(await client.send("catalog", {}));
    const opened = restoreOpenState(restored);

    expect(opened).toStrictEqual([PING_ID]);
    const tab = useTabsStore.getState().tabs.get(PING_ID);
    expect(tab?.edits).toStrictEqual([{ path: FIELD.url, value: "https://unsaved.test/ping" }]);
    expect(tab?.text).toBe("# a raw yaml draft\n");
    expect(isDirty(tab!)).toBe(true);
    expect(useCatalogStore.getState().collapsed.has(ADMIN_ID)).toBe(true);
    expect(useSessionStore.getState().environment).toBe("LOCAL");

    // ---- and the repository never heard about any of it ---------------------------------
    expect(bytesOf(workspace.root)).toStrictEqual(before);
  });

  it("givenASessionNamingFilesThatAreGone_whenRestored_thenOnlySurvivorsOpen", async () => {
    const client = hostClient(host, workspace.root);
    useSessionStore.getState().setClient(client, workspace.root);
    bridge.seed({
      activeEnvironment: "NOPE",
      activeNodeId: "postman/collections/payment/Gone.request.yaml",
      collapsedIds: [PAYMENT_ID],
      tabs: [
        { nodeId: PING_ID, subTab: "headers" },
        { nodeId: "postman/collections/payment/Gone.request.yaml", subTab: null },
      ],
      drafts: [{ nodeId: "postman/collections/payment/Gone.request.yaml", edits: [], text: "orphan" }],
    });

    const restored = await readSession(workspace.root);
    restoreCollapse(restored);
    useCatalogStore.getState().replace(await client.send("catalog", {}));
    const opened = restoreOpenState(restored);

    expect(opened).toStrictEqual([PING_ID]);
    expect(useTabsStore.getState().tabs.get(PING_ID)?.subTab).toBe("headers");
    // An environment the workspace no longer has is not adopted: the picker would be naming
    // something the next run cannot use.
    expect(useSessionStore.getState().environment).not.toBe("NOPE");
  });

  it("givenAMalformedDraft_whenRestored_thenTheBadEditIsDroppedAndTheRestSurvives", async () => {
    const client = hostClient(host, workspace.root);
    useSessionStore.getState().setClient(client, workspace.root);
    bridge.seed({
      activeEnvironment: null,
      activeNodeId: PING_ID,
      collapsedIds: [],
      tabs: [{ nodeId: PING_ID, subTab: "nonsense" }],
      // App data is JSON and hand-editable, so one unusable entry must cost one field, not the
      // whole draft.
      drafts: [
        { nodeId: PING_ID, edits: [{ path: ["url", "raw"], value: "kept" }, { path: "nope" }, 7, null], text: null },
      ],
    });

    const restored = await readSession(workspace.root);
    useCatalogStore.getState().replace(await client.send("catalog", {}));
    restoreOpenState(restored);

    const tab = useTabsStore.getState().tabs.get(PING_ID);
    expect(tab?.edits).toStrictEqual([{ path: ["url", "raw"], value: "kept" }]);
    // An unrecognised sub-tab falls back rather than being written into the tab.
    expect(tab?.subTab).toBe("body");
  });

  /**
   * "None" is an answer, and it has to survive a reopen. If a remembered `null` were treated as a
   * missing choice, a workspace with one environment would adopt it again on every launch and put
   * values back into requests that were deliberately being run without them.
   */
  it("givenASessionThatChoseNoEnvironment_whenRestored_thenNoneComesBack", async () => {
    const client = hostClient(host, workspace.root);
    useSessionStore.getState().setClient(client, workspace.root);
    bridge.seed({ ...emptySnapshot(), activeEnvironment: null });

    const restored = await readSession(workspace.root);
    useCatalogStore.getState().replace(await client.send("catalog", {}));
    restoreOpenState(restored);

    expect(useSessionStore.getState().environment).toBeNull();
  });

  it("givenASessionThatNeverChose_whenRestored_thenTheChoiceIsStillOpen", async () => {
    const client = hostClient(host, workspace.root);
    useSessionStore.getState().setClient(client, workspace.root);
    bridge.seed(emptySnapshot());

    const restored = await readSession(workspace.root);
    useCatalogStore.getState().replace(await client.send("catalog", {}));
    restoreOpenState(restored);

    // Still open, so `adoptSoleEnvironment` is allowed to answer it.
    expect(useSessionStore.getState().environment).toBeUndefined();
  });
});

/**
 * The picker's own creation, against a real engine.
 *
 * The `post` here is `route`'s catalog arm and nothing more, because that arm is the only reason
 * the action can select what it just made: the host publishes the new catalog before it answers
 * the mutation, and messages arrive in order, so a store fed by pushes already holds the entry by
 * the time the promise resolves. A harness that dropped pushes would be proving the opposite of
 * what the app does.
 */
describe("creating an environment", () => {
  let workspace: ClonedWorkspace;
  let host: EngineHost;

  beforeEach(async () => {
    resetStores();
    workspace = cloneFixtureWorkspace();
    host = createEngineHost({
      root: workspace.root,
      post: (message) => {
        if ("push" in message && message.push === "catalog") useCatalogStore.getState().replace(message.catalog);
      },
    });
    const client = hostClient(host, workspace.root);
    useSessionStore.getState().setClient(client, workspace.root);
    // The window always has a catalog before it has a picker; a refusal pushes no new one, so
    // without this the "nothing changed" assertion below would be comparing an empty store.
    useCatalogStore.getState().replace(await client.send("catalog", {}));
  });

  afterEach(() => {
    host.dispose();
    resetStores();
    workspace.cleanup();
  });

  it("givenAnUnsafeName_whenCreateEnvironment_thenTheSanitisedOneIsSelected", async () => {
    const outcome = await createEnvironment("QC/east");

    expect(outcome).toStrictEqual({ ok: true });
    // The name that reached disk, not the name that was typed. Selecting by node id is what makes
    // the difference invisible here; a picker that stored the typed name would name nothing.
    expect(useSessionStore.getState().environment).toBe("QC east");
    expect(useCatalogStore.getState().environments.map((entry) => entry.name)).toStrictEqual(["LOCAL", "QC east"]);
  });

  it("givenATakenName_whenCreateEnvironment_thenRefusedAndTheChoiceIsUntouched", async () => {
    // Differently cased on purpose: `-e local` already reaches `LOCAL`, so this name is taken.
    const outcome = await createEnvironment("local");

    if (outcome.ok) throw new Error("expected the taken name to be refused");
    expect(outcome.message).toContain("already exists");
    expect(useSessionStore.getState().environment).toBeUndefined();
    expect(useCatalogStore.getState().environments).toHaveLength(1);
  });
});

describe("what the collection runner reads off a run", () => {
  beforeEach(resetStores);
  afterEach(resetStores);

  function apply(event: RunEvent): void {
    useRunsStore.getState().apply(event);
  }

  function testResult(name: string, status: TestResult["status"]): TestResult {
    return { name, status, error: undefined, origin: { level: "request", label: "request" } };
  }

  /**
   * The runner's list, its `#N` labels and its progress count are all this one derivation. The
   * iteration count is taken from the events rather than from the options, because with a data
   * file and no explicit count core decides the number and the options never learn it.
   */
  it("givenAnIteratedFolderRun_whenEventsArrive_thenItemsAndIterationsFollowTheEvents", () => {
    apply({ type: "run-start", runId: RUN_ID, total: ITERATED_TOTAL });
    expect(useRunsStore.getState().runs.get(RUN_ID)?.iterations).toBe(FIRST_ITERATION_COUNT);

    for (const iteration of [0, 1]) {
      for (const nodeId of [PING_ID, PROFILE_ID]) {
        apply({ type: "request-start", runId: RUN_ID, nodeId, name: nodeId, iteration });
        apply({ type: "request-end", runId: RUN_ID, nodeId, exitCode: EXIT_CODES.OK });
      }
    }

    const run = useRunsStore.getState().runs.get(RUN_ID);
    expect(run?.items).toStrictEqual([`${PING_ID}#0`, `${PROFILE_ID}#0`, `${PING_ID}#1`, `${PROFILE_ID}#1`]);
    expect(run?.iterations).toBe(ITERATION_COUNT);
    // The first item focuses itself, so a run shows a response without a click.
    expect(useRunsStore.getState().activeItemKey).toBe(`${PING_ID}#0`);
  });

  /**
   * The bug this pins cost a blank window: the summary folded its totals *inside* a store selector,
   * which allocated a fresh object on every call, and a snapshot that is never reference-equal to
   * itself spins React until it throws. Totals are accumulated by the store as the events arrive,
   * so reading one twice hands back the same object — and the fold is linear in the run rather
   * than quadratic.
   */
  it("givenAssertionsAcrossAnIteration_whenCounted_thenTheRunHoldsStableTotals", () => {
    apply({ type: "run-start", runId: RUN_ID, total: ITERATED_TOTAL });
    apply({ type: "request-start", runId: RUN_ID, nodeId: PING_ID, name: "Ping", iteration: FIRST_ITERATION });
    apply({ type: "test", runId: RUN_ID, nodeId: PING_ID, result: testResult("first", "passed") });
    apply({ type: "test", runId: RUN_ID, nodeId: PING_ID, result: testResult("second", "failed") });

    const tests = useRunsStore.getState().runs.get(RUN_ID)?.tests;
    expect(tests).toStrictEqual({ passed: 1, failed: 1, skipped: 0, total: 2 });
    expect(useRunsStore.getState().runs.get(RUN_ID)?.tests).toBe(tests);
  });

  /** A row must repaint alone, for the same reason a sidebar row does: a run is thousands of them. */
  it("givenTwoItemsInARun_whenOneReceivesAResponse_thenTheOtherObjectIsUntouched", () => {
    apply({ type: "run-start", runId: RUN_ID, total: ITERATED_TOTAL });
    apply({ type: "request-start", runId: RUN_ID, nodeId: PING_ID, name: "Ping", iteration: FIRST_ITERATION });
    apply({ type: "request-start", runId: RUN_ID, nodeId: PROFILE_ID, name: "Profile", iteration: FIRST_ITERATION });

    const untouchedBefore = useRunsStore.getState().requests.get(`${PING_ID}#0`);
    apply({ type: "request-end", runId: RUN_ID, nodeId: PROFILE_ID, exitCode: EXIT_CODES.TEST });

    expect(useRunsStore.getState().requests.get(`${PING_ID}#0`)).toBe(untouchedBefore);
    expect(useRunsStore.getState().requests.get(`${PROFILE_ID}#0`)?.exitCode).toBe(EXIT_CODES.TEST);
  });

  /**
   * `run-end` cannot be relied on - a run that dies on its selector never emits one - so `finish`
   * is the terminal signal, and it has to leave nothing spinning or the export buttons never
   * enable and a row claims forever that it is still in flight.
   */
  it("givenARunThatDiedMidRequest_whenFinished_thenNothingIsLeftRunning", () => {
    apply({ type: "run-start", runId: RUN_ID, total: ITERATED_TOTAL });
    apply({ type: "request-start", runId: RUN_ID, nodeId: PING_ID, name: "Ping", iteration: FIRST_ITERATION });

    useRunsStore.getState().finish(RUN_ID, {
      warnings: [RUN_WARNING],
      cancelled: true,
      error: { message: "cancelled", details: [], exitCode: EXIT_CODES.TRANSPORT },
    });

    const run = useRunsStore.getState().runs.get(RUN_ID);
    expect(run?.done).toBe(true);
    expect(run?.cancelled).toBe(true);
    expect(run?.warnings).toStrictEqual([RUN_WARNING]);
    expect(useRunsStore.getState().requests.get(`${PING_ID}#0`)?.status).toBe("done");
  });
});

/**
 * The console's three streams. The call is the one that has to be a reference rather than a
 * copy: it mutates three times - sent, head, body - and copying it into the stream would
 * replace the array on every response event and re-run the merge over every row in the run.
 */
describe("what the console reads off a run", () => {
  beforeEach(resetStores);
  afterEach(resetStores);

  function apply(event: RunEvent): void {
    useRunsStore.getState().apply(event);
  }

  function started(nodeId: string, iteration = FIRST_ITERATION): void {
    apply({ type: "run-start", runId: RUN_ID, total: ITERATED_TOTAL });
    apply({ type: "request-start", runId: RUN_ID, nodeId, name: nodeId, iteration });
  }

  function sent(nodeId: string): RunEvent {
    return {
      type: "request-sent",
      runId: RUN_ID,
      nodeId,
      target: `POST https://api.example/${nodeId}`,
      sent: { protocol: "http", method: "POST", url: "https://api.example/", headers: [], body: undefined },
    };
  }

  function logged(text: string, nodeId: string): RunEvent {
    return {
      type: "console",
      runId: RUN_ID,
      nodeId,
      line: { level: "log", text, origin: { level: "request", label: "request" } },
    };
  }

  it("givenRequestSentEvent_whenApplied_thenACallEntryIsAppended", () => {
    started(PING_ID);
    apply(sent(PING_ID));

    const key = `${PING_ID}#${String(FIRST_ITERATION)}`;
    expect(useRunsStore.getState().calls).toStrictEqual([{ runId: RUN_ID, nodeId: PING_ID, seq: 0, itemKey: key }]);
    // A reference, not a copy: the row reads the live item, which is how it repaints as the
    // response lands without the console stream being rebuilt.
    expect(useRunsStore.getState().requests.get(key)?.sent).toMatchObject({ protocol: "http" });
  });

  it("givenRequestSentEvent_whenApplied_thenItsSeqInterleavesWithConsoleLines", () => {
    started(PING_ID);
    apply(logged("pre-request", PING_ID));
    apply(sent(PING_ID));
    apply(logged("post-response", PING_ID));

    const state = useRunsStore.getState();
    // `request-sent` is the first per-request event to mint a `seq`, and it has to come from
    // the same counter or the pre-request log would not sort above the call it belongs to.
    expect(state.console.map((entry) => entry.seq)).toStrictEqual([0, 2]);
    expect(state.calls.map((entry) => entry.seq)).toStrictEqual([1]);
  });

  it("givenMoreCallsThanTheCap_whenApplied_thenTheOldestAreDropped", () => {
    const overflow = 5;
    apply({ type: "run-start", runId: RUN_ID, total: ITERATED_TOTAL });
    for (let index = 0; index < CONSOLE_MAX_LINES + overflow; index += 1) {
      const nodeId = `${PING_ID}/${String(index)}`;
      apply({ type: "request-start", runId: RUN_ID, nodeId, name: nodeId, iteration: FIRST_ITERATION });
      apply(sent(nodeId));
    }

    // `calls` needs its own cap: a run that logs nothing would never trip the console's.
    const calls = useRunsStore.getState().calls;
    expect(calls).toHaveLength(CONSOLE_MAX_LINES);
    expect(calls[0]?.nodeId).toBe(`${PING_ID}/${String(overflow)}`);
  });

  it("givenExpandedCall_whenToggled_thenItCollapses", () => {
    started(PING_ID);
    apply(sent(PING_ID));
    const key = `${PING_ID}#${String(FIRST_ITERATION)}`;

    // Expansion lives in the store because the virtualizer unmounts off-screen rows, so
    // row-local state would silently collapse on scroll.
    useRunsStore.getState().toggleCall(key);
    expect(useRunsStore.getState().expandedCalls.has(key)).toBe(true);

    useRunsStore.getState().toggleCall(key);
    expect(useRunsStore.getState().expandedCalls.has(key)).toBe(false);
  });

  it("givenExpandedCallsAndLogs_whenConsoleCleared_thenAllThreeStreamsAreEmpty", () => {
    started(PING_ID);
    apply(logged("something", PING_ID));
    apply(sent(PING_ID));
    apply({
      type: "side-request",
      runId: RUN_ID,
      nodeId: PING_ID,
      summary: {
        method: "POST",
        url: "https://auth.example/token",
        statusCode: 200,
        statusMessage: "OK",
        message: "",
        ok: true,
        durationMs: 12,
      },
    });
    useRunsStore.getState().toggleCall(`${PING_ID}#${String(FIRST_ITERATION)}`);

    useRunsStore.getState().clearConsole();

    // Missing any one of these is how a cleared console comes back on the next repaint.
    const state = useRunsStore.getState();
    expect(state.console).toStrictEqual([]);
    expect(state.sideRequests).toStrictEqual([]);
    expect(state.calls).toStrictEqual([]);
    expect(state.expandedCalls.size).toBe(0);
  });
});

describe("the overlay over the editor", () => {
  beforeEach(resetStores);
  afterEach(resetStores);

  it("givenTheRunnerUp_whenVariablesAreShown_thenOneOverlayIsUpAtATime", () => {
    const overlay = useOverlayStore.getState();

    overlay.showRunner(PAYMENT_ID);
    expect(useOverlayStore.getState().overlay).toStrictEqual({ kind: "runner", nodeId: PAYMENT_ID });

    overlay.showVariables();
    expect(useOverlayStore.getState().overlay).toStrictEqual({ kind: "variables" });

    overlay.showSettings();
    expect(useOverlayStore.getState().overlay).toStrictEqual({ kind: "settings" });

    overlay.dismiss();
    expect(useOverlayStore.getState().overlay).toBeNull();
  });
});
