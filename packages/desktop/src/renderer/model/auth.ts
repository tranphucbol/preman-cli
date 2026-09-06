/**
 * Reading and writing a request's or a group's `auth:` block.
 *
 * Its own module rather than more of `model/request.ts` because a group document has this field
 * and none of the others: `groupDefinitionSchema` carries `auth`, `scripts` and `name`, so the
 * folder editor and the request editor share exactly this much.
 *
 * Two things here are copies of core, and both are deliberate. `AUTH_SCHEMES` is
 * `SUPPORTED_AUTH_TYPES`, and `inheritedAuth` is `resolveAuth`. The renderer may not import
 * `@preman/core` (see AGENTS.md) and neither of those is a type, so a copy is the most the fence
 * allows. `test/renderer/auth.test.ts` runs both originals against both copies over the fixture
 * workspaces, which is what stops them drifting.
 */

import type { CatalogNode, FieldEdit } from "@preman/desktop/engine/protocol.js";
import {
  declares,
  edit,
  readPairs,
  readPairsAt,
  readText,
  type Pair,
  type PairShape,
} from "@preman/desktop/renderer/model/request.js";

const AUTH_FIELD = "auth";
const TYPE_FIELD = "type";
const CREDENTIALS_FIELD = "credentials";
const AUTH_PATH = [AUTH_FIELD] as const;
const TYPE_PATH = [AUTH_FIELD, TYPE_FIELD] as const;
const CREDENTIALS_PATH = [AUTH_FIELD, CREDENTIALS_FIELD] as const;
const KEY_KEY = "key";
const VALUE_KEY = "value";
const IN_KEY = "in";
const EMPTY = "";
/** The field the authored headers live under, and the name core sends auth under. */
const HEADERS_FIELD = "headers";
const AUTH_HEADER = "Authorization";

/**
 * The auth types the engine can render, in the order the picker offers them.
 *
 * A copy of core's `SUPPORTED_AUTH_TYPES` (`packages/core/src/auth/credentials.ts`). Widening
 * that list means widening this one, `CREDENTIAL_FIELDS` and the pane's labels; the conformance
 * test is what will say so.
 */
export const AUTH_SCHEMES = ["noauth", "bearer", "basic", "apikey"] as const;
export type AuthScheme = (typeof AUTH_SCHEMES)[number];

const NO_AUTH: AuthScheme = "noauth";
const API_KEY: AuthScheme = "apikey";

/** `apikey`'s two targets. Core reads anything that is not `query` as a header. */
export const API_KEY_IN_HEADER = "header";
export const API_KEY_IN_QUERY = "query";

/**
 * What the picker offers, and what each option means in the file.
 *
 * `inherit` is the absence of the `auth:` key, not an empty one. That distinction is the whole
 * reason this union exists: `renderAuth` folds an empty `type` into `noauth` and returns
 * nothing, so an authored-but-empty block sends the request unauthenticated, while a missing
 * block is the only state `resolveAuth` walks the ancestor chain for.
 */
export type AuthChoice =
  | { readonly kind: "inherit" }
  | { readonly kind: "scheme"; readonly scheme: AuthScheme }
  /** A `type` core will refuse. Never a target; offered only because the file says it. */
  | { readonly kind: "unsupported"; readonly type: string };

export const INHERIT: AuthChoice = { kind: "inherit" };

/**
 * Postman's own labels for the four, so muscle memory lands on the right option - the same
 * argument the sub-tab list makes for its order.
 */
export const SCHEME_LABELS: Readonly<Record<AuthScheme, string>> = {
  noauth: "No Auth",
  bearer: "Bearer Token",
  basic: "Basic Auth",
  apikey: "API Key",
};

export const INHERIT_LABEL = "Inherit from parent";

/** The picker's sentinel for `inherit`. Not a scheme, so it cannot collide with one. */
export const INHERIT_VALUE = "inherit";

export interface CredentialField {
  /** The credential key core reads. */
  readonly key: string;
  readonly label: string;
  /** Present when the field is a fixed choice rather than free text. */
  readonly choices?: readonly { readonly value: string; readonly label: string }[];
  /** What core does with this field, when that is not obvious from its name. */
  readonly hint?: string;
}

/**
 * The credential keys each scheme reads, in the order the form shows them.
 *
 * Taken from `renderAuth`'s body, which is the only place they were written down. The pane can
 * name them because core names them; the previous version of this editor declined to, on the
 * grounds that it would be "pretending to know the shape of nine auth schemes" - but there are
 * four, and each reads two or three keys by name.
 */
export const CREDENTIAL_FIELDS: Readonly<Record<AuthScheme, readonly CredentialField[]>> = {
  noauth: [],
  bearer: [{ key: "token", label: "Token", hint: "An empty token sends the request unauthenticated." }],
  basic: [
    { key: "username", label: "Username" },
    { key: "password", label: "Password" },
  ],
  apikey: [
    { key: KEY_KEY, label: "Key", hint: "Also the header name, when this goes in a header." },
    { key: VALUE_KEY, label: "Value" },
    {
      key: IN_KEY,
      label: "Add to",
      choices: [
        { value: API_KEY_IN_HEADER, label: "Header" },
        { value: API_KEY_IN_QUERY, label: "Query params" },
      ],
    },
  ],
};

