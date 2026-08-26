/**
 * The value a migration produces before anything touches the disk.
 *
 * A plan is the whole output of conversion, so `--dry-run` is not a second code path: it is
 * the same plan, printed instead of applied (ADR 033).
 */

/** One file the migration would write, addressed relative to the workspace root, posix form. */
export interface PlannedFile {
  readonly relativePath: string;
  readonly contents: string;
}

/** An item Postman had and preman has no representation for. Reported, never silently dropped. */
export interface SkippedItem {
  /** Where it sat in the Postman tree, e.g. `Adapter/Legacy Socket`. */
  readonly path: string;
  /** Postman's `$kind`, quoted verbatim so the report names what it could not carry. */
  readonly kind: string;
}

export interface FilePlan {
  readonly files: readonly PlannedFile[];
  readonly skipped: readonly SkippedItem[];
  /** Keyed by the kind counted: `collection`, `folder`, `environment` and each request kind. */
  readonly counts: Readonly<Record<string, number>>;
}
