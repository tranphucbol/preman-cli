import { renderAuth } from "../auth/credentials.js";
import type { VariableStore } from "../vars/store.js";
import type { RequestAuth } from "../workspace/schemas.js";

export interface ApplyGrpcAuthOptions {
  auth: RequestAuth | undefined;
  /** Mutated in place; an existing `authorization` entry wins. */
  metadata: Record<string, string>;
  store: VariableStore;
}

function findKey(metadata: Record<string, string>, name: string): string | undefined {
  const wanted = name.toLowerCase();
  return Object.keys(metadata).find((key) => key.toLowerCase() === wanted);
}

/**
 * gRPC has no header/auth separation, so auth lands in the same metadata map the
 * request already writes. Mirrors `http/auth.ts`: an entry written literally in
 * the file wins over the `auth:` block.
 */
export function applyGrpcAuth(options: ApplyGrpcAuthOptions): string[] {
  const { auth, metadata, store } = options;
  const { rendered, warnings } = renderAuth(auth, store);

  if (rendered.kind === "none") return warnings;

  if (rendered.kind === "query") {
    // `apikey` with `in: query` has no meaning on the wire for gRPC.
    warnings.push(`apikey auth targets the query string, which gRPC has none of; sending the call unauthenticated`);
    return warnings;
  }

  const existing = findKey(metadata, rendered.name);
  if (existing !== undefined) {
    warnings.push(`request metadata "${existing}" overrides the ${auth?.type.trim().toLowerCase()} auth block`);
    return warnings;
  }

  // gRPC metadata keys are case-insensitive and @grpc/grpc-js lowercases them
  // anyway, so store the canonical form rather than `Authorization`.
  metadata[rendered.name.toLowerCase()] = rendered.value;
  return warnings;
}
