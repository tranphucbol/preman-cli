import { listRequests } from "@preman/core/workspace/collections.js";
import { requireWorkspace } from "@preman/core/workspace/discover.js";
import { listEnvironments } from "@preman/core/workspace/environments.js";
import { loadResources } from "@preman/core/workspace/resources.js";

export interface SnapshotRequest {
  path: string;
  name: string;
  kind: string;
  file: string;
  /** Kept separate from `path` so a caller can group without re-parsing it. */
  collection: string;
  folders: string[];
}

export interface SnapshotEnvironment {
  name: string;
  file: string;
  keys: string[];
}

/** Everything an interface needs to describe a workspace without reading it again. */
export interface WorkspaceSnapshot {
  root: string;
  workspaceId: string | null;
  requests: SnapshotRequest[];
  environments: SnapshotEnvironment[];
  specs: string[];
  includeDirs: string[];
}

/** Reads a workspace once and returns it as data; the caller decides what to show. */
export function describeWorkspace(dir: string): WorkspaceSnapshot {
  const ws = requireWorkspace(dir);
  const resources = loadResources(ws);

  return {
    root: ws.root,
    workspaceId: resources.workspaceId ?? null,
    requests: listRequests(ws).map((request) => ({
      path: request.path,
      name: request.name,
      kind: request.kind,
      file: request.filePath,
      collection: request.collection,
      folders: request.folders,
    })),
    environments: listEnvironments(ws).map((environment) => ({
      name: environment.name,
      file: environment.filePath,
      keys: Object.keys(environment.values),
    })),
    specs: resources.specs,
    includeDirs: resources.includeDirs,
  };
}
