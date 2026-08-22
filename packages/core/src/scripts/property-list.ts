import { PremanError } from "@preman/core/errors.js";

export const FROZEN_REQUEST_MESSAGE = "pm.request is read-only after the request has been sent";
const MISSING_KEY_MESSAGE = "add() needs a key";

export interface Property {
  key: string;
  value: string;
  disabled?: boolean;
}

export interface PropertyListOptions {
  /** Headers compare keys case-insensitively; query and form params do not. */
  caseInsensitive: boolean;
  /** Human label used in error messages, e.g. "request headers". */
  label: string;
  /** Internal hook used by URL to stop preserving the authored query verbatim. */
  onChange?: () => void;
}

export class PropertyList {
  readonly #entries: Property[];
  readonly #options: PropertyListOptions;
  #frozen = false;

  constructor(entries: Property[], options: PropertyListOptions) {
    this.#entries = entries.map((entry) => ({ ...entry }));
    this.#options = options;
  }

  add(entry: Property | string, value?: string): void {
    this.#assertMutable();
    this.#entries.push(this.#normalizeEntry(entry, value));
    this.#options.onChange?.();
  }

  upsert(entry: Property | string, value?: string): void {
    this.#assertMutable();
    const normalized = this.#normalizeEntry(entry, value);
    const index = this.#entries.findIndex((candidate) => this.#keysMatch(candidate.key, normalized.key));
    if (index === -1) {
      this.#entries.push(normalized);
      this.#options.onChange?.();
      return;
    }
    this.#entries[index] = normalized;
    this.#options.onChange?.();
  }

  remove(key: string): void {
    this.#assertMutable();
    let changed = false;
    for (let index = this.#entries.length - 1; index >= 0; index -= 1) {
      if (this.#keysMatch(this.#entries[index]!.key, key)) {
        this.#entries.splice(index, 1);
        changed = true;
      }
    }
    if (changed) this.#options.onChange?.();
  }

  get(key: string): string | undefined {
    return this.#entries.find((entry) => this.#keysMatch(entry.key, key))?.value;
  }

  has(key: string): boolean {
    return this.#entries.some((entry) => this.#keysMatch(entry.key, key));
  }

  count(): number {
    return this.#entries.length;
  }

  idx(index: number): Property | undefined {
    const entry = this.#entries[index];
    return entry === undefined ? undefined : { ...entry };
  }

  all(): Property[] {
    return this.#entries.map((entry) => ({ ...entry }));
  }

  each(fn: (entry: Property) => void): void {
    this.#entries.forEach((entry) => fn({ ...entry }));
  }

  map<T>(fn: (entry: Property) => T): T[] {
    return this.#entries.map((entry) => fn({ ...entry }));
  }

  filter(fn: (entry: Property) => boolean): Property[] {
    return this.#entries.filter((entry) => fn({ ...entry })).map((entry) => ({ ...entry }));
  }

  toObject(): Record<string, string> {
    const result: Record<string, string> = {};
    for (const entry of this.#entries) {
      const key = this.#options.caseInsensitive ? entry.key.toLowerCase() : entry.key;
      result[key] = entry.value;
    }
    return result;
  }

  toJSON(): Property[] {
    return this.all();
  }

  enabled(): Property[] {
    return this.#entries.filter((entry) => entry.disabled !== true).map((entry) => ({ ...entry }));
  }

  freeze(): void {
    this.#frozen = true;
    Object.freeze(this);
  }

  #assertMutable(): void {
    if (this.#frozen) throw new PremanError(FROZEN_REQUEST_MESSAGE);
  }

  #normalizeEntry(entry: Property | string, value?: string): Property {
    const normalized = typeof entry === "string" ? { key: entry, value: value ?? "" } : { ...entry };
    if (typeof normalized.key !== "string" || normalized.key.length === 0) {
      throw new PremanError(MISSING_KEY_MESSAGE, { details: [`Could not add to ${this.#options.label}.`] });
    }
    normalized.value ??= "";
    return normalized;
  }

  #keysMatch(left: string, right: string): boolean {
    if (!this.#options.caseInsensitive) return left === right;
    return left.toLowerCase() === right.toLowerCase();
  }
}
