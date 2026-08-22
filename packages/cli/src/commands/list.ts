import pc from "picocolors";
import { listRequests } from "@preman/core/workspace/collections.js";
import { listEnvironments } from "@preman/core/workspace/environments.js";
import { requireWorkspace } from "@preman/core/workspace/discover.js";
import { loadResources } from "@preman/core/workspace/resources.js";

export interface ListArgs {
  dir: string;
  json: boolean;
  verbose: boolean;
}

export function commandList(args: ListArgs): string {
  const ws = requireWorkspace(args.dir);
  const resources = loadResources(ws);
  const requests = listRequests(ws);
  const environments = listEnvironments(ws);

  if (args.json) {
    return JSON.stringify(
      {
        root: ws.root,
        workspaceId: resources.workspaceId ?? null,
        requests: requests.map((r) => ({ path: r.path, name: r.name, kind: r.kind, file: r.filePath })),
        environments: environments.map((e) => ({ name: e.name, file: e.filePath, keys: Object.keys(e.values) })),
        specs: resources.specs,
      },
      null,
      2,
    );
  }

  const lines: string[] = [pc.dim(`workspace ${ws.root}`), ""];

  if (requests.length === 0) {
    lines.push(pc.yellow("no requests found under postman/collections"));
  } else {
    lines.push(pc.bold("requests"));
    let currentGroup = "";
    for (const request of requests) {
      const group = [request.collection, ...request.folders].join("/");
      if (group !== currentGroup) {
        lines.push(`  ${pc.cyan(group)}`);
        currentGroup = group;
      }
      const kind = request.kind === "grpc-request" ? pc.dim("grpc") : pc.yellow(request.kind);
      lines.push(`    ${request.name}  ${kind}`);
    }
  }

  lines.push("", pc.bold("environments"));
  if (environments.length === 0) {
    lines.push(pc.yellow("  none"));
  } else {
    for (const env of environments) {
      lines.push(`  ${env.name}  ${pc.dim(`${Object.keys(env.values).length} vars`)}`);
    }
  }

  if (args.verbose) {
    lines.push("", pc.bold(`proto specs (${resources.specs.length})`));
    for (const spec of resources.specs) lines.push(pc.dim(`  ${spec}`));
    lines.push("", pc.bold(`include dirs (${resources.includeDirs.length})`));
    for (const dir of resources.includeDirs) lines.push(pc.dim(`  ${dir}`));
  }

  return lines.join("\n");
}
