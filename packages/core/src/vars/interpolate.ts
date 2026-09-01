import { PremanError } from "@preman/core/errors.js";
import {
  generateDynamicValue,
  isDynamicVariable,
  isSupportedDynamicVariable,
  unsupportedDynamicVariableDetails,
} from "./dynamic/index.js";
import type { VariableStore } from "./store.js";

/**
 * The source of {@link TOKEN}, for a consumer that may not import this module's `RegExp`: a global
 * regex carries `lastIndex`, so a shared instance is a bug two callers apart.
 */
export const TOKEN_SOURCE = String.raw`\{\{\s*([^{}]+?)\s*\}\}`;

/** `{{ name }}` — inner text may not contain braces, surrounding whitespace is trimmed. */
const TOKEN = new RegExp(TOKEN_SOURCE, "g");

const MAX_DEPTH = 10;

export interface InterpolateResult {
  text: string;
  /** Variable names that could not be resolved, in first-seen order. */
  missing: string[];
  /** Dynamic variables referenced but not implemented, in first-seen order. */
  unsupported: string[];
}

/**
 * The dynamic values one resolution drew, in the order it drew them.
 *
 * Handed back to a second resolution of the same text so it draws the same ones. A request is
 * resolved twice — once for its pre-request scripts to read, once at send time so a variable one
 * of them set is in what goes on the wire — and without this the `{{$guid}}` a script signed
 * would not be the `{{$guid}}` that was sent. Positional rather than by name, because two
 * `{{$guid}}` in one body are deliberately two different guids.
 */
export type DynamicSamples = string[];

/**
 * Substitute `{{...}}` tokens in `text`.
 *
 * Resolution is recursive — a variable whose value contains further tokens is
 * expanded too — bounded by {@link MAX_DEPTH} and guarded against cycles.
 * Unresolvable tokens are left verbatim and reported, so the caller can fail
 * loudly instead of sending literal braces over the wire.
 */
export function interpolate(text: string, store: VariableStore, samples: DynamicSamples = []): InterpolateResult {
  const missing = new Set<string>();
  const unsupported = new Set<string>();
  let drawn = 0;

  const expand = (input: string, depth: number, chain: readonly string[]): string => {
    if (depth > MAX_DEPTH) {
      throw new PremanError(`variable expansion exceeded ${MAX_DEPTH} levels`, {
        details: chain.length > 0 ? [`chain: ${chain.join(" -> ")}`] : [],
      });
    }

    return input.replace(TOKEN, (token, rawName: string) => {
      const name = rawName.trim();

      if (isDynamicVariable(name)) {
        if (!isSupportedDynamicVariable(name)) {
          unsupported.add(name);
          return token;
        }
        // Evaluated per occurrence, and never re-expanded.
        const index = drawn;
        drawn += 1;
        samples[index] ??= generateDynamicValue(name);
        return samples[index];
      }

      if (chain.includes(name)) {
        throw new PremanError(`variable cycle detected: ${[...chain, name].join(" -> ")}`);
      }

      const value = store.get(name);
      if (value === undefined) {
        missing.add(name);
        return token;
      }
      return value.includes("{{") ? expand(value, depth + 1, [...chain, name]) : value;
    });
  };

  return { text: expand(text, 0, []), missing: [...missing], unsupported: [...unsupported] };
}

/** {@link interpolate}, throwing a single actionable error if anything is unresolved. */
export function interpolateStrict(
  text: string,
  store: VariableStore,
  label: string,
  samples: DynamicSamples = [],
): string {
  const result = interpolate(text, store, samples);
  if (result.missing.length === 0 && result.unsupported.length === 0) return result.text;

  const details: string[] = [];
  if (result.missing.length > 0) {
    details.push(`undefined variables: ${result.missing.map((n) => `{{${n}}}`).join(", ")}`);
    details.push("define them in the environment file, or pass --var key=value");
  }
  if (result.unsupported.length > 0) {
    details.push(`unsupported dynamic variables: ${result.unsupported.map((n) => `{{${n}}}`).join(", ")}`);
    for (const name of result.unsupported) details.push(...unsupportedDynamicVariableDetails(name));
  }
  throw new PremanError(`could not resolve all variables in ${label}`, { details });
}