export interface AuthBlock {
  readonly choice: AuthChoice;
  /** The `type` exactly as authored, so rendering a value cannot rewrite it. */
  readonly type: string;
  readonly shape: PairShape;
  /** The credentials the current scheme names, in scheme order; an absent one is empty. */
  readonly named: readonly Pair[];
  /** Every other credential the block carries. Shown, never filtered, never dropped. */
  readonly extra: readonly Pair[];
}

function isScheme(type: string): type is AuthScheme {
  return (AUTH_SCHEMES as readonly string[]).includes(type);
}

function choiceFor(data: unknown): AuthChoice {
  if (!declares(data, AUTH_PATH)) return INHERIT;
  const type = readText(data, TYPE_PATH).trim().toLowerCase();
  // An empty type is `noauth` because that is what core makes of it, not because the two are
  // the same idea. Reporting it as its own state would give the picker a fifth option whose
  // only difference from No Auth is a spelling core has already collapsed.
  if (type === EMPTY) return { kind: "scheme", scheme: NO_AUTH };
  if (isScheme(type)) return { kind: "scheme", scheme: type };
  return { kind: "unsupported", type: readText(data, TYPE_PATH) };
}

export function readAuth(data: unknown): AuthBlock {
  const choice = choiceFor(data);
  const list = readPairsAt(data, CREDENTIALS_PATH);
  const fields = choice.kind === "scheme" ? CREDENTIAL_FIELDS[choice.scheme] : [];
  const modelled = new Set(fields.map((field) => field.key));

  const named = fields.map(
    (field) =>
      list.pairs.find((pair) => pair.key === field.key) ?? {
        key: field.key,
        value: EMPTY,
        disabled: false,
        at: field.key,
      },
  );

  return {
    choice,
    type: readText(data, TYPE_PATH),
    shape: list.shape,
    named,
    extra: list.pairs.filter((pair) => !modelled.has(pair.key)),
  };
}

/** One named credential's value, or `""` when the block does not carry it. */
export function credentialValue(block: AuthBlock, key: string): string {
  return block.named.find((pair) => pair.key === key)?.value ?? EMPTY;
}

/**
 * Whether choosing `inherit` would lose anything.
 *
 * The pane confirms only when it would: deleting an `auth:` block that holds nothing but a type
 * is not a loss, and a dialog in front of it would be a dialog the user learns to dismiss.
 */
export function hasCredentials(block: AuthBlock): boolean {
  return [...block.named, ...block.extra].some((pair) => pair.value !== EMPTY);
}

/**
 * Change what the block is.
 *
 * `inherit` deletes the whole block, because the absence of the key is the only way the format
 * expresses it - the caller confirms first. A scheme change writes only `type`: a `bearer` block
 * turned `basic` keeps its `token`, which the pane then shows under its other-credentials
 * heading. Dropping the keys the new scheme does not read would lose a token to a mis-click, and
 * core ignores what it does not read.
 */
export function editAuthChoice(next: AuthChoice): readonly FieldEdit[] {
  if (next.kind === "inherit") return [edit(AUTH_PATH, undefined)];
  if (next.kind === "scheme") return [edit(TYPE_PATH, next.scheme)];
  // Re-selecting the value the file already holds. Writing it back would mark the tab dirty for
  // having been looked at, which is the rule `RequestEditor`'s `commit` follows for every field.
  return [];
}

/** Carry an array entry's unmodelled keys through a rewrite; only `key` and `value` are ours. */
function asCredential(pair: Pair): Record<string, unknown> {
  const carried: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(pair.source ?? {})) {
    if (name !== KEY_KEY && name !== VALUE_KEY) carried[name] = value;
  }
  return { ...carried, [KEY_KEY]: pair.key, [VALUE_KEY]: pair.value };
}

/**
 * Set one credential, in whichever shape the block already has.
 *
 * A block the file does not have yet is created as a **map**, which is where this parts company
 * with `editPairValue`: that one treats an absent field as an array because the pair-list
 * schemas declare arrays, whereas `authCredentialsSchema` declares both. With the choice free,
 * `token: "{{jwt}}"` is one line and diffs cleanly where the array form is four.
 *
 * Writing an array back as an array is not a preference, it is the correctness of this module:
 * `project`'s `write` replaces a non-record target with `{}`, so a map-shaped edit against
 * array-shaped credentials would discard every other credential in the block.
 */
