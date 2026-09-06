import { renderAuth } from "@preman/core/auth/credentials.js";
import type { PropertyList } from "@preman/core/scripts/property-list.js";
import type { VariableStore } from "@preman/core/vars/store.js";
import type { RequestAuth } from "@preman/core/workspace/schemas.js";

const REPLACED_REMEDY = "delete the auth block to send the metadata instead";

export interface ApplyGrpcAuthOptions {
  auth: RequestAuth | undefined;
  /** Mutated in place; the `auth` block replaces a colliding entry. */
  metadata: PropertyList;
  store: VariableStore;
}

/**
 * gRPC has no header/auth separation, so auth lands in the same metadata map the
 * request already writes. Mirrors `http/auth.ts`: the `auth:` block replaces an
 * entry of the same name written literally in the file.
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

  const existing = metadata.enabled().find((entry) => entry.key.toLowerCase() === rendered.name.toLowerCase());

  // `remove` then `add`, which is what postman-runtime's signers do, rather than
  // `upsert`: `upsert` writes over the first key match whether or not it is
  // enabled, so a disabled entry sitting above an enabled one would be the row
  // that got replaced and the enabled one would still reach the wire. The cost is
  // that the replaced entry moves to the end of the map and that a disabled entry
  // of the same name goes with it — `PropertyList` has no positional write, and
  // metadata order is not observable on the wire.
  metadata.remove(rendered.name);
  // gRPC metadata keys are case-insensitive and @grpc/grpc-js lowercases them
  // anyway, so store the canonical form rather than `Authorization`.
  metadata.add(rendered.name.toLowerCase(), rendered.value);

  if (existing !== undefined) {
    const type = (auth?.type ?? "").trim().toLowerCase();
    warnings.push(`${type} auth replaced request metadata "${existing.key}"; ${REPLACED_REMEDY}`);
  }
  return warnings;
}
