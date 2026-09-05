import { failOnAmbiguity, type SelectionPort } from "@preman/core/api/select.js";
import { targetLabels, type RunTarget } from "@preman/core/workspace/collections.js";
import type { EnvironmentEntry } from "@preman/core/workspace/environments.js";

/** Prompting is only honest when a human is on both ends of the pipe. */
export function isInteractive(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

export const interactiveSelection: SelectionPort = {
  async pickRequest(candidates: RunTarget[], selector: string | undefined): Promise<RunTarget> {
    if (!isInteractive()) return failOnAmbiguity.pickRequest(candidates, selector);

    const { search } = await import("@inquirer/prompts");
    // Labelled once, up front, and as a set: a picker whose rows read identically is a coin
    // toss wearing a list. Pairing each label with its target here also keeps the filter and
    // the row showing the same string.
    const rows = targetLabels(candidates).map((name, index) => ({ name, value: candidates[index]! }));
    return search<RunTarget>({
      message: selector === undefined ? "Select a request" : `Select what to run matching "${selector}"`,
      source: (term) => {
        const needle = (term ?? "").toLowerCase();
        return rows.filter((row) => needle.length === 0 || row.name.toLowerCase().includes(needle));
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