export function editCredential(block: AuthBlock, key: string, value: string): readonly FieldEdit[] {
  if (block.shape === "map") return [edit([...CREDENTIALS_PATH, key], value)];
  if (block.shape === "absent") return [edit(CREDENTIALS_PATH, { [key]: value })];

  const existing = [...block.named, ...block.extra].find((pair) => pair.key === key && typeof pair.at === "number");
  if (existing !== undefined) return [edit([...CREDENTIALS_PATH, existing.at, VALUE_KEY], value)];

  const entries = [...block.extra, ...block.named.filter((pair) => typeof pair.at === "number")]
    .sort((left, right) => Number(left.at) - Number(right.at))
    .map(asCredential);
  return [edit(CREDENTIALS_PATH, [...entries, { [KEY_KEY]: key, [VALUE_KEY]: value }])];
}

export function editCredentialRemoved(block: AuthBlock, pair: Pair): readonly FieldEdit[] {
  if (block.shape === "map") return [edit([...CREDENTIALS_PATH, pair.key], undefined)];
  if (block.shape === "absent") return [];
  const entries = [...block.extra, ...block.named.filter((candidate) => typeof candidate.at === "number")]
    .filter((candidate) => candidate.at !== pair.at)
    .sort((left, right) => Number(left.at) - Number(right.at))
    .map(asCredential);
  return [edit(CREDENTIALS_PATH, entries)];
}

export interface AuthOrigin {
  readonly nodeId: string;
  readonly name: string;
  readonly kind: CatalogNode["kind"];
  /** The declared type, lowercased, as `CatalogNode.auth` carries it. */
  readonly type: string;
  /** `` `${kind} ${name}` ``, the string core's `originOf` produces for the same node. */
  readonly label: string;
}

/**
 * The nearest ancestor that declares an `auth:` block.
 *
 * A copy of core's `resolveAuth` walk, resolved here rather than asked of the engine: the
 * catalog already carries every node's declared type, so the answer is four lines over a list
 * the sidebar is holding anyway. Nearest-first, which is the direction `resolveAuth` walks.
 */
export function inheritedAuth(ancestors: readonly CatalogNode[]): AuthOrigin | null {
  for (let index = ancestors.length - 1; index >= 0; index -= 1) {
    const node = ancestors[index]!;
    if (node.auth === undefined) continue;
    return { nodeId: node.id, name: node.name, kind: node.kind, type: node.auth, label: `${node.kind} ${node.name}` };
  }
  return null;
}

/** How a resolved scheme is read out loud, wherever one is shown rather than chosen. */
export function schemeLabel(type: string): string {
  const normalised = type.trim().toLowerCase();
  return isScheme(normalised) ? SCHEME_LABELS[normalised] : type;
}

export interface AuthOverride {
  /** The header the auth block will send, spelt the way core spells it. */
  readonly name: string;
  /** The authored values it replaces, in authored order. Never empty. */
  readonly displaced: readonly string[];
  /** The scheme doing the replacing, lowercased. */
  readonly type: string;
  /** The ancestor the block came from, or `null` when the document declares its own. */
  readonly origin: AuthOrigin | null;
}

/**
 * The header this document authors that its own auth block is about to replace.
 *
 * `applyAuth` deletes a colliding header and sends the block's value instead, which is what
 * Postman does and what preman now does - but the grid shows the authored value with nothing to
 * say it will never leave the machine. Postman answers this on the Headers tab, marking the entry
 * that loses, so this is read there too rather than on the Auth tab.
 *
 * `null` for every case with nothing to warn about, including the two it cannot answer: an
 * `apikey` block bound for the query string collides with a param and not a header, and an
 * inherited `apikey`'s header name is its `key` credential, which the catalog does not carry
 * (ADR 049 - the catalog broadcasts the type alone).
 */
export function authOverride(data: unknown, ancestors: readonly CatalogNode[]): AuthOverride | null {
  const block = readAuth(data);
  const inherited = block.choice.kind === "inherit";
  const origin = inherited ? inheritedAuth(ancestors) : null;
  if (inherited && origin === null) return null;

  const type = origin === null ? block.type.trim().toLowerCase() : origin.type;
  if (!isScheme(type) || type === NO_AUTH) return null;

  const name = authHeaderName(type, origin === null ? block : null);
  if (name === null) return null;

  const wanted = name.toLowerCase();
  const displaced = readPairs(data, HEADERS_FIELD)
    .pairs.filter((pair) => !pair.disabled && pair.key.trim().toLowerCase() === wanted)
    .map((pair) => pair.value);
  if (displaced.length === 0) return null;

  return { name, displaced, type, origin };
}

/**
 * Which header a scheme lands in, or `null` when it lands in none this pane can name.
 *
 * `block` is `null` for an inherited one, whose credentials are not on hand: `bearer` and `basic`
 * are still knowable because the header is fixed, and `apikey` is not.
 */
function authHeaderName(scheme: AuthScheme, block: AuthBlock | null): string | null {
  if (scheme !== API_KEY) return AUTH_HEADER;
  if (block === null) return null;
  // An absent `in` is a header, matching what core makes of anything that is not `query`.
  if (credentialValue(block, IN_KEY).trim().toLowerCase() === API_KEY_IN_QUERY) return null;
  const key = credentialValue(block, KEY_KEY).trim();
  return key.length === 0 ? null : key;
}
