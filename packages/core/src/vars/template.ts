/**
 * One authored string, resolved twice.
 *
 * A pre-request script that sets a variable sets it so the request it precedes can use it — that
 * is the entire point of the hook, and resolving the request before the script ran meant the
 * value only reached the wire on the *next* run, via the environment writeback. So the request is
 * resolved once before the scripts, because that is what `pm.request` has to show them, and again
 * after, because that is what goes on the wire.
 *
 * A field the script assigned is taken verbatim: the script is a later authority than the file it
 * overrode. A field it only read is resolved again from the file, which is a no-op for every
 * variable the scripts did not touch. See decision 039.
 */
import { interpolate, interpolateStrict, type DynamicSamples } from "./interpolate.js";
import type { VariableStore } from "./store.js";

export interface TemplateOptions {
  /**
   * Fail on the first resolution too.
   *
   * Off by default, and that is the point: the first resolution exists only so the scripts have
   * something to read, and a script that is about to define `{{app_time}}` must not be stopped
   * before it runs by the fact that nothing has defined it yet. The wire is the second
   * resolution, which is strict either way, so nothing reaches a server with braces still in it.
   *
   * On for the two fields that are consumed before the second resolution can rescue them - a url
   * that has to resolve to a host, and a method path that has to name a method in a schema. A
   * literal token there fails later and further from the cause.
   */
  strict?: boolean;
}

export class Template {
  readonly #source: string;
  readonly #label: string;
  /** Carried between the two resolutions so the body a script signed is the body that is sent. */
  readonly #samples: DynamicSamples = [];
  readonly #resolved: string;

  constructor(source: string, store: VariableStore, label: string, options: TemplateOptions = {}) {
    this.#source = source;
    this.#label = label;
    this.#resolved =
      options.strict === true
        ? interpolateStrict(source, store, label, this.#samples)
        : interpolate(source, store, this.#samples).text;
  }

  /** What the pre-request scripts were handed. */
  get resolved(): string {
    return this.#resolved;
  }

  /**
   * What goes on the wire, resolved strictly either way: nothing reaches a server with braces
   * still in it, whoever put them there.
   *
   * `current` is what the request holds now. If it is what the scripts were handed, the file's own
   * text is resolved again and the scripts' variables are in it. If it is anything else the
   * scripts wrote it, so there is no template under it - but a script that rebuilt the body from
   * the one it read is carrying that body's unresolved tokens, and this is where they resolve.
   */
  send(current: string, store: VariableStore): string {
    if (current === this.#resolved) return this.resend(store);
    // Its own samples: a `{{$guid}}` a script typed is a guid a script asked for.
    return interpolateStrict(current, store, this.#label);
  }

  /** {@link send} for a caller that already knows the scripts left this one alone. */
  resend(store: VariableStore): string {
    return interpolateStrict(this.#source, store, this.#label, this.#samples);
  }
}

/**
 * A header, metadata or query entry, structurally.
 *
 * Spelled here rather than imported so this module owes nothing to the `pm` shim: the shim
 * already reaches this way, and the arrow may not point both ways.
 */
export interface Entry {
  key: string;
  value: string;
  disabled?: boolean;
}

/** The subset of a `PropertyList` a second resolution needs. */
export interface EntryList {
  all(): Entry[];
  upsert(entry: Entry): void;
}

export interface ResolvedList {
  /** Every entry with its value resolved, in authored order. */
  entries: Entry[];
  /**
   * The template behind each entry, by lower-cased key — but only for keys the file uses once.
   * A script may add, remove and reorder entries, so a duplicated key cannot be matched back to
   * whichever of its templates it came from, and re-resolving the wrong one is worse than
   * leaving both exactly as the scripts saw them.
   */
  templates: Map<string, Template>;
}

/** Resolve a header, metadata or query list, keeping what it takes to resolve it again. */
export function resolveList(
  entries: readonly Entry[],
  store: VariableStore,
  label: (key: string) => string,
): ResolvedList {
  const seen = new Set<string>();
  const duplicated = new Set<string>();
  for (const { key } of entries) {
    const lower = key.toLowerCase();
    if (seen.has(lower)) duplicated.add(lower);
    seen.add(lower);
  }

  const templates = new Map<string, Template>();
  const resolved: Entry[] = entries.map((entry) => {
    // A disabled entry is passed through untouched, which is also why it gets no template.
    if (entry.disabled === true) return { ...entry };
    const template = new Template(entry.value, store, label(entry.key));
    const lower = entry.key.toLowerCase();
    if (!duplicated.has(lower)) templates.set(lower, template);
    return { ...entry, value: template.resolved };
  });

  return { entries: resolved, templates };
}

/** Resolve a list again in place, leaving whatever the scripts wrote alone. */
export function resolveListAgain(list: EntryList, templates: Map<string, Template>, store: VariableStore): void {
  for (const entry of list.all()) {
    if (entry.disabled === true) continue;
    const template = templates.get(entry.key.toLowerCase());
    if (template === undefined) continue;
    const value = template.send(entry.value, store);
    // An entry the auth block added has no template, and one nobody changed needs no write.
    if (value !== entry.value) list.upsert({ ...entry, value });
  }
}
