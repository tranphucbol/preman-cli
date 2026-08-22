import { failOnAmbiguity, type SelectionPort } from "@preman/core/api/select.js";
import { targetLabel, type RunTarget } from "@preman/core/workspace/collections.js";
import type { EnvironmentEntry } from "@preman/core/workspace/environments.js";

/** Prompting is only honest when a human is on both ends of the pipe. */
export function isInteractive(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

export const interactiveSelection: SelectionPort = {
  async pickRequest(candidates: RunTarget[], selector: string | undefined): Promise<RunTarget> {
    if (!isInteractive()) return failOnAmbiguity.pickRequest(candidates, selector);

    const { search } = await import("@inquirer/prompts");
    return search<RunTarget>({
      message: selector === undefined ? "Select a request" : `Select what to run matching "${selector}"`,
      source: (term) => {
        const needle = (term ?? "").toLowerCase();
        return candidates
          .filter((t) => needle.length === 0 || targetLabel(t).toLowerCase().includes(needle))
          .map((t) => ({ name: targetLabel(t), value: t }));
      },
    });
  },

  async pickEnvironment(candidates: EnvironmentEntry[]): Promise<EnvironmentEntry> {
    if (!isInteractive()) return failOnAmbiguity.pickEnvironment(candidates);

    const { select } = await import("@inquirer/prompts");
    return select<EnvironmentEntry>({
      message: "Select an environment",
      choices: candidates.map((e) => ({ name: e.name, value: e })),
    });
  },
};
