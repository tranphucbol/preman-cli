/**
 * What copying a request as a command would produce, as a value.
 *
 * The mirror of `import/plan.ts`. The plan touches no disk and no socket (decision 5), so
 * `preman copy` and the desktop's `CommandPane` are the same value rendered twice rather than a
 * second code path — and `words` is the argv while `command` is only `quoteWords(words)`, so a
 * quoting bug and a semantics bug fail as separate tests (decision 12).
 *
 * Core says `command`; the front ends say *copy*. The engine may not know what is in front of
 * it, and a core type named after a clipboard would break that fence (decision 2).
 */
import type { RequestKind } from "@preman/core/api/mutate.js";
import type { CommandFormat } from "@preman/core/command/format.js";
import type { Scope } from "@preman/core/vars/store.js";

/**
 * A request field or run option the command has no way to carry.
 *
 * Named, never counted and never silent (decision 15): a pre-request script that signs a header
 * is the difference between a command that works and a 401 nothing on screen explains.
 */
export interface Unexpressed {
  /** The request field or option, in the words the editor uses for it. */
  readonly field: string;
  /** One clause saying why, and where the capability lives instead. */
  readonly reason: string;
}

/** The scope of a credential no variable produced — the auth block rendered it (decision 17). */
export const AUTH_SCOPE = "auth";

/**
 * A variable whose value is now in the command, in cleartext.
 *
 * This does **not** claim the value is a secret. Core has no secret, sensitive or redaction
 * concept — `VariableStore.get` returns `string | undefined` with no provenance and no flag —
 * so inventing one here would be a guess. `revealed` names what was substituted and where it
 * came from, and leaves the judgement to the reader (decision 16).
 */
export interface Revealed {
  readonly name: string;
  /** The scope that answered, or {@link AUTH_SCOPE} for a credential no variable produced. */
  readonly scope: Scope | typeof AUTH_SCOPE;
  /** Where an inherited credential came from; `ResolvedAuth.origin.label`. */
  readonly origin?: string;
}

export interface CommandPlan {
  readonly format: CommandFormat;
  readonly kind: RequestKind;
  /** The argv. Asserted by the tests; `command` is derived from it. */
  readonly words: readonly string[];
  /** `quoteWords(words)`. What lands on the clipboard. */
  readonly command: string;
  readonly unexpressed: readonly Unexpressed[];
  readonly revealed: readonly Revealed[];
  /** Advice a person should read before pasting the command; never a reason to refuse. */
  readonly warnings: readonly string[];
}

/**
 * Certificate material as a command can name it: paths, not bytes.
 *
 * `TlsCertOptions` holds the file contents because that is what the transports dial with. A
 * command line holds the path instead, which is why `TlsCertOptions.paths` exists.
 */
export interface CommandCerts {
  readonly extraCaCerts?: string | undefined;
  readonly clientCert?: string | undefined;
  readonly clientKey?: string | undefined;
  readonly insecure: boolean;
  /**
   * Whether a client-key passphrase was supplied. The value itself is never rendered: curl
   * takes it as `--cert <path>:<passphrase>`, and writing a passphrase into a string destined
   * for a chat window is the one thing this feature must not do quietly (decision 33).
   */
  readonly passphrase: boolean;
}

export const NO_CERTS: CommandCerts = { insecure: false, passphrase: false };
