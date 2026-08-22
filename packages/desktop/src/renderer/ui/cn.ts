/**
 * Class-name joining, deliberately trivial.
 *
 * `clsx` and `tailwind-merge` exist to solve a problem this app does not have: components whose
 * classes are assembled from props at three levels of nesting, where a later `p-4` has to beat an
 * earlier `p-2`. Every component here owns its own classes outright, so a falsy filter and a join
 * is the whole requirement. `.prettierrc.json` already lists `cn` in `tailwindFunctions`, so class
 * order inside these calls is sorted by the formatter either way.
 */
export type ClassValue = string | false | null | undefined;

const SEPARATOR = " ";

export function cn(...values: ClassValue[]): string {
  return values.filter(Boolean).join(SEPARATOR);
}
