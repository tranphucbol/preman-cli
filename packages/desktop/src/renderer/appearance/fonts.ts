/**
 * The user's typeface, put in front of the one the app ships with.
 *
 * A font preference is a *preference*, not a replacement: naming "Iosevka" says which face to
 * reach for first, not that the app should have no opinion when it is missing. So a choice becomes
 * one more family at the head of the existing stack, and everything behind it still resolves.
 *
 * The stack itself stays in `app.css`, where it can be read next to the tokens that use it. This
 * module writes `--font-user-mono` and `--font-user-sans`, which `--font-mono` and `--font-sans`
 * name as their own first entry with the shipped stack as the `var()` fallback. Unset, the
 * declaration in the stylesheet is exactly the declaration that shipped — which is the difference
 * between a feature that is off and a feature that reimplements the default.
 */

/** The custom properties this module owns. `apply.ts` writes them; nothing else does. */
export const FONT_VARIABLES = { mono: "--font-user-mono", sans: "--font-user-sans" } as const;

/**
 * Offered in a datalist, not a select. These are the faces a developer machine is likely to
 * already have, and the list exists to save typing rather than to bound the answer: the field
 * takes free text, because someone who installed a font knows its name better than this list does.
 */
export const MONO_SUGGESTIONS = [
  "JetBrains Mono",
  "SF Mono",
  "Menlo",
  "Consolas",
  "Cascadia Code",
  "IBM Plex Mono",
  "Fira Code",
  "Source Code Pro",
  "Iosevka",
  "Hack",
] as const;

export const SANS_SUGGESTIONS = [
  "Inter",
  "SF Pro Text",
  "Segoe UI",
  "Roboto",
  "IBM Plex Sans",
  "Helvetica Neue",
  "Source Sans 3",
  "Public Sans",
] as const;

/** Anything that would end the value or the quoted string. A family name contains none of these. */
const UNSAFE = /["'\\;{}]/g;
/** The size is irrelevant to whether a family resolves; `check` needs a complete font shorthand. */
const PROBE_SIZE_PX = 12;

export function sanitiseFamily(family: string): string {
  return family.replace(UNSAFE, "").trim();
}

/**
 * The value for `--font-user-*`: the family, quoted, with a trailing comma so the fallback stack
 * reads as the next entry. `null` for no choice, which leaves the property unset and the
 * stylesheet's own declaration untouched.
 */
export function userFontValue(family: string | null): string | null {
  if (family === null) return null;
  const clean = sanitiseFamily(family);
  return clean === "" ? null : `"${clean}"`;
}

/**
 * Whether this machine can actually render the family.
 *
 * `document.fonts.check` and not `queryLocalFonts`: the latter is a permission prompt for the
 * whole font list, which is a fingerprinting surface and a dialog, to answer a question that is
 * really "does this one work". `check` answers exactly that, silently. It reports a fallback as a
 * miss, which is the honest answer for a field whose entire job is to warn about a typo.
 */
export function isFontAvailable(family: string): boolean {
  const clean = sanitiseFamily(family);
  if (clean === "") return false;
  try {
    return document.fonts.check(`${String(PROBE_SIZE_PX)}px "${clean}"`);
  } catch {
    // An unparseable shorthand throws rather than returning false. A name this rejects is a name
    // that would not have resolved anyway.
    return false;
  }
}
