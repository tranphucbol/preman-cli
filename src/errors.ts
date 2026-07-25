/** Process exit codes, kept in one place so the CLI and tests agree. */
export const EXIT = {
  OK: 0,
  /** Bad CLI usage, missing workspace, unparseable request, unresolved variable... */
  CLI: 1,
  /** Transport-level failure: gRPC status != OK. */
  TRANSPORT: 2,
  /** Call succeeded but the payload reports a business failure (return_code != OK). */
  BUSINESS: 3,
  /** Call and payload were fine, but a `pm.test` assertion failed. */
  TEST: 4,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/** An error we caused on purpose and whose message is safe to show verbatim. */
export class CliError extends Error {
  readonly exitCode: ExitCode;
  /** Extra lines printed under the message, e.g. a list of available methods. */
  readonly details: string[];

  constructor(message: string, options: { exitCode?: ExitCode; details?: string[] } = {}) {
    super(message);
    this.name = "CliError";
    this.exitCode = options.exitCode ?? EXIT.CLI;
    this.details = options.details ?? [];
  }
}
