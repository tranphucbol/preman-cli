/**
 * What importing a pasted command would produce, as a value.
 *
 * The plan touches no disk (`api/import.ts` owns the one call that does, `planSpecs`), so
 * `--dry-run` and the desktop's preview are the same value rendered twice rather than a second
 * code path (decision 7). `contents` is the YAML that would be written, so what the preview
 * shows and what lands on disk cannot drift.
 */
import type { SpecPlan } from "@preman/core/api/specs.js";
import type { RequestKind } from "@preman/core/api/mutate.js";
import type { CommandFormat } from "@preman/core/command/format.js";
import type { GrpcRequest, HttpRequest } from "@preman/core/workspace/schemas.js";

/**
 * A flag the command carried that a request file has no field for.
 *
 * Named, never counted and never silent: a `-k` that vanishes is a request that will fail
 * against a self-signed certificate for a reason nothing on screen mentions (decision 13).
 */
export interface DroppedFlag {
  /** As the user wrote it, so it can be found in the paste. */
  readonly flag: string;
  /** One clause saying why, and where the capability lives instead. */
  readonly reason: string;
}

export interface ImportPlan {
  readonly format: CommandFormat;
  readonly kind: RequestKind;
  /** The proposed request name; the front ends let it be overridden. */
  readonly name: string;
  /** Validated against the schema the runner will use, at plan time (decision 6). */
  readonly request: HttpRequest | GrpcRequest;
  /** The exact YAML `applyImportPlan` would write, minus the `order` the destination decides. */
  readonly contents: string;
  readonly dropped: readonly DroppedFlag[];
  /** Advice a person should read before pressing Import; never a reason to refuse. */
  readonly warnings: readonly string[];
  /** The `.proto` declarations a `grpcurl -proto` would also need. `null` for everything else. */
  readonly specs: SpecPlan | null;
}
