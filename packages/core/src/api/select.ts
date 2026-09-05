import { PremanError } from "@preman/core/errors.js";
import { targetLabels, type RunTarget } from "@preman/core/workspace/collections.js";
import type { EnvironmentEntry } from "@preman/core/workspace/environments.js";

/**
 * Consulted only where the engine has more than one legitimate answer. Every
 * deterministic branch stays in the engine, so a port can never widen or narrow
 * what counts as a candidate.
 */
export interface SelectionPort {
  pickRequest(candidates: RunTarget[], selector: string | undefined): Promise<RunTarget>;
  pickEnvironment(candidates: EnvironmentEntry[]): Promise<EnvironmentEntry>;
}

/**
 * The default: refuse to guess and list the candidates. This is what the CLI has
 * always done when it is not attached to a terminal.
 */
export const failOnAmbiguity: SelectionPort = {
  pickRequest(candidates: RunTarget[], selector: string | undefined): Promise<RunTarget> {
    const heading = selector === undefined ? "several requests exist; name one" : `"${selector}" is ambiguous`;
    return Promise.reject(
      new PremanError(heading, {
        // Labelled as a set, not one by one: two candidates that read the same tell the reader
        // nothing about which is which and leave them with nothing to type.
        details: ["candidates:", ...targetLabels(candidates).map((label) => `  ${label}`)],
      }),
    );
  },

  pickEnvironment(candidates: EnvironmentEntry[]): Promise<EnvironmentEntry> {
    return Promise.reject(
      new PremanError("multiple environments exist; pass -e <NAME>", {
        details: ["available:", ...candidates.map((environment) => `  ${environment.name}`)],
      }),
    );
  },
};
