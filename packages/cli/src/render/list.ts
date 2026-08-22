import pc from "picocolors";
import type { WorkspaceSnapshot } from "@preman/core/api/inspect.js";

const GRPC_KIND = "grpc-request";
const JSON_INDENT = 2;

export interface ListRenderOptions {
  json: boolean;
  verbose: boolean;
}

/** `includeDirs` is deliberately omitted: `--json` has never carried it. */
function listJson(snapshot: WorkspaceSnapshot): string {
  return JSON.stringify(
    {
      root: snapshot.root,
      workspaceId: snapshot.workspaceId,
      requests: snapshot.requests.map((r) => ({ path: r.path, name: r.name, kind: r.kind, file: r.file })),
      environments: snapshot.environments.map((e) => ({ name: e.name, file: e.file, keys: e.keys })),
      specs: snapshot.specs,
    },
    null,
    JSON_INDENT,
  );
}

export function renderList(snapshot: WorkspaceSnapshot, options: ListRenderOptions): string {
  if (options.json) return listJson(snapshot);

  const lines: string[] = [pc.dim(`workspace ${snapshot.root}`), ""];

  if (snapshot.requests.length === 0) {
    lines.push(pc.yellow("no requests found under postman/collections"));
  } else {
    lines.push(pc.bold("requests"));
    let currentGroup = "";
    for (const request of snapshot.requests) {
      const group = [request.collection, ...request.folders].join("/");
      if (group !== currentGroup) {
        lines.push(`  ${pc.cyan(group)}`);
        currentGroup = group;
      }
      const kind = request.kind === GRPC_KIND ? pc.dim("grpc") : pc.yellow(request.kind);
      lines.push(`    ${request.name}  ${kind}`);
    }
  }

  lines.push("", pc.bold("environments"));
  if (snapshot.environments.length === 0) {
    lines.push(pc.yellow("  none"));
  } else {
    for (const env of snapshot.environments) {
      lines.push(`  ${env.name}  ${pc.dim(`${env.keys.length} vars`)}`);
    }
  }

  if (options.verbose) {
    lines.push("", pc.bold(`proto specs (${snapshot.specs.length})`));
    for (const spec of snapshot.specs) lines.push(pc.dim(`  ${spec}`));
    lines.push("", pc.bold(`include dirs (${snapshot.includeDirs.length})`));
    for (const dir of snapshot.includeDirs) lines.push(pc.dim(`  ${dir}`));
  }

  return lines.join("\n");
}
