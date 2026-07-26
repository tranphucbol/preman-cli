/** Variable scopes, ordered from lowest to highest precedence. */
export const SCOPES = ["globals", "collection", "data", "environment", "local"] as const;
export type Scope = (typeof SCOPES)[number];

/** Highest precedence first — the lookup order used by {@link VariableStore.get}. */
const LOOKUP_ORDER: readonly Scope[] = [...SCOPES].reverse();

/**
 * Layered variable storage mirroring Postman's precedence:
 * local (CLI `--var`) > environment > data > collection > globals.
 *
 * Mutations made by scripts are tracked per scope so the runner knows exactly
 * which keys to persist back to the environment file.
 */
export class VariableStore {
  private readonly scopes: Record<Scope, Map<string, string>>;
  private readonly dirty: Record<Scope, Set<string>>;

  constructor(initial: Partial<Record<Scope, Record<string, string>>> = {}) {
    this.scopes = {
      globals: new Map(Object.entries(initial.globals ?? {})),
      collection: new Map(Object.entries(initial.collection ?? {})),
      data: new Map(Object.entries(initial.data ?? {})),
      environment: new Map(Object.entries(initial.environment ?? {})),
      local: new Map(Object.entries(initial.local ?? {})),
    };
    this.dirty = {
      globals: new Set(),
      collection: new Set(),
      data: new Set(),
      environment: new Set(),
      local: new Set(),
    };
  }

  /** Resolve `key` across all scopes, highest precedence first. */
  get(key: string): string | undefined {
    for (const scope of LOOKUP_ORDER) {
      const value = this.scopes[scope].get(key);
      if (value !== undefined) return value;
    }
    return undefined;
  }

  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  getIn(scope: Scope, key: string): string | undefined {
    return this.scopes[scope].get(key);
  }

  set(scope: Scope, key: string, value: unknown): void {
    const normalised = value == null ? "" : String(value);
    if (this.scopes[scope].get(key) === normalised) return;
    this.scopes[scope].set(key, normalised);
    this.dirty[scope].add(key);
  }

  unset(scope: Scope, key: string): void {
    if (!this.scopes[scope].has(key)) return;
    this.scopes[scope].delete(key);
    // Deletion still counts as a change; persisted as an empty value.
    this.dirty[scope].add(key);
  }

  snapshot(scope: Scope): Record<string, string> {
    return Object.fromEntries(this.scopes[scope]);
  }

  /** Keys changed in `scope` since construction, with their current values. */
  changes(scope: Scope): Record<string, string> {
    const out: Record<string, string> = {};
    for (const key of this.dirty[scope]) out[key] = this.scopes[scope].get(key) ?? "";
    return out;
  }

  hasChanges(scope: Scope): boolean {
    return this.dirty[scope].size > 0;
  }
}
