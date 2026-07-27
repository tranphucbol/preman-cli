import { CliError } from "../errors.js";
import {
  generateDynamicValue,
  isDynamicVariable,
  isSupportedDynamicVariable,
  unsupportedDynamicVariableDetails,
} from "./dynamic/index.js";
import type { VariableStore } from "./store.js";

/** `{{ name }}` — inner text may not contain braces, surrounding whitespace is trimmed. */
const TOKEN = /\{\{\s*([^{}]+?)\s*\}\}/g;

const MAX_DEPTH = 10;

export interface InterpolateResult {
  text: string;
  /** Variable names that could not be resolved, in first-seen order. */
  missing: string[];
  /** Dynamic variables referenced but not implemented, in first-seen order. */
  unsupported: string[];
}

/**
 * Substitute `{{...}}` tokens in `text`.
 *
 * Resolution is recursive — a variable whose value contains further tokens is
 * expanded too — bounded by {@link MAX_DEPTH} and guarded against cycles.
 * Unresolvable tokens are left verbatim and reported, so the caller can fail
 * loudly instead of sending literal braces over the wire.
 */
export function interpolate(text: string, store: VariableStore): InterpolateResult {
  const missing = new Set<string>();
  const unsupported = new Set<string>();

  const expand = (input: string, depth: number, chain: readonly string[]): string => {
    if (depth > MAX_DEPTH) {
      throw new CliError(`variable expansion exceeded ${MAX_DEPTH} levels`, {
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
        return generateDynamicValue(name);
      }

      if (chain.includes(name)) {
        throw new CliError(`variable cycle detected: ${[...chain, name].join(" -> ")}`);
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
export function interpolateStrict(text: string, store: VariableStore, label: string): string {
  const result = interpolate(text, store);
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
  throw new CliError(`could not resolve all variables in ${label}`, { details });
}
